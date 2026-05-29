import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { LiveTradingService } from '../live/live-trading.service';
import { PrismaService } from '../prisma/prisma.service';

const SOURCE = 'IMPULSE_100';
const TIMEFRAME = '5m';
const CANDLE_MS = 5 * 60_000;
const CANDLES = 120;
const SCAN_BATCH_SIZE = 5;
const BATCH_DELAY_MS = 140;
const FETCH_RETRIES = 4;

type Direction = 'LONG' | 'SHORT';
type Grade = 'A+' | 'A' | 'B';
type PatternName =
  | 'CONTINUATION_PULLBACK_LONG'
  | 'CONTINUATION_PULLBACK_SHORT'
  | 'FAILED_MOVE_REVERSAL_LONG'
  | 'FAILED_MOVE_REVERSAL_SHORT';

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface TriggerStats {
  direction: Direction;
  trigger: Candle;
  range: number;
  body: number;
  bodyRatio: number;
  closeWickRatio: number;
  oppositeWickRatio: number;
  atr: number;
  rangeAtr: number;
  volumeRatio: number;
  feeRate: number;
  spread: number;
}

interface SetupCandidate {
  patternName: PatternName;
  stopLoss: number;
  breakStrengthPct: number;
  contextScore: number;
  reasons: string[];
}

export interface Impulse100Signal {
  id: string;
  symbol: string;
  direction: Direction;
  patternName: PatternName;
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
  oppositeWickRange: number;
  rangeAtr: number;
  breakStrengthPct: number;
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
export class Impulse100Service implements OnModuleInit {
  private readonly logger = new Logger(Impulse100Service.name);
  private exchange: ccxt.mexc;
  private fastExchange: ccxt.mexc;
  private validSymbols = new Set<string>();
  private tickerCache: Record<string, any> = {};
  private recentSignals: Impulse100Signal[] = [];
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
    this.logger.log(`[IMPULSE100] attivo su top 100 USDT futures, TF=${TIMEFRAME}`);
  }

  @Cron('30 0 * * * *')
  async loadContractFees() {
    try {
      const res = await fetch('https://contract.mexc.com/api/v1/contract/detail');
      const json = await res.json();
      if (!json?.success || !Array.isArray(json.data)) throw new Error('contract/detail invalid response');

      const fees = new Map<string, number>();
      for (const row of json.data) {
        const contractSymbol = String(row.symbol ?? '');
        if (!contractSymbol.endsWith('_USDT')) continue;
        const symbol = contractSymbol.replace('_USDT', '/USDT:USDT');
        const taker = Number(row.takerFeeRate ?? 0);
        // API orders are excluded from MEXC zero-fee promotions (policy since May 2026)
        fees.set(symbol, Math.max(taker, 0.0006));
      }
      this.feeBySymbol = fees;
      this.zeroFeeSymbols = new Set();
      this.logger.log(`[IMPULSE100] fee table aggiornata: ${fees.size} USDT futures (API taker floor 0.06%)`);
    } catch (err: any) {
      this.bump('fee_table_err');
      this.logger.warn(`[IMPULSE100] fee table non aggiornata: ${err?.message}`);
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
      this.logger.error(`[IMPULSE100] loadMarkets: ${this.lastError}`);
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
      const rawSignals: Impulse100Signal[] = [];

      for (let i = 0; i < candidates.length; i += SCAN_BATCH_SIZE) {
        const batch = candidates.slice(i, i + SCAN_BATCH_SIZE);
        const results = await Promise.all(batch.map(async (ticker: any) => {
          const raw = await this.fetchOHLCVWithRetry(ticker.symbol, 'fetch_err');
          return raw ? this.analyzePair(ticker, raw, cfg) : null;
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

      const openCount = await this.prisma.impulse100SimulatedTrade.count({
        where: { status: 'open' },
      });
      let slots = Math.max(0, cfg.maxConcurrent - openCount);
      let emitted = 0;

      for (const sig of selected) {
        this.emittedIds.add(sig.id);
        this.cooldowns.set(sig.symbol, Date.now());
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 250) this.recentSignals.pop();
        this.events.emitImpulse100Signal(sig);

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
          }).catch(err => this.logger.error(`[IMPULSE100 LIVE] ${sig.symbol}: ${err?.message}`));
        }
        emitted++;
      }

      this.lastEmitted = emitted;
      this.lastScanAt = new Date().toISOString();
      this.emitStatus();
      this.logger.log(`[IMPULSE100] scanned=${this.scannedPairs} raw=${rawSignals.length} emitted=${emitted}`);
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      this.bump('scan_err');
      this.logger.error(`[IMPULSE100] scan: ${this.lastError}`);
      this.emitStatus();
    } finally {
      this.isScanning = false;
    }
  }

  @Cron('*/10 * * * * *')
  async checkOpenTrades() {
    const open = await this.prisma.impulse100SimulatedTrade.findMany({
      where: { status: 'open' },
    });
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
          const status = hitSL ? 'sl' : 'tp1';
          const closePrice = hitSL ? trade.stopLoss : trade.takeProfit1;
          await this.closeSimTrade(trade, closePrice, status);
          continue;
        }

        const mark = last.c;
        const priceDiff = isLong ? (mark - trade.entry) / trade.entry : (trade.entry - mark) / trade.entry;
        const feeRate = this.feeRateForTrade(trade);
        const openFee = Number(trade.fees ?? 0) > 0 ? Number(trade.fees) : trade.positionSize * feeRate;
        const exitFee = trade.positionSize * feeRate;
        this.events.emitImpulse100Positions([{
          id: trade.id,
          currentPrice: Number(mark.toPrecision(8)),
          unrealizedPnl: Number((trade.positionSize * priceDiff - openFee - exitFee).toFixed(4)),
          unrealizedPnlPct: Number((priceDiff * 100).toFixed(3)),
        }]);
      } catch {
        this.bump('check_err');
      }
    }
  }

  private analyzePair(ticker: any, raw: ccxt.OHLCV[], cfg: any): Impulse100Signal | null {
    const candles = this.toCandles(raw);
    const closed = this.lastClosedIndex(candles);
    if (!closed || closed.i < 30) return null;
    const i = closed.i;
    const trigger = candles[i];
    const isLong = trigger.c > trigger.o;
    const isShort = trigger.c < trigger.o;
    if (!isLong && !isShort) return this.reject('doji');

    const range = trigger.h - trigger.l;
    const body = Math.abs(trigger.c - trigger.o);
    if (range <= 0 || body <= 0) return this.reject('empty');

    const direction: Direction = isLong ? 'LONG' : 'SHORT';
    const closeWick = isLong ? trigger.h - trigger.c : trigger.c - trigger.l;
    const oppositeWick = isLong ? trigger.o - trigger.l : trigger.h - trigger.o;
    const bodyRatio = body / range;
    const closeWickRatio = closeWick / range;
    const oppositeWickRatio = oppositeWick / range;

    if (bodyRatio < cfg.minBodyRangeRatio) return this.reject('body');
    if (closeWickRatio > cfg.maxCloseWickRange) return this.reject('close_wick');
    if (oppositeWickRatio > cfg.maxOppositeWickRange) return this.reject('opposite_wick');

    const atr = this.atr(candles, i, 14);
    if (!atr || atr <= 0) return this.reject('atr');
    const rangeAtr = range / atr;
    if (rangeAtr < cfg.minRangeAtr) return this.reject('range_atr');
    if (rangeAtr > cfg.maxRangeAtr) return this.reject('range_atr_big');

    const feeRate = this.feeRateForSymbol(ticker.symbol, cfg.feeRate);
    const volumeRatio = this.volumeRatio(candles, i, 20);
    const spread = this.spreadPct(ticker);

    const stats: TriggerStats = {
      direction,
      trigger,
      range,
      body,
      bodyRatio,
      closeWickRatio,
      oppositeWickRatio,
      atr,
      rangeAtr,
      volumeRatio,
      feeRate,
      spread,
    };

    const candidates = [
      this.detectFailedMoveReversal(ticker, candles, i, closed.closeAgeMs, cfg, stats),
    ].filter((sig): sig is Impulse100Signal => Boolean(sig));

    if (!candidates.length) return this.reject('setup');

    return candidates.sort((a, b) =>
      b.score - a.score ||
      Number(a.feeRate) - Number(b.feeRate) ||
      a.spreadPct - b.spreadPct,
    )[0];
  }

  private detectContinuationPullback(
    ticker: any,
    candles: Candle[],
    i: number,
    closeAgeMs: number,
    cfg: any,
    stats: TriggerStats,
  ) {
    const isLong = stats.direction === 'LONG';
    const trigger = stats.trigger;
    const pullback = candles.slice(i - 6, i);
    if (pullback.length < 4) return null;

    const oppositeCount = pullback.filter(c => isLong ? c.c < c.o : c.c > c.o).length;
    const smallBodyCount = pullback.filter(c => this.bodyRatio(c) <= 0.45).length;
    if (oppositeCount < 1 && smallBodyCount < 2) return null;

    const sameDirectionRun = this.sameDirectionRun(candles, i - 1, stats.direction);
    if (sameDirectionRun > 2) return null;

    const lookback = Math.max(2, Math.min(6, Number(cfg.breakLookback ?? 2)));
    const recent = candles.slice(i - lookback, i);
    if (recent.length < lookback) return null;
    const pullbackHigh = Math.max(...recent.map(c => c.h));
    const pullbackLow = Math.min(...recent.map(c => c.l));
    const breakLevel = isLong ? pullbackHigh : pullbackLow;
    const didBreak = isLong ? trigger.c > pullbackHigh : trigger.c < pullbackLow;
    if (!didBreak) return null;
    const breakStrengthPct = Math.abs(trigger.c - breakLevel) / trigger.c * 100;
    if (breakStrengthPct < 0.08) return null;

    const previousContext = candles.slice(i - 18, i - 6);
    if (previousContext.length < 8) return null;
    const contextRange = Math.max(...previousContext.map(c => c.h)) - Math.min(...previousContext.map(c => c.l));
    if (contextRange < stats.atr * 0.8) return null;
    if (stats.rangeAtr < 0.85) return null;
    if (stats.volumeRatio < 0.8) return null;

    const emaNow = this.ema(candles, i, 34);
    const emaPrev = this.ema(candles, i - 5, 34);
    if (!emaNow || !emaPrev) return null;
    const emaSlopePct = (emaNow - emaPrev) / trigger.c * 100;
    const emaAligned = isLong
      ? trigger.c > emaNow && emaSlopePct >= 0.05
      : trigger.c < emaNow && emaSlopePct <= -0.05;
    if (!emaAligned) return null;

    const pauseScore = Math.min(6, oppositeCount + smallBodyCount);
    const runScore = sameDirectionRun === 0 ? 3 : sameDirectionRun === 1 ? 2 : 1;

    return this.buildSignal(
      ticker,
      candles,
      i,
      closeAgeMs,
      cfg,
      stats,
      {
        patternName: isLong ? 'CONTINUATION_PULLBACK_LONG' : 'CONTINUATION_PULLBACK_SHORT',
        stopLoss: trigger.o,
        breakStrengthPct,
        contextScore: 10 + pauseScore + runScore,
        reasons: [
          isLong ? 'continuazione dopo pullback' : 'continuazione short dopo pullback',
          isLong ? 'break massimo pullback' : 'break minimo pullback',
          `pausa ${oppositeCount} opp/${smallBodyCount} small`,
        ],
      },
    );
  }

  private detectFailedMoveReversal(
    ticker: any,
    candles: Candle[],
    i: number,
    closeAgeMs: number,
    cfg: any,
    stats: TriggerStats,
  ) {
    const isLong = stats.direction === 'LONG';
    const trigger = stats.trigger;
    const zone = candles.slice(i - 11, i - 3);
    const probe = candles.slice(i - 3, i);
    if (zone.length < 6 || probe.length < 2) return null;

    const zoneHigh = Math.max(...zone.map(c => c.h));
    const zoneLow = Math.min(...zone.map(c => c.l));
    const probeHigh = Math.max(...probe.map(c => c.h));
    const probeLow = Math.min(...probe.map(c => c.l));
    const lastTwo = candles.slice(i - 2, i);
    const lastTwoHigh = Math.max(...lastTwo.map(c => c.h));
    const lastTwoLow = Math.min(...lastTwo.map(c => c.l));

    if (isLong) {
      const swept = probeLow < zoneLow;
      const reclaimed = trigger.c > zoneLow && trigger.c > lastTwoHigh;
      if (!swept || !reclaimed) return null;

      const breakStrengthPct = Math.abs(trigger.c - zoneLow) / trigger.c * 100;
      return this.buildSignal(
        ticker,
        candles,
        i,
        closeAgeMs,
        cfg,
        stats,
        {
          patternName: 'FAILED_MOVE_REVERSAL_LONG',
          stopLoss: Math.min(trigger.o, probeLow),
          breakStrengthPct,
          contextScore: 18,
          reasons: [
            'failed move sotto micro-zona',
            'rientro sopra zona',
            'close sopra ultime 2 candele',
          ],
        },
      );
    }

    const swept = probeHigh > zoneHigh;
    const reclaimed = trigger.c < zoneHigh && trigger.c < lastTwoLow;
    if (!swept || !reclaimed) return null;

    const breakStrengthPct = Math.abs(trigger.c - zoneHigh) / trigger.c * 100;
    return this.buildSignal(
      ticker,
      candles,
      i,
      closeAgeMs,
      cfg,
      stats,
      {
        patternName: 'FAILED_MOVE_REVERSAL_SHORT',
        stopLoss: Math.max(trigger.o, probeHigh),
        breakStrengthPct,
        contextScore: 18,
        reasons: [
          'failed move sopra micro-zona',
          'rientro sotto zona',
          'close sotto ultime 2 candele',
        ],
      },
    );
  }

  private buildSignal(
    ticker: any,
    candles: Candle[],
    i: number,
    closeAgeMs: number,
    cfg: any,
    stats: TriggerStats,
    setup: SetupCandidate,
  ): Impulse100Signal | null {
    const trigger = stats.trigger;
    const isLong = stats.direction === 'LONG';
    const entry = trigger.c;
    const stopLoss = setup.stopLoss;
    if (isLong && stopLoss >= entry) return this.reject('sl_side');
    if (!isLong && stopLoss <= entry) return this.reject('sl_side');

    const riskDist = Math.abs(entry - stopLoss);
    const slPct = riskDist / entry * 100;
    if (slPct < cfg.minSlPct) return this.reject('sl_small');
    if (slPct > cfg.maxSlPct) return this.reject('sl_big');

    const score = this.score({
      bodyRatio: stats.bodyRatio,
      closeWickRatio: stats.closeWickRatio,
      oppositeWickRatio: stats.oppositeWickRatio,
      rangeAtr: stats.rangeAtr,
      volumeRatio: stats.volumeRatio,
      slPct,
      breakStrengthPct: setup.breakStrengthPct,
      isZeroFee: stats.feeRate === 0,
      contextScore: setup.contextScore,
    });
    if (score < cfg.minScore) return this.reject('score');

    const takeProfit = isLong ? entry + riskDist * cfg.tpRr : entry - riskDist * cfg.tpRr;
    const tpPct = slPct * cfg.tpRr;
    const feeRate = stats.feeRate;
    const positionSize = cfg.riskUsdt / (slPct / 100);
    const maxSymLev = this.maxLeverageForSymbol(ticker.symbol);
    const targetMargin = Math.max(1, Number(cfg.maxMarginUsdt ?? 10));
    const leverage = Math.max(1, Math.min(Math.ceil(positionSize / targetMargin), maxSymLev, 125));
    const grade: Grade = score >= 92 ? 'A+' : score >= 84 ? 'A' : 'B';

    return {
      id: `${SOURCE}_${ticker.symbol}_${trigger.t}`,
      symbol: ticker.symbol,
      direction: stats.direction,
      patternName: setup.patternName,
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
      spreadPct: Number(stats.spread.toFixed(4)),
      volume24h: Number(Number(ticker.quoteVolume ?? ticker.info?.amount24 ?? 0).toFixed(2)),
      volumeRatio: Number(stats.volumeRatio.toFixed(2)),
      bodyRangeRatio: Number(stats.bodyRatio.toFixed(3)),
      closeWickRange: Number(stats.closeWickRatio.toFixed(3)),
      oppositeWickRange: Number(stats.oppositeWickRatio.toFixed(3)),
      rangeAtr: Number(stats.rangeAtr.toFixed(3)),
      breakStrengthPct: Number(setup.breakStrengthPct.toFixed(4)),
      feeRate: stats.feeRate,
      isZeroFee: stats.feeRate === 0,
      score,
      grade,
      reasons: [
        ...setup.reasons,
        `body ${(stats.bodyRatio * 100).toFixed(0)}%`,
        `close wick ${(stats.closeWickRatio * 100).toFixed(1)}%`,
        `opp wick ${(stats.oppositeWickRatio * 100).toFixed(1)}%`,
        `ATR x${stats.rangeAtr.toFixed(2)}`,
        stats.feeRate === 0 ? '0 fee' : `fee ${(stats.feeRate * 100).toFixed(3)}%`,
        `RR ${cfg.tpRr.toFixed(1)}R`,
      ],
      timestamp: new Date(trigger.t).toISOString(),
      triggerTs: trigger.t,
      candleCloseAgeMs: closeAgeMs,
      mexcUrl: `https://futures.mexc.com/exchange/${ticker.symbol.replace('/USDT:USDT', '_USDT')}`,
      sparkline: candles.slice(Math.max(0, i - 50), i + 1).map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    };
  }

  private score(x: {
    bodyRatio: number;
    closeWickRatio: number;
    oppositeWickRatio: number;
    rangeAtr: number;
    volumeRatio: number;
    slPct: number;
    breakStrengthPct: number;
    isZeroFee: boolean;
    contextScore: number;
  }) {
    let pts = 0;
    pts += x.bodyRatio >= 0.90 ? 18 : x.bodyRatio >= 0.78 ? 15 : 12;
    pts += x.closeWickRatio <= 0.01 ? 18 : x.closeWickRatio <= 0.03 ? 15 : 11;
    pts += x.oppositeWickRatio <= 0.02 ? 18 : x.oppositeWickRatio <= 0.05 ? 14 : 9;
    pts += x.rangeAtr >= 1.20 ? 12 : x.rangeAtr >= 0.85 ? 10 : 7;
    pts += x.breakStrengthPct >= 0.20 ? 8 : x.breakStrengthPct >= 0.08 ? 6 : 4;
    pts += x.volumeRatio >= 1.60 ? 6 : x.volumeRatio >= 1.00 ? 4 : 2;
    pts += x.slPct >= 0.25 && x.slPct <= 0.65 ? 5 : 3;
    pts += x.contextScore;
    if (x.isZeroFee) pts += 4;
    return Math.min(100, pts);
  }

  private sameDirectionRun(candles: Candle[], fromIndex: number, direction: Direction) {
    let count = 0;
    for (let i = fromIndex; i >= 0; i--) {
      const c = candles[i];
      const same = direction === 'LONG' ? c.c > c.o : c.c < c.o;
      if (!same) break;
      count++;
    }
    return count;
  }

  private bodyRatio(candle: Candle) {
    const range = candle.h - candle.l;
    return range > 0 ? Math.abs(candle.c - candle.o) / range : 0;
  }


  private async enterSimTrade(sig: Impulse100Signal, cfg: any) {
    const [sameId, already] = await Promise.all([
      this.prisma.impulse100SimulatedTrade.findUnique({ where: { id: sig.id } }),
      this.prisma.impulse100SimulatedTrade.findFirst({
        where: { symbol: sig.symbol, status: 'open' },
      }),
    ]);
    if (sameId || already) return;

    const capital = await this.currentCapital(cfg);
    const fees = sig.positionSize * sig.feeRate;
    const trade = await this.prisma.impulse100SimulatedTrade.create({
      data: {
        id: sig.id,
        symbol: sig.symbol,
        direction: sig.direction,
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
    this.events.emitImpulse100Trade(trade);
  }

  private async closeSimTrade(trade: any, closePrice: number, status: string) {
    const isLong = trade.direction === 'LONG';
    const priceDiff = isLong ? (closePrice - trade.entry) / trade.entry : (trade.entry - closePrice) / trade.entry;
    const feeRate = this.feeRateForTrade(trade);
    const openFee = Number(trade.fees ?? 0) > 0 ? Number(trade.fees) : trade.positionSize * feeRate;
    const exitFee = trade.positionSize * feeRate;
    const totalFees = openFee + exitFee;
    const pnl = trade.positionSize * priceDiff - totalFees;
    const updated = await this.prisma.impulse100SimulatedTrade.update({
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
    this.events.emitImpulse100Trade(updated);
  }

  private async ensureConfig() {
    const cfg = await this.prisma.impulse100Config.findUnique({ where: { id: 1 } });
    if (cfg) return cfg;
    return this.prisma.impulse100Config.create({ data: { id: 1 } });
  }

  private async currentCapital(cfg: any) {
    const closed = await this.prisma.impulse100SimulatedTrade.findMany({
      where: { status: { not: 'open' } },
    });
    return closed.reduce((cap, t) => cap + (this.normalizeTradePnl(t).pnl ?? 0), cfg.startingCapital);
  }

  private async getOpenSymbolsSet() {
    const [sim, live] = await Promise.all([
      this.prisma.impulse100SimulatedTrade.findMany({
        where: { status: 'open' },
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

  private lastClosedIndex(candles: Candle[]) {
    const now = Date.now();
    let i = candles.length - 1;
    if (now < candles[i].t + CANDLE_MS + 1_500) i -= 1;
    if (i < 0) return null;
    return { i, closeAgeMs: now - (candles[i].t + CANDLE_MS) };
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

  private ema(candles: Candle[], index: number, period: number) {
    if (index < period - 1) return 0;
    const start = Math.max(0, index - period * 3);
    const k = 2 / (period + 1);
    let value = candles[start].c;
    for (let i = start + 1; i <= index; i++) {
      value = candles[i].c * k + value * (1 - k);
    }
    return value;
  }

  private volumeRatio(candles: Candle[], index: number, period: number) {
    const start = Math.max(0, index - period);
    const base = candles.slice(start, index);
    if (!base.length) return 1;
    const avg = base.reduce((s, c) => s + c.v, 0) / base.length;
    return avg > 0 ? candles[index].v / avg : 1;
  }

  private maxLeverageForSymbol(symbol: string): number {
    const market = this.fastExchange.markets?.[symbol];
    return Number(market?.limits?.leverage?.max ?? 125) || 125;
  }

  private spreadPct(ticker: any) {
    const bid = Number(ticker.bid ?? ticker.info?.bid1 ?? 0);
    const ask = Number(ticker.ask ?? ticker.info?.ask1 ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(ticker.last ?? ticker.close ?? 0);
    return bid > 0 && ask > 0 && mid > 0 ? (ask - bid) / mid * 100 : 0;
  }

  private feeRateForSymbol(symbol: string, fallback: number) {
    const fromTable = this.feeBySymbol.has(symbol) ? Number(this.feeBySymbol.get(symbol)) : NaN;
    const raw = Number.isFinite(fromTable) ? fromTable : Number(fallback ?? 0.0006);
    return Math.max(raw || 0, 0.0006);
  }

  private feeRateForTrade(trade: any) {
    const stored = Number(trade.feeRate ?? 0);
    const fromTable = this.feeBySymbol.has(trade.symbol) ? Number(this.feeBySymbol.get(trade.symbol)) : 0;
    return Math.max(stored, fromTable, 0.0006);
  }

  private normalizeTradePnl(trade: any) {
    const feeRate = this.feeRateForTrade(trade);
    if (trade.status === 'open') {
      const openFee = Number(trade.fees ?? 0) > 0 ? Number(trade.fees) : trade.positionSize * feeRate;
      return {
        ...trade,
        feeRate,
        fees: Number(openFee.toFixed(6)),
      };
    }

    const closePrice = Number(trade.closePrice ?? (trade.status === 'tp1' ? trade.takeProfit1 : trade.stopLoss));
    if (!closePrice || !trade.entry || !trade.positionSize) return trade;

    const isLong = trade.direction === 'LONG';
    const priceDiff = isLong
      ? (closePrice - trade.entry) / trade.entry
      : (trade.entry - closePrice) / trade.entry;
    const totalFees = trade.positionSize * feeRate * 2;
    const pnl = trade.positionSize * priceDiff - totalFees;

    return {
      ...trade,
      closePrice: this.price(closePrice),
      feeRate,
      fees: Number(totalFees.toFixed(6)),
      pnl: Number(pnl.toFixed(4)),
      capitalAfter: Number((trade.capitalBefore + pnl).toFixed(4)),
    };
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
    this.events.emitImpulse100Status({
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
      lastError: this.lastError,
      debug: { ...this.debug },
      feeTableSymbols: this.feeBySymbol.size,
      zeroFeeSymbols: this.zeroFeeSymbols.size,
    };
  }

  async getTrades(limit = 200) {
    const trades = await this.prisma.impulse100SimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
    return trades.map(t => this.normalizeTradePnl(t));
  }

  async getAnalytics() {
    const cfg = await this.ensureConfig();
    const rawTrades = await this.prisma.impulse100SimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' },
    });
    const trades = rawTrades.map(t => this.normalizeTradePnl(t));
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
      'startingCapital', 'riskUsdt', 'tpRr', 'leverage', 'maxMarginUsdt', 'maxConcurrent',
      'maxSignalsPerScan', 'enabled', 'autoEnter', 'liveEnabled', 'minScore',
      'topPairs', 'breakLookback', 'minBodyRangeRatio', 'maxCloseWickRange',
      'maxOppositeWickRange', 'minRangeAtr', 'maxRangeAtr', 'minSlPct', 'maxSlPct',
      'maxSpreadPct', 'minVolume24h', 'cooldownMinutes', 'feeRate',
    ];
    const patch: any = {};
    for (const key of allowed) {
      if (data[key] !== undefined) patch[key] = data[key];
    }
    return this.prisma.impulse100Config.update({ where: { id: 1 }, data: patch });
  }

  async resetSim() {
    await this.prisma.impulse100SimulatedTrade.deleteMany({});
    this.recentSignals = [];
    this.cooldowns.clear();
    this.emittedIds.clear();
    return { ok: true };
  }
}
