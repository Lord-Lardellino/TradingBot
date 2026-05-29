import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { LiveTradingService } from '../live/live-trading.service';
import { PrismaService } from '../prisma/prisma.service';

const SOURCE = 'MTF_SCALPER';
const TF_5M = '5m';
const TF_30M = '30m';
const CANDLE_5M_MS = 5 * 60_000;
const CANDLE_30M_MS = 30 * 60_000;
const CANDLES_5M = 400;
const CANDLES_30M = 250;
const SCAN_BATCH_SIZE = 4;
const BATCH_DELAY_MS = 200;
const FETCH_RETRIES = 4;

type Direction = 'LONG' | 'SHORT';
type Grade = 'A+' | 'A' | 'B';

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; }

export interface MtfScalperSignal {
  id: string;
  symbol: string;
  direction: Direction;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  slPct: number;
  tpPct: number;
  suggestedLeverage: number;
  riskUsdt: number;
  rewardUsdt: number;
  positionSize: number;
  marginUsdt: number;
  spreadPct: number;
  volume24h: number;
  volumeRatio: number;
  bodyRangeRatio: number;
  closeWickRange: number;
  rangeAtr: number;
  ema9: number;
  ema21: number;
  ema200_5m: number;
  ema200_30m: number;
  rsi7: number;
  feeRate: number;
  isZeroFee: boolean;
  score: number;
  grade: Grade;
  reasons: string[];
  timestamp: string;
  triggerTs: number;
  candleCloseAgeMs: number;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
}

@Injectable()
export class MtfScalperService implements OnModuleInit {
  private readonly logger = new Logger(MtfScalperService.name);
  private exchange: ccxt.mexc;
  private fastExchange: ccxt.mexc;
  private validSymbols = new Set<string>();
  private tickerCache: Record<string, any> = {};
  private recentSignals: MtfScalperSignal[] = [];
  private cooldowns = new Map<string, number>();
  private emittedIds = new Set<string>();
  private isScanning = false;
  private lastScanAt: string | null = null;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private scannedPairs = 0;
  private lastError: string | null = null;
  private debug: Record<string, number> = {};
  private feeBySymbol = new Map<string, number>();
  private zeroFeeSymbols = new Set<string>();

  constructor(
    private config: ConfigService,
    private events: EventsGateway,
    private liveTrading: LiveTradingService,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    this.fastExchange = new ccxt.mexc({
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await this.loadMarkets();
    await this.loadContractFees();
    await this.ensureConfig();
    this.logger.log(`[MTF_SCALPER] attivo — EMA9/21/200(5m) + EMA200(30m) HTF bias`);
  }

  @Cron('30 0 * * * *')
  async loadContractFees() {
    try {
      const res = await fetch('https://contract.mexc.com/api/v1/contract/detail');
      const json = await res.json();
      if (!json?.success || !Array.isArray(json.data)) throw new Error('contract/detail invalid');
      const fees = new Map<string, number>();
      for (const row of json.data) {
        const sym = String(row.symbol ?? '');
        if (!sym.endsWith('_USDT')) continue;
        const symbol = sym.replace('_USDT', '/USDT:USDT');
        // API orders excluded from MEXC zero-fee promotions (policy since May 2026)
        fees.set(symbol, Math.max(Number(row.takerFeeRate ?? 0), 0.0006));
      }
      this.feeBySymbol = fees;
      this.zeroFeeSymbols = new Set();
      this.logger.log(`[MTF_SCALPER] fee table: ${fees.size} total (API taker floor 0.06%)`);
    } catch (err: any) {
      this.bump('fee_table_err');
      this.logger.warn(`[MTF_SCALPER] fee table err: ${err?.message}`);
    }
  }

  @Cron('0 0 * * * *')
  async loadMarkets() {
    try {
      const markets = await this.exchange.loadMarkets(true);
      this.fastExchange.markets = this.exchange.markets;
      this.fastExchange.markets_by_id = this.exchange.markets_by_id;
      this.fastExchange.currencies = this.exchange.currencies;
      this.fastExchange.currencies_by_id = this.exchange.currencies_by_id;
      this.validSymbols = new Set(Object.keys(markets).filter(s => s.endsWith('/USDT:USDT')));
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      this.logger.error(`[MTF_SCALPER] loadMarkets: ${this.lastError}`);
    }
  }

  @Interval(30_000)
  async refreshTickerCache() {
    if (!this.validSymbols.size) return;
    try {
      this.tickerCache = await this.exchange.fetchTickers([...this.validSymbols]);
    } catch {
      this.bump('ticker_cache_err');
    }
  }

  @Cron('4 0,5,10,15,20,25,30,35,40,45,50,55 * * * *')
  async scan() {
    if (this.isScanning || !this.validSymbols.size) return;
    this.isScanning = true;
    this.debug = {};
    this.lastError = null;

    try {
      const cfg = await this.ensureConfig();
      if (!cfg.enabled) {
        this.lastScanAt = new Date().toISOString();
        this.lastRawSignals = 0;
        this.lastEmitted = 0;
        this.emitStatus();
        return;
      }

      const tickers = Object.keys(this.tickerCache).length
        ? this.tickerCache
        : await this.exchange.fetchTickers([...this.validSymbols]);

      const openSymbols = await this.getOpenSymbolsSet();
      const topPairs = Math.max(20, Math.min(200, cfg.topPairs));

      const candidates = Object.values(tickers)
        .filter((t: any) =>
          this.validSymbols.has(t.symbol) &&
          Number(t.quoteVolume ?? t.info?.amount24 ?? 0) >= cfg.minVolume24h &&
          !openSymbols.has(t.symbol) &&
          this.spreadPct(t) <= cfg.maxSpreadPct,
        )
        .sort((a: any, b: any) => Number(b.quoteVolume ?? b.info?.amount24 ?? 0) - Number(a.quoteVolume ?? a.info?.amount24 ?? 0))
        .slice(0, topPairs);

      this.scannedPairs = candidates.length;
      const rawSignals: MtfScalperSignal[] = [];

      for (let i = 0; i < candidates.length; i += SCAN_BATCH_SIZE) {
        const batch = candidates.slice(i, i + SCAN_BATCH_SIZE);
        const results = await Promise.all(batch.map(async (ticker: any) => {
          const [raw5m, raw30m] = await Promise.all([
            this.fetchOHLCVWithRetry(ticker.symbol, 'fetch_5m_err', TF_5M, CANDLES_5M),
            this.fetchOHLCVWithRetry(ticker.symbol, 'fetch_30m_err', TF_30M, CANDLES_30M),
          ]);
          if (!raw5m || !raw30m) return null;
          return this.analyzePair(ticker, raw5m, raw30m, cfg);
        }));
        results.forEach(sig => sig && rawSignals.push(sig));
        if (i + SCAN_BATCH_SIZE < candidates.length) await this.sleep(BATCH_DELAY_MS);
      }

      this.lastRawSignals = rawSignals.length;
      const now = Date.now();
      const cooldownMs = Math.max(1, cfg.cooldownMinutes) * 60_000;
      const maxSignals = Math.max(1, Math.min(20, cfg.maxSignalsPerScan));
      const selected = rawSignals
        .filter(sig => !this.emittedIds.has(sig.id))
        .filter(sig => now - (this.cooldowns.get(sig.symbol) ?? 0) >= cooldownMs)
        .sort((a, b) =>
          b.score - a.score ||
          Number(a.feeRate) - Number(b.feeRate) ||
          a.spreadPct - b.spreadPct,
        )
        .slice(0, maxSignals);

      const openCount = await this.prisma.mtfScalperSimulatedTrade.count({ where: { status: 'open' } });
      let slots = Math.max(0, cfg.maxConcurrent - openCount);
      let emitted = 0;

      for (const sig of selected) {
        this.emittedIds.add(sig.id);
        this.cooldowns.set(sig.symbol, Date.now());
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 250) this.recentSignals.pop();
        this.events.emitMtfScalperSignal(sig);

        if (slots > 0 && cfg.autoEnter) {
          await this.enterSimTrade(sig, cfg);
          slots--;
        }

        if (cfg.liveEnabled) {
          await this.liveTrading.enterTrade({
            symbol: sig.symbol,
            direction: sig.direction,
            grade: sig.grade,
            entry: sig.entry,
            slPct: sig.slPct,
            tp1Pct: sig.tpPct,
            suggestedLeverage: sig.suggestedLeverage,
            score: sig.score,
            stopLossPrice: sig.stopLoss,
            takeProfitPrice: sig.takeProfit1,
            riskUsdt: cfg.riskUsdt,
            feeRate: sig.feeRate,
            source: SOURCE,
            sourceMaxConcurrent: cfg.maxConcurrent,
            bypassGlobalConfig: true,
          }).catch(err => this.logger.error(`[MTF_SCALPER LIVE] ${sig.symbol}: ${err?.message}`));
        }
        emitted++;
      }

      this.lastEmitted = emitted;
      this.lastScanAt = new Date().toISOString();
      this.emitStatus();
      this.logger.log(`[MTF_SCALPER] scanned=${this.scannedPairs} raw=${rawSignals.length} emitted=${emitted}`);
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      this.bump('scan_err');
      this.logger.error(`[MTF_SCALPER] scan: ${this.lastError}`);
      this.emitStatus();
    } finally {
      this.isScanning = false;
    }
  }

  @Cron('*/10 * * * * *')
  async checkOpenTrades() {
    const open = await this.prisma.mtfScalperSimulatedTrade.findMany({ where: { status: 'open' } });
    if (!open.length) return;
    for (const trade of open) {
      try {
        const raw = await this.fetchOHLCVWithRetry(trade.symbol, 'check_fetch_err', '1m', 3);
        if (!raw?.length) continue;
        const last = this.toCandles(raw).at(-1);
        if (!last) continue;
        const isLong = trade.direction === 'LONG';
        const hitSL = isLong ? last.l <= trade.stopLoss : last.h >= trade.stopLoss;
        const hitTP = isLong ? last.h >= trade.takeProfit1 : last.l <= trade.takeProfit1;
        if (hitSL || hitTP) {
          await this.closeSimTrade(trade, hitSL ? trade.stopLoss : trade.takeProfit1, hitSL ? 'sl' : 'tp1');
          continue;
        }
        const priceDiff = isLong ? (last.c - trade.entry) / trade.entry : (trade.entry - last.c) / trade.entry;
        this.events.emitMtfScalperPositions([{
          id: trade.id,
          currentPrice: Number(last.c.toPrecision(8)),
          unrealizedPnl: Number((trade.positionSize * priceDiff - trade.fees).toFixed(4)),
          unrealizedPnlPct: Number((priceDiff * 100).toFixed(3)),
        }]);
      } catch { this.bump('check_err'); }
    }
  }

  private analyzePair(ticker: any, raw5m: ccxt.OHLCV[], raw30m: ccxt.OHLCV[], cfg: any): MtfScalperSignal | null {
    const c5 = this.toCandles(raw5m);
    const c30 = this.toCandles(raw30m);

    // HTF bias via 30m EMA200
    const htf = this.lastClosedTFIndex(c30, CANDLE_30M_MS);
    if (!htf || htf.i < 5) return this.reject('htf_data');
    const ema200_30m = this.ema(c30, htf.i, 200);
    const price = Number(ticker.last ?? ticker.close ?? c5.at(-1)?.c ?? 0);
    if (price <= 0 || ema200_30m <= 0) return this.reject('htf_price');
    const isLong = price > ema200_30m;
    this.bump('htf_ok');

    // 5m trigger candle
    const cl = this.lastClosedTFIndex(c5, CANDLE_5M_MS);
    if (!cl || cl.i < 40) return this.reject('data');
    const i = cl.i;
    const trigger = c5[i];
    const direction: Direction = isLong ? 'LONG' : 'SHORT';

    const candleOk = isLong ? trigger.c > trigger.o : trigger.c < trigger.o;
    if (!candleOk) return this.reject('contra_htf');

    const range = trigger.h - trigger.l;
    const body = Math.abs(trigger.c - trigger.o);
    if (range <= 0 || body <= 0) return this.reject('empty');

    const closeWick = isLong ? trigger.h - trigger.c : trigger.c - trigger.l;
    const bodyRatio = body / range;
    const closeWickRatio = closeWick / range;

    if (bodyRatio < cfg.minBodyRatio) return this.reject('body');
    if (closeWickRatio > cfg.maxCloseWick) return this.reject('close_wick');

    const atr = this.atr(c5, i, 14);
    if (!atr || atr <= 0) return this.reject('atr');
    const rangeAtr = range / atr;
    if (rangeAtr < cfg.minRangeAtr) return this.reject('range_atr');
    if (rangeAtr > cfg.maxRangeAtr) return this.reject('range_atr_big');

    // EMA alignment on 5m
    const ema9 = this.ema(c5, i, 9);
    const ema21 = this.ema(c5, i, 21);
    const ema200_5m = this.ema(c5, i, 200);
    if (!ema9 || !ema21 || !ema200_5m) return this.reject('ema');

    const emaAligned = isLong
      ? ema9 > ema21 && ema21 > ema200_5m
      : ema9 < ema21 && ema21 < ema200_5m;
    if (!emaAligned) return this.reject('ema_align');
    this.bump('ema_ok');

    // Pullback to EMA9: trigger or recent candles touched EMA9 zone
    const ema9Touch = isLong
      ? trigger.l <= ema9 + atr * 0.4
      : trigger.h >= ema9 - atr * 0.4;
    const recentTouch = isLong
      ? c5.slice(Math.max(0, i - 3), i).some(c => c.l <= ema9 + atr * 0.5)
      : c5.slice(Math.max(0, i - 3), i).some(c => c.h >= ema9 - atr * 0.5);
    if (!ema9Touch && !recentTouch) return this.reject('no_touch');
    this.bump('touch_ok');

    // Trigger must close on correct side of EMA9
    if (isLong ? trigger.c <= ema9 : trigger.c >= ema9) return this.reject('no_ema9_close');

    // Not overextended from EMA9
    const ema9Dist = Math.abs(trigger.c - ema9) / atr;
    if (ema9Dist > 1.8) return this.reject('overextended');

    // RSI(7)
    const rsi = this.rsi(c5, i, 7);
    const rsiOk = isLong ? rsi > 45 && rsi < 80 : rsi < 55 && rsi > 20;
    if (!rsiOk) return this.reject('rsi');
    this.bump('rsi_ok');

    const volRatio = this.volumeRatio(c5, i, 20);
    const feeRate = this.feeRateForSymbol(ticker.symbol, cfg.feeRate);
    const spread = this.spreadPct(ticker);

    // SL/TP
    const entry = trigger.c;
    const stopLoss = isLong ? trigger.l : trigger.h;
    if (isLong && stopLoss >= entry) return this.reject('sl_side');
    if (!isLong && stopLoss <= entry) return this.reject('sl_side');

    const riskDist = Math.abs(entry - stopLoss);
    const slPct = riskDist / entry * 100;
    if (slPct < cfg.minSlPct) return this.reject('sl_small');
    if (slPct > cfg.maxSlPct) return this.reject('sl_big');

    const emaSpread = Math.abs(ema9 - ema21) / entry;
    const rsiNorm = Math.max(0, Math.min(1, isLong ? (rsi - 45) / 35 : (55 - rsi) / 35));

    const score = this.computeScore({
      bodyRatio, closeWickRatio, rangeAtr,
      volumeRatio: volRatio,
      rsiNorm,
      ema9DistNorm: ema9Dist,
      emaSpread,
      isZeroFee: feeRate === 0,
      slPct,
    });
    if (score < cfg.minScore) return this.reject('score');
    this.bump('score_ok');

    const takeProfit = isLong ? entry + riskDist * cfg.tpRr : entry - riskDist * cfg.tpRr;
    const tpPct = slPct * cfg.tpRr;
    const positionSize = cfg.riskUsdt / (slPct / 100);
    const leverage = Math.min(Number(cfg.leverage), 125);
    const grade: Grade = score >= 88 ? 'A+' : score >= 75 ? 'A' : 'B';

    return {
      id: `${SOURCE}_${ticker.symbol}_${trigger.t}`,
      symbol: ticker.symbol,
      direction,
      entry: this.price(entry),
      stopLoss: this.price(stopLoss),
      takeProfit1: this.price(takeProfit),
      slPct: Number(slPct.toFixed(4)),
      tpPct: Number(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt: Number(cfg.riskUsdt.toFixed(2)),
      rewardUsdt: Number((cfg.riskUsdt * cfg.tpRr).toFixed(2)),
      positionSize: Number(positionSize.toFixed(4)),
      marginUsdt: Number((positionSize / leverage).toFixed(4)),
      spreadPct: Number(spread.toFixed(4)),
      volume24h: Number(Number(ticker.quoteVolume ?? ticker.info?.amount24 ?? 0).toFixed(2)),
      volumeRatio: Number(volRatio.toFixed(2)),
      bodyRangeRatio: Number(bodyRatio.toFixed(3)),
      closeWickRange: Number(closeWickRatio.toFixed(3)),
      rangeAtr: Number(rangeAtr.toFixed(3)),
      ema9: this.price(ema9),
      ema21: this.price(ema21),
      ema200_5m: this.price(ema200_5m),
      ema200_30m: this.price(ema200_30m),
      rsi7: Number(rsi.toFixed(1)),
      feeRate,
      isZeroFee: feeRate === 0,
      score,
      grade,
      reasons: [
        isLong ? '30m HTF bullish (price > EMA200)' : '30m HTF bearish (price < EMA200)',
        isLong ? 'EMA9 > EMA21 > EMA200 (5m)' : 'EMA9 < EMA21 < EMA200 (5m)',
        ema9Touch ? 'pullback diretto a EMA9' : 'pullback recente a EMA9 (−3 candele)',
        `body ${(bodyRatio * 100).toFixed(0)}%`,
        `close wick ${(closeWickRatio * 100).toFixed(1)}%`,
        `ATR ×${rangeAtr.toFixed(2)}`,
        `RSI(7) ${rsi.toFixed(0)}`,
        feeRate === 0 ? '0 fee' : `fee ${(feeRate * 100).toFixed(3)}%`,
        `RR ${cfg.tpRr.toFixed(1)}R`,
      ],
      timestamp: new Date(trigger.t).toISOString(),
      triggerTs: trigger.t,
      candleCloseAgeMs: cl.closeAgeMs,
      mexcUrl: `https://futures.mexc.com/exchange/${ticker.symbol.replace('/USDT:USDT', '_USDT')}`,
      sparkline: c5.slice(Math.max(0, i - 50), i + 1).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    };
  }

  private computeScore(x: {
    bodyRatio: number;
    closeWickRatio: number;
    rangeAtr: number;
    volumeRatio: number;
    rsiNorm: number;
    ema9DistNorm: number;
    emaSpread: number;
    isZeroFee: boolean;
    slPct: number;
  }): number {
    let pts = 0;
    pts += x.bodyRatio >= 0.85 ? 18 : x.bodyRatio >= 0.65 ? 14 : x.bodyRatio >= 0.45 ? 10 : 6;
    pts += x.closeWickRatio <= 0.02 ? 18 : x.closeWickRatio <= 0.08 ? 14 : x.closeWickRatio <= 0.18 ? 9 : 5;
    pts += (x.rangeAtr >= 0.75 && x.rangeAtr <= 1.50) ? 13 : x.rangeAtr >= 0.50 ? 9 : 6;
    pts += x.rsiNorm >= 0.8 ? 12 : x.rsiNorm >= 0.5 ? 8 : 4;
    pts += x.ema9DistNorm <= 0.10 ? 13 : x.ema9DistNorm <= 0.40 ? 9 : x.ema9DistNorm <= 0.80 ? 6 : 3;
    pts += x.emaSpread >= 0.003 ? 10 : x.emaSpread >= 0.001 ? 7 : 4;
    pts += x.volumeRatio >= 1.5 ? 8 : x.volumeRatio >= 1.0 ? 5 : 2;
    if (x.isZeroFee) pts += 4;
    pts += (x.slPct >= 0.20 && x.slPct <= 0.65) ? 4 : 2;
    return Math.min(100, pts);
  }

  private async enterSimTrade(sig: MtfScalperSignal, cfg: any) {
    const [sameId, already] = await Promise.all([
      this.prisma.mtfScalperSimulatedTrade.findUnique({ where: { id: sig.id } }),
      this.prisma.mtfScalperSimulatedTrade.findFirst({ where: { symbol: sig.symbol, status: 'open' } }),
    ]);
    if (sameId || already) return;
    const capital = await this.currentCapital(cfg);
    const fees = sig.positionSize * sig.feeRate;
    const trade = await this.prisma.mtfScalperSimulatedTrade.create({
      data: {
        id: sig.id,
        symbol: sig.symbol,
        direction: sig.direction,
        entry: sig.entry,
        stopLoss: sig.stopLoss,
        takeProfit1: sig.takeProfit1,
        leverage: sig.suggestedLeverage,
        riskEur: cfg.riskUsdt,
        positionSize: sig.positionSize,
        marginEur: sig.marginUsdt,
        grade: sig.grade,
        score: sig.score,
        feeRate: sig.feeRate,
        fees: Number(fees.toFixed(6)),
        capitalBefore: Number(capital.toFixed(4)),
      },
    });
    this.events.emitMtfScalperTrade(trade);
  }

  private async closeSimTrade(trade: any, closePrice: number, status: string) {
    const isLong = trade.direction === 'LONG';
    const priceDiff = isLong
      ? (closePrice - trade.entry) / trade.entry
      : (trade.entry - closePrice) / trade.entry;
    const exitFee = trade.positionSize * Number(trade.feeRate ?? 0.00038);
    const totalFees = (trade.fees ?? 0) + exitFee;
    const pnl = trade.positionSize * priceDiff - totalFees;
    const updated = await this.prisma.mtfScalperSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status,
        closePrice: this.price(closePrice),
        pnl: Number(pnl.toFixed(4)),
        fees: Number(totalFees.toFixed(6)),
        capitalAfter: Number((trade.capitalBefore + pnl).toFixed(4)),
        closedAt: new Date(),
      },
    });
    this.events.emitMtfScalperTrade(updated);
  }

  private async ensureConfig() {
    const cfg = await this.prisma.mtfScalperConfig.findUnique({ where: { id: 1 } });
    if (cfg) return cfg;
    return this.prisma.mtfScalperConfig.create({ data: { id: 1 } });
  }

  private async currentCapital(cfg: any) {
    const closed = await this.prisma.mtfScalperSimulatedTrade.findMany({ where: { status: { not: 'open' } } });
    return closed.reduce((cap, t) => cap + (t.pnl ?? 0), cfg.startingCapital);
  }

  private async getOpenSymbolsSet() {
    const [sim, live] = await Promise.all([
      this.prisma.mtfScalperSimulatedTrade.findMany({ where: { status: 'open' }, select: { symbol: true } }),
      this.prisma.liveTrade.findMany({ where: { status: { in: ['open', 'pending'] } }, select: { symbol: true } }),
    ]);
    return new Set([...sim, ...live].map(t => t.symbol));
  }

  private toCandles(raw: ccxt.OHLCV[]): Candle[] {
    return raw.map(r => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
  }

  private lastClosedTFIndex(candles: Candle[], tfMs: number): { i: number; closeAgeMs: number } | null {
    const now = Date.now();
    let i = candles.length - 1;
    if (now < candles[i].t + tfMs + 1_500) i -= 1;
    if (i < 0) return null;
    return { i, closeAgeMs: now - (candles[i].t + tfMs) };
  }

  private atr(candles: Candle[], index: number, period: number): number {
    if (index < period + 1) return 0;
    let total = 0;
    for (let i = index - period + 1; i <= index; i++) {
      const prev = candles[i - 1].c;
      total += Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - prev), Math.abs(candles[i].l - prev));
    }
    return total / period;
  }

  private ema(candles: Candle[], index: number, period: number): number {
    if (index < period - 1) return 0;
    const start = Math.max(0, index - period * 3);
    const k = 2 / (period + 1);
    let value = candles[start].c;
    for (let i = start + 1; i <= index; i++) value = candles[i].c * k + value * (1 - k);
    return value;
  }

  private rsi(candles: Candle[], index: number, period: number): number {
    if (index < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = index - period + 1; i <= index; i++) {
      const change = candles[i].c - candles[i - 1].c;
      if (change > 0) gains += change; else losses -= change;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period);
    return 100 - 100 / (1 + rs);
  }

  private volumeRatio(candles: Candle[], index: number, period: number): number {
    const start = Math.max(0, index - period);
    const base = candles.slice(start, index);
    if (!base.length) return 1;
    const avg = base.reduce((s, c) => s + c.v, 0) / base.length;
    return avg > 0 ? candles[index].v / avg : 1;
  }

  private spreadPct(ticker: any): number {
    const bid = Number(ticker.bid ?? ticker.info?.bid1 ?? 0);
    const ask = Number(ticker.ask ?? ticker.info?.ask1 ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(ticker.last ?? ticker.close ?? 0);
    return bid > 0 && ask > 0 && mid > 0 ? (ask - bid) / mid * 100 : 0;
  }

  private feeRateForSymbol(symbol: string, fallback: number): number {
    return this.feeBySymbol.has(symbol) ? Number(this.feeBySymbol.get(symbol)) : Number(fallback ?? 0.00038);
  }

  private async fetchOHLCVWithRetry(symbol: string, debugKey: string, tf: string, limit: number) {
    for (let i = 0; i < FETCH_RETRIES; i++) {
      try {
        return await this.fastExchange.fetchOHLCV(symbol, tf, undefined, limit);
      } catch {
        if (i < FETCH_RETRIES - 1) await this.sleep(200 + i * 200);
      }
    }
    this.bump(debugKey);
    return null;
  }

  private price(n: number) { return Number(Number(n).toPrecision(8)); }
  private reject(reason: string) { this.bump(reason); return null; }
  private bump(key: string) { this.debug[key] = (this.debug[key] ?? 0) + 1; }
  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  private emitStatus() {
    this.events.emitMtfScalperStatus({
      lastScanAt: this.lastScanAt,
      scannedPairs: this.scannedPairs,
      lastRawSignals: this.lastRawSignals,
      lastEmitted: this.lastEmitted,
      isScanning: this.isScanning,
      lastError: this.lastError,
      debug: { ...this.debug },
      feeTableSymbols: this.feeBySymbol.size,
      zeroFeeSymbols: this.zeroFeeSymbols.size,
    });
  }

  getSignals(limit = 100) { return this.recentSignals.slice(0, limit); }

  getStatus() {
    return {
      lastScanAt: this.lastScanAt,
      scannedPairs: this.scannedPairs,
      lastRawSignals: this.lastRawSignals,
      lastEmitted: this.lastEmitted,
      isScanning: this.isScanning,
      lastError: this.lastError,
      debug: { ...this.debug },
      feeTableSymbols: this.feeBySymbol.size,
      zeroFeeSymbols: this.zeroFeeSymbols.size,
    };
  }

  async getTrades(limit = 200) {
    return this.prisma.mtfScalperSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' }, take: limit });
  }

  async getAnalytics() {
    const cfg = await this.ensureConfig();
    const trades = await this.prisma.mtfScalperSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const open = trades.filter(t => t.status === 'open');
    const wins = closed.filter(t => (t.pnl ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees = [...closed, ...open].reduce((s, t) => s + (t.fees ?? 0), 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;
    return {
      totalTrades: trades.length,
      openTrades: open.length,
      closedTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? Number((wins.length / closed.length * 100).toFixed(1)) : null,
      totalPnl: Number(totalPnl.toFixed(4)),
      totalFees: Number(totalFees.toFixed(6)),
      avgWin: Number(avgWin.toFixed(4)),
      avgLoss: Number(avgLoss.toFixed(4)),
      rrActual: avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : null,
      capital: Number((cfg.startingCapital + totalPnl).toFixed(4)),
      config: cfg,
      recentSignals: this.getSignals(100),
      scannerStatus: this.getStatus(),
      openTradesList: open,
      closedTradesList: closed.slice(0, 100),
    };
  }

  async updateConfig(data: any) {
    const allowed = [
      'startingCapital', 'riskUsdt', 'tpRr', 'leverage', 'maxConcurrent',
      'maxSignalsPerScan', 'enabled', 'autoEnter', 'liveEnabled', 'minScore',
      'topPairs', 'minBodyRatio', 'maxCloseWick', 'minRangeAtr', 'maxRangeAtr',
      'minSlPct', 'maxSlPct', 'maxSpreadPct', 'minVolume24h', 'cooldownMinutes', 'feeRate',
    ];
    const patch: any = {};
    for (const key of allowed) { if (data[key] !== undefined) patch[key] = data[key]; }
    return this.prisma.mtfScalperConfig.update({ where: { id: 1 }, data: patch });
  }

  async getCandles(symbol: string, limit = 120) {
    try {
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TF_5M, undefined, limit + 1) as number[][];
      return ohlcv.slice(0, -1).map(c => ({
        time: Math.floor(c[0] / 1000),
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));
    } catch { return []; }
  }

  async resetSim() {
    await this.prisma.mtfScalperSimulatedTrade.deleteMany({});
    this.recentSignals = [];
    this.cooldowns.clear();
    this.emittedIds.clear();
    return { ok: true };
  }
}
