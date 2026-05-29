import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { LiveTradingService } from '../live/live-trading.service';
import { PrismaService } from '../prisma/prisma.service';

const SOURCE = 'SWEEP_STAR';
const TIMEFRAME = '5m';
const CANDLE_MS = 5 * 60_000;
const CANDLES = 120;
const MIN_VOLUME_24H = 500_000;
const SCAN_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 80;
const FETCH_RETRIES = 3;
const SIGNAL_COOLDOWN_MS = 30 * 60_000;
const CLOSE_CONFIRM_DELAY_MS = 350;
const MAX_CLOSE_CONFIRM_LAG_MS = 4_000;

type Direction = 'LONG' | 'SHORT';
type Grade = 'A+' | 'A' | 'B';

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SweepStarSignal {
  id: string;
  symbol: string;
  direction: Direction;
  patternType: 1 | 2;
  patternName: 'SWEEP_STAR_LONG' | 'SWEEP_STAR_SHORT';
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
  volumeRatio: number;
  bodyRangeRatio: number;
  closeWickRange: number;
  oppositeWickRange: number;
  sweepWickRange: number;
  atrPct: number;
  feeRate: number;
  isZeroFee: boolean;
  score: number;
  grade: Grade;
  reasons: string[];
  timestamp: string;
  triggerTs: number;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
}

@Injectable()
export class SweepStarService implements OnModuleInit {
  private readonly logger = new Logger(SweepStarService.name);
  private exchange: ccxt.mexc;
  private fastExchange: ccxt.mexc;
  private validSymbols = new Set<string>();
  private tickerCache: Record<string, any> = {};
  private recentSignals: SweepStarSignal[] = [];
  private cooldowns = new Map<string, number>();
  private isScanning = false;
  private lastScanAt: string | null = null;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private scannedPairs = 0;
  private debug: Record<string, number> = {};
  private feeBySymbol = new Map<string, number>();
  private zeroFeeSymbols = new Set<string>();
  private readonly sessionStart = new Date();

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
    this.logger.log(`[SWEEP] attivo su top 100 USDT futures, TF=${TIMEFRAME}`);
  }

  @Cron('30 0 * * * *')
  async loadContractFees() {
    try {
      const res = await fetch('https://contract.mexc.com/api/v1/contract/detail');
      const json = await res.json();
      if (!json?.success || !Array.isArray(json.data)) throw new Error('contract/detail invalid response');

      const fees = new Map<string, number>();
      const zero = new Set<string>();
      for (const row of json.data) {
        const contractSymbol = String(row.symbol ?? '');
        if (!contractSymbol.endsWith('_USDT')) continue;
        const symbol = contractSymbol.replace('_USDT', '/USDT:USDT');
        const maker = Number(row.makerFeeRate ?? 0);
        const taker = Number(row.takerFeeRate ?? 0);
        const isZero = Boolean(row.isZeroFeeRate) || Boolean(row.isZeroFeeSymbol) || (maker === 0 && taker === 0);
        fees.set(symbol, isZero ? 0 : Math.max(0, taker));
        if (isZero) zero.add(symbol);
      }
      this.feeBySymbol = fees;
      this.zeroFeeSymbols = zero;
      this.logger.log(`[SWEEP] fee table aggiornata: ${zero.size} zero-fee / ${fees.size} USDT futures`);
    } catch (err: any) {
      this.bump('fee_table_err');
      this.logger.warn(`[SWEEP] fee table non aggiornata: ${err?.message}`);
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
      this.logger.error(`[SWEEP] loadMarkets: ${err?.message}`);
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

  @Cron('56 4,9,14,19,24,29,34,39,44,49,54,59 * * * *')
  async scan() {
    if (this.isScanning || !this.validSymbols.size) return;
    this.isScanning = true;
    try {
      const scanStartedAt = Date.now();
      const targetCloseAt = Math.floor(scanStartedAt / CANDLE_MS) * CANDLE_MS + CANDLE_MS + CLOSE_CONFIRM_DELAY_MS;
      const cfg = await this.ensureConfig();
      const tickers = Object.keys(this.tickerCache).length
        ? this.tickerCache
        : await this.exchange.fetchTickers([...this.validSymbols]);
      const openSymbols = await this.getOpenSymbolsSet();

      const topPairs = Math.max(20, Math.min(200, cfg.topPairs));
      const candidates = Object.values(tickers)
        .filter((t: any) =>
          this.validSymbols.has(t.symbol) &&
          (Number(t.quoteVolume ?? t.info?.amount24 ?? 0) >= MIN_VOLUME_24H) &&
          !openSymbols.has(t.symbol) &&
          this.spreadPct(t) <= cfg.maxSpreadPct,
        )
        .sort((a: any, b: any) => Number(b.quoteVolume ?? b.info?.amount24 ?? 0) - Number(a.quoteVolume ?? a.info?.amount24 ?? 0))
        .slice(0, topPairs);

      this.scannedPairs = candidates.length;
      this.debug = {};
      const rawSignals: SweepStarSignal[] = [];

      for (let i = 0; i < candidates.length; i += SCAN_BATCH_SIZE) {
        const batch = candidates.slice(i, i + SCAN_BATCH_SIZE);
        const results = await Promise.all(batch.map(async (ticker: any) => {
          const raw = await this.fetchOHLCVWithRetry(ticker.symbol, 'fetch_err');
          return raw ? this.analyzePair(ticker, raw, cfg, 'forming') : null;
        }));
        results.forEach(sig => sig && rawSignals.push(sig));
        await this.sleep(BATCH_DELAY_MS);
      }

      this.lastRawSignals = rawSignals.length;
      const preselected = rawSignals
        .filter(sig => Date.now() - (this.cooldowns.get(sig.symbol) ?? 0) >= SIGNAL_COOLDOWN_MS)
        .sort((a, b) => b.score - a.score);

      if (preselected.length) {
        const waitMs = targetCloseAt - Date.now();
        if (waitMs > 0) await this.sleep(waitMs);
        const closeLag = Date.now() - targetCloseAt;
        if (closeLag > MAX_CLOSE_CONFIRM_LAG_MS) {
          this.bump('late_confirm_skip');
          this.lastEmitted = 0;
          this.emitStatus();
          return;
        }
      }

      const confirmed: SweepStarSignal[] = [];
      for (let i = 0; i < preselected.length; i += SCAN_BATCH_SIZE) {
        const batch = preselected.slice(i, i + SCAN_BATCH_SIZE);
        const results = await Promise.all(batch.map(async pre => {
          const raw = await this.fetchOHLCVWithRetry(pre.symbol, 'confirm_fetch_err');
          const ticker = tickers[pre.symbol] ?? { symbol: pre.symbol };
          if (!raw) return null;
          const sig = this.analyzePair(ticker, raw, cfg, 'closed', pre.triggerTs);
          return sig && sig.direction === pre.direction ? sig : null;
        }));
        results.forEach(sig => sig && confirmed.push(sig));
        if (i + SCAN_BATCH_SIZE < preselected.length) await this.sleep(25);
      }

      const openCount = await this.prisma.sweepStarSimulatedTrade.count({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      let slots = Math.max(0, cfg.maxConcurrent - openCount);
      let emitted = 0;

      for (const sig of confirmed) {
        this.cooldowns.set(sig.symbol, Date.now());
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 250) this.recentSignals.pop();
        this.events.emitSweepStarSignal(sig);

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
          }).catch(err => this.logger.error(`[SWEEP LIVE] ${sig.symbol}: ${err?.message}`));
        }
        emitted++;
      }

      this.lastEmitted = emitted;
      this.lastScanAt = new Date().toISOString();
      this.emitStatus();
      if (emitted) this.logger.log(`[SWEEP] raw=${rawSignals.length} confirmed=${confirmed.length} emitted=${emitted}`);
    } catch (err: any) {
      this.bump('scan_err');
      this.logger.error(`[SWEEP] scan: ${err?.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  @Cron('*/10 * * * * *')
  async checkOpenTrades() {
    const open = await this.prisma.sweepStarSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (!open.length) return;
    const cfg = await this.ensureConfig();

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
          const status = hitSL ? 'sl' : 'tp1';
          const closePrice = hitSL ? trade.stopLoss : trade.takeProfit1;
          await this.closeSimTrade(trade, closePrice, status);
          continue;
        }

        const mark = last.c;
        const priceDiff = isLong ? (mark - trade.entry) / trade.entry : (trade.entry - mark) / trade.entry;
        this.events.emitSweepStarPositions([{
          id: trade.id,
          currentPrice: Number(mark.toPrecision(8)),
          unrealizedPnl: Number((trade.positionSize * priceDiff - trade.fees).toFixed(4)),
          unrealizedPnlPct: Number((priceDiff * 100).toFixed(3)),
        }]);
      } catch {
        this.bump('check_err');
      }
    }
  }

  private analyzePair(ticker: any, raw: ccxt.OHLCV[], cfg: any, mode: 'forming' | 'closed', expectedTs?: number): SweepStarSignal | null {
    const candles = this.toCandles(raw);
    const triggerIndex = this.triggerIndex(candles, mode, expectedTs);
    if (triggerIndex < cfg.liquidityLookback + 3) return null;

    const i = triggerIndex;
    const confirm = candles[i];
    const sweep = candles[i - 1];
    const prior = candles.slice(i - 1 - cfg.liquidityLookback, i - 1);
    const priorLow = Math.min(...prior.map(c => c.l));
    const priorHigh = Math.max(...prior.map(c => c.h));
    const atr = this.atr(candles, i, 14);
    if (!atr) return this.reject('atr');

    const long = this.tryBuildSignal('LONG', ticker, candles, i, sweep, confirm, priorLow, priorHigh, atr, cfg);
    if (long) return long;
    const short = this.tryBuildSignal('SHORT', ticker, candles, i, sweep, confirm, priorLow, priorHigh, atr, cfg);
    if (short) return short;
    return null;
  }

  private tryBuildSignal(
    direction: Direction,
    ticker: any,
    candles: Candle[],
    i: number,
    sweep: Candle,
    confirm: Candle,
    priorLow: number,
    priorHigh: number,
    atr: number,
    cfg: any,
  ): SweepStarSignal | null {
    const isLong = direction === 'LONG';
    const confirmRange = confirm.h - confirm.l;
    const confirmBody = Math.abs(confirm.c - confirm.o);
    const sweepRange = sweep.h - sweep.l;
    if (confirmRange <= 0 || sweepRange <= 0 || confirmBody <= 0) return null;

    const sweepBody = Math.abs(sweep.c - sweep.o);
    const sweepWick = isLong ? Math.min(sweep.o, sweep.c) - sweep.l : sweep.h - Math.max(sweep.o, sweep.c);
    const sweepWickRatio = sweepWick / sweepRange;
    const sweptLevel = isLong ? priorLow : priorHigh;
    const swept = isLong
      ? sweep.l < sweptLevel && sweep.c > sweptLevel
      : sweep.h > sweptLevel && sweep.c < sweptLevel;
    const confirmBreak = isLong
      ? confirm.c > sweep.h && confirm.c > confirm.o
      : confirm.c < sweep.l && confirm.c < confirm.o;
    if (!swept || !confirmBreak) return this.reject(isLong ? 'no_long_sweep' : 'no_short_sweep');

    const bodyRatio = confirmBody / confirmRange;
    const closeWick = isLong ? confirm.h - confirm.c : confirm.c - confirm.l;
    const oppositeWick = isLong ? confirm.o - confirm.l : confirm.h - confirm.o;
    const closeWickRatio = closeWick / confirmRange;
    const oppositeWickRatio = oppositeWick / confirmRange;
    const confirmBodyAtr = confirmBody / atr;
    const confirmVolumeRatio = this.volumeRatio(candles, i, 20);
    const sweepVolumeRatio = this.volumeRatio(candles, i - 1, 20);
    const volumeRatio = Math.max(confirmVolumeRatio, sweepVolumeRatio);
    const spread = this.spreadPct(ticker);
    const feeRate = this.feeRateForSymbol(ticker.symbol, cfg.feeRate);

    if (bodyRatio < cfg.minBodyRangeRatio) return this.reject('body');
    if (closeWickRatio > cfg.maxCloseWickRange) return this.reject('close_wick');
    if (oppositeWickRatio > cfg.maxOppositeWickRange) return this.reject('opposite_wick');
    if (sweepWickRatio < cfg.minSweepWickRange || sweepWick <= sweepBody * 0.8) return this.reject('weak_sweep');
    if (confirmBodyAtr < cfg.minConfirmBodyAtr) return this.reject('body_atr');
    if (volumeRatio < cfg.minVolumeRatio) return this.reject('volume');
    if (spread > cfg.maxSpreadPct) return this.reject('spread');

    const entry = confirm.c;
    const stopLoss = isLong ? sweep.l : sweep.h;
    const slPct = Math.abs(entry - stopLoss) / entry * 100;
    if (slPct < cfg.minSlPct) return this.reject('sl_small');
    if (slPct > cfg.maxSlPct) return this.reject('sl_big');

    const riskDist = Math.abs(entry - stopLoss);
    const takeProfit = isLong ? entry + riskDist * cfg.tpRr : entry - riskDist * cfg.tpRr;
    const tpPct = slPct * cfg.tpRr;
    const score = this.score({
      bodyRatio,
      closeWickRatio,
      oppositeWickRatio,
      sweepWickRatio,
      confirmBodyAtr,
      volumeRatio,
      slPct,
    });
    if (score < cfg.minScore) return this.reject('score');

    const positionSize = cfg.riskUsdt / (slPct / 100);
    const leverage = Math.min(Number(cfg.leverage), 125);
    const grade: Grade = score >= 92 ? 'A+' : score >= 84 ? 'A' : 'B';

    return {
      id: `${SOURCE}_${ticker.symbol}_${confirm.t}`,
      symbol: ticker.symbol,
      direction,
      patternType: isLong ? 1 : 2,
      patternName: isLong ? 'SWEEP_STAR_LONG' : 'SWEEP_STAR_SHORT',
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
      volumeRatio: Number(volumeRatio.toFixed(2)),
      bodyRangeRatio: Number(bodyRatio.toFixed(3)),
      closeWickRange: Number(closeWickRatio.toFixed(3)),
      oppositeWickRange: Number(oppositeWickRatio.toFixed(3)),
      sweepWickRange: Number(sweepWickRatio.toFixed(3)),
      atrPct: Number((atr / entry * 100).toFixed(4)),
      feeRate,
      isZeroFee: feeRate === 0,
      score,
      grade,
      reasons: [
        isLong ? 'sweep sotto i minimi' : 'sweep sopra i massimi',
        `body ${(bodyRatio * 100).toFixed(0)}%`,
        `sweep wick ${(sweepWickRatio * 100).toFixed(0)}%`,
        `vol x${volumeRatio.toFixed(2)}`,
        feeRate === 0 ? '0 fee' : `fee ${(feeRate * 100).toFixed(3)}%`,
        `RR ${cfg.tpRr.toFixed(1)}R`,
      ],
      timestamp: new Date(confirm.t).toISOString(),
      triggerTs: confirm.t,
      mexcUrl: `https://futures.mexc.com/exchange/${ticker.symbol.replace('/USDT:USDT', '_USDT')}`,
      sparkline: candles.slice(Math.max(0, i - 50), i + 1).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    };
  }

  private score(x: {
    bodyRatio: number;
    closeWickRatio: number;
    oppositeWickRatio: number;
    sweepWickRatio: number;
    confirmBodyAtr: number;
    volumeRatio: number;
    slPct: number;
  }) {
    let pts = 0;
    pts += x.bodyRatio >= 0.84 ? 22 : x.bodyRatio >= 0.76 ? 18 : 12;
    pts += x.closeWickRatio <= 0.02 ? 18 : x.closeWickRatio <= 0.04 ? 14 : 8;
    pts += x.oppositeWickRatio <= 0.06 ? 17 : x.oppositeWickRatio <= 0.11 ? 12 : 7;
    pts += x.sweepWickRatio >= 0.55 ? 18 : x.sweepWickRatio >= 0.42 ? 14 : 9;
    pts += x.confirmBodyAtr >= 0.90 ? 12 : x.confirmBodyAtr >= 0.60 ? 9 : 5;
    pts += x.volumeRatio >= 1.8 ? 9 : x.volumeRatio >= 1.2 ? 6 : 3;
    pts += x.slPct <= 0.55 ? 4 : 1;
    return Math.min(100, pts);
  }

  private async enterSimTrade(sig: SweepStarSignal, cfg: any) {
    const already = await this.prisma.sweepStarSimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (already) return;
    const capital = await this.currentCapital(cfg);
    const fees = sig.positionSize * sig.feeRate;
    const trade = await this.prisma.sweepStarSimulatedTrade.create({
      data: {
        id: sig.id,
        symbol: sig.symbol,
        direction: sig.direction,
        patternType: sig.patternType,
        patternName: sig.patternName,
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
    this.events.emitSweepStarTrade(trade);
  }

  private async closeSimTrade(trade: any, closePrice: number, status: string) {
    const isLong = trade.direction === 'LONG';
    const priceDiff = isLong ? (closePrice - trade.entry) / trade.entry : (trade.entry - closePrice) / trade.entry;
    const feeRate = Number(trade.feeRate ?? this.feeRateForSymbol(trade.symbol, 0.00038));
    const exitFee = trade.positionSize * feeRate;
    const totalFees = (trade.fees ?? 0) + exitFee;
    const pnl = trade.positionSize * priceDiff - totalFees;
    const updated = await this.prisma.sweepStarSimulatedTrade.update({
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
    this.events.emitSweepStarTrade(updated);
  }

  private async ensureConfig() {
    const cfg = await this.prisma.sweepStarConfig.findUnique({ where: { id: 1 } });
    if (cfg) return cfg;
    return this.prisma.sweepStarConfig.create({ data: { id: 1 } });
  }

  private async currentCapital(cfg: any) {
    const closed = await this.prisma.sweepStarSimulatedTrade.findMany({
      where: { status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
    });
    return closed.reduce((cap, t) => cap + (t.pnl ?? 0), cfg.startingCapital);
  }

  private async getOpenSymbolsSet() {
    const [sim, live] = await Promise.all([
      this.prisma.sweepStarSimulatedTrade.findMany({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
        select: { symbol: true },
      }),
      this.prisma.liveTrade.findMany({
        where: { status: { in: ['open', 'pending'] } },
        select: { symbol: true },
      }),
    ]);
    return new Set([...sim, ...live].map(t => t.symbol));
  }

  private toCandles(raw: ccxt.OHLCV[]): Candle[] {
    return raw.map(r => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) }));
  }

  private triggerIndex(candles: Candle[], mode: 'forming' | 'closed', expectedTs?: number) {
    if (expectedTs) return candles.findIndex(c => c.t === expectedTs);
    if (mode === 'forming') return candles.length - 1;
    const now = Date.now();
    let i = candles.length - 1;
    if (now < candles[i].t + CANDLE_MS + 1_000) i -= 1;
    return i;
  }

  private atr(candles: Candle[], index: number, period: number) {
    if (index < period + 1) return 0;
    let total = 0;
    for (let i = index - period + 1; i <= index; i++) {
      const prevClose = candles[i - 1].c;
      total += Math.max(
        candles[i].h - candles[i].l,
        Math.abs(candles[i].h - prevClose),
        Math.abs(candles[i].l - prevClose),
      );
    }
    return total / period;
  }

  private volumeRatio(candles: Candle[], index: number, period: number) {
    const start = Math.max(0, index - period);
    const base = candles.slice(start, index);
    if (!base.length) return 1;
    const avg = base.reduce((s, c) => s + c.v, 0) / base.length;
    return avg > 0 ? candles[index].v / avg : 1;
  }

  private spreadPct(ticker: any) {
    const bid = Number(ticker.bid ?? ticker.info?.bid1 ?? 0);
    const ask = Number(ticker.ask ?? ticker.info?.ask1 ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(ticker.last ?? ticker.close ?? 0);
    return bid > 0 && ask > 0 && mid > 0 ? (ask - bid) / mid * 100 : 0;
  }

  private feeRateForSymbol(symbol: string, fallback: number) {
    return this.feeBySymbol.has(symbol) ? Number(this.feeBySymbol.get(symbol)) : Number(fallback ?? 0.00038);
  }

  private async fetchOHLCVWithRetry(symbol: string, debugKey: string, tf = TIMEFRAME, limit = CANDLES) {
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

  private price(n: number) {
    return Number(Number(n).toPrecision(8));
  }

  private reject(reason: string) {
    this.bump(reason);
    return null;
  }

  private bump(key: string) {
    this.debug[key] = (this.debug[key] ?? 0) + 1;
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private emitStatus() {
    this.events.emitSweepStarStatus({
      lastScanAt: this.lastScanAt,
      scannedPairs: this.scannedPairs,
      lastRawSignals: this.lastRawSignals,
      lastEmitted: this.lastEmitted,
      isScanning: this.isScanning,
      debug: { ...this.debug },
      feeTableSymbols: this.feeBySymbol.size,
      zeroFeeSymbols: this.zeroFeeSymbols.size,
    });
  }

  getSignals(limit = 100) {
    return this.recentSignals.slice(0, limit);
  }

  getStatus() {
    return {
      lastScanAt: this.lastScanAt,
      scannedPairs: this.scannedPairs,
      lastRawSignals: this.lastRawSignals,
      lastEmitted: this.lastEmitted,
      isScanning: this.isScanning,
      debug: { ...this.debug },
      feeTableSymbols: this.feeBySymbol.size,
      zeroFeeSymbols: this.zeroFeeSymbols.size,
    };
  }

  async getTrades(limit = 200) {
    return this.prisma.sweepStarSimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
  }

  async getAnalytics() {
    const cfg = await this.ensureConfig();
    const trades = await this.prisma.sweepStarSimulatedTrade.findMany({
      where: { openedAt: { gte: this.sessionStart } },
      orderBy: { openedAt: 'desc' },
    });
    const closed = trades.filter(t => t.status !== 'open');
    const open = trades.filter(t => t.status === 'open');
    const wins = closed.filter(t => (t.pnl ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees = closed.reduce((s, t) => s + (t.fees ?? 0), 0) + open.reduce((s, t) => s + (t.fees ?? 0), 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;
    const byPattern: Record<string, { tp: number; sl: number }> = {};
    for (const t of closed) {
      byPattern[t.patternName] ??= { tp: 0, sl: 0 };
      if (t.status === 'tp1') byPattern[t.patternName].tp++;
      if (t.status === 'sl') byPattern[t.patternName].sl++;
    }
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
      byPattern,
      config: cfg,
      recentSignals: this.getSignals(100),
      scannerStatus: this.getStatus(),
    };
  }

  async updateConfig(data: any) {
    const allowed = [
      'startingCapital', 'riskUsdt', 'tpRr', 'leverage', 'maxConcurrent',
      'autoEnter', 'liveEnabled', 'minScore', 'topPairs', 'liquidityLookback',
      'minBodyRangeRatio', 'maxCloseWickRange', 'maxOppositeWickRange',
      'minSweepWickRange', 'minConfirmBodyAtr', 'minVolumeRatio',
      'minSlPct', 'maxSlPct', 'maxSpreadPct', 'feeRate',
    ];
    const patch: any = {};
    for (const key of allowed) {
      if (data[key] !== undefined) patch[key] = data[key];
    }
    return this.prisma.sweepStarConfig.update({ where: { id: 1 }, data: patch });
  }

  async getCandles(symbol: string, limit = 120) {
    try {
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, limit + 1) as number[][];
      return ohlcv.slice(0, -1).map(c => ({
        time: Math.floor(c[0] / 1000),
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));
    } catch { return []; }
  }

  async resetSim() {
    await this.prisma.sweepStarSimulatedTrade.deleteMany({});
    this.recentSignals = [];
    this.cooldowns.clear();
  }
}
