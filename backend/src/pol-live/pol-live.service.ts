import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';

const SOURCE = 'POL_ZERO';
const SYMBOL = 'POL/USDT:USDT';
const MEXC_URL = 'https://futures.mexc.com/exchange/POL_USDT';
const TF = '5m';
const TF_MS = 5 * 60 * 1000;
const CANDLES = 180;
const MAX_CLOSE_AGE_MS = 15_000;

type Direction = 'LONG' | 'SHORT';
type PolSignalType = 'BASE_BREAKOUT' | 'IMPULSE_CLOSE';

interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface PolSignal {
  id: string;
  symbol: string;
  direction: Direction;
  signalType: PolSignalType;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  slPct: number;
  tpPct: number;
  riskUsdt: number;
  rewardUsdt: number;
  positionSize: number;
  marginUsdt: number;
  leverage: number;
  spreadPct: number;
  bodyRangeRatio: number;
  closeWickRange: number;
  oppositeWickRange: number;
  rangeAtr: number;
  baseRangePct: number;
  score: number;
  grade: 'A+' | 'A' | 'B';
  reasons: string[];
  timestamp: string;
  candleCloseAgeMs: number;
  mexcUrl: string;
}

@Injectable()
export class PolLiveService implements OnModuleInit {
  private readonly logger = new Logger(PolLiveService.name);
  private exchange: ccxt.mexc;
  private recentSignals: PolSignal[] = [];
  private isScanning = false;
  private lastScanAt: string | null = null;
  private lastSignalAt: string | null = null;
  private lastError: string | null = null;
  private lastMarket: any = null;
  private processedCandleTs = 0;
  private debug: Record<string, number> = {};

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private live: LiveTradingService,
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
    await this.ensureConfig();
    this.logger.log('[POL] zero-fee live section ready on POL/USDT 5m');
  }

  @Cron('*/2 * * * * *')
  async scan() {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      const cfg = await this.ensureConfig();
      if (!cfg.enabled) return;

      const signal = await this.analyze(cfg);
      this.lastScanAt = new Date().toISOString();
      if (!signal) return;

      if (signal.candleCloseAgeMs > MAX_CLOSE_AGE_MS) {
        this.bump('late_close');
        return;
      }
      if (this.processedCandleTs === new Date(signal.timestamp).getTime()) return;
      this.processedCandleTs = new Date(signal.timestamp).getTime();

      this.recentSignals.unshift(signal);
      if (this.recentSignals.length > 100) this.recentSignals.pop();
      this.lastSignalAt = new Date().toISOString();

      this.logger.log(
        `[POL] ${signal.grade} ${signal.signalType} ${signal.direction} entry=${signal.entry} SL=${signal.stopLoss} TP=${signal.takeProfit} risk=${signal.riskUsdt}`,
      );

      if (cfg.liveEnabled) {
        await this.live.enterTrade({
          symbol: signal.symbol,
          direction: signal.direction,
          grade: signal.grade,
          entry: signal.entry,
          slPct: signal.slPct,
          tp1Pct: signal.tpPct,
          suggestedLeverage: signal.leverage,
          score: signal.score,
          stopLossPrice: signal.stopLoss,
          takeProfitPrice: signal.takeProfit,
          riskUsdt: cfg.riskUsdt,
          feeRate: 0,
          source: SOURCE,
          sourceMaxConcurrent: cfg.maxConcurrent,
          bypassGlobalConfig: true,
        });
      }
    } catch (err: any) {
      this.lastError = err?.message ?? String(err);
      this.bump('error');
      this.logger.warn(`[POL] scan: ${this.lastError}`);
    } finally {
      this.isScanning = false;
    }
  }

  private async ensureConfig() {
    const existing = await this.prisma.polLiveConfig.findUnique({ where: { id: 1 } });
    if (existing) return existing;
    return this.prisma.polLiveConfig.create({
      data: {
        id: 1,
        enabled: true,
        liveEnabled: false,
        symbol: SYMBOL,
        riskUsdt: 2,
        tpRr: 2,
        leverage: 50,
        maxConcurrent: 1,
      },
    });
  }

  private async analyze(cfg: any): Promise<PolSignal | null> {
    const [raw, market] = await Promise.all([
      this.retry(() => this.exchange.fetchOHLCV(SYMBOL, TF, undefined, CANDLES), 'ohlcv'),
      this.fetchMarket(),
    ]);
    this.lastMarket = market;

    if (!raw || raw.length < 60) return null;
    const candles = raw.map((r) => ({
      t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]),
    }));
    const closed = this.lastClosedIndex(candles);
    if (!closed) return null;

    const { i, closeAgeMs } = closed;
    const trigger = candles[i];
    const isLong = trigger.c > trigger.o;
    const isShort = trigger.c < trigger.o;
    if (!isLong && !isShort) return this.reject('doji');

    const dir: Direction = isLong ? 'LONG' : 'SHORT';
    const range = trigger.h - trigger.l;
    const body = Math.abs(trigger.c - trigger.o);
    if (range <= 0 || body <= 0) return this.reject('empty');

    const bodyRatio = body / range;
    const closeWick = isLong ? trigger.h - trigger.c : trigger.c - trigger.l;
    const oppositeWick = isLong ? trigger.o - trigger.l : trigger.h - trigger.o;
    const closeWickRatio = closeWick / range;
    const oppositeWickRatio = oppositeWick / range;

    if (bodyRatio < cfg.minBodyRangeRatio) return this.reject('body');
    if (closeWickRatio > cfg.maxCloseWickRange) return this.reject('close_wick');
    if (oppositeWickRatio > cfg.maxOppositeWickRange) return this.reject('opposite_wick');
    if (market.spreadPct > cfg.maxSpreadPct) return this.reject('spread');

    const atr = this.atr(candles, i, 14);
    if (!atr || atr <= 0) return this.reject('atr');
    const rangeAtr = range / atr;
    if (rangeAtr < cfg.minRangeAtr) return this.reject('range_atr');

    const lookback = Math.max(5, Math.min(24, cfg.breakoutLookback ?? 10));
    const base = candles.slice(i - lookback, i);
    if (base.length < lookback) return null;

    const baseHigh = Math.max(...base.map(c => c.h));
    const baseLow = Math.min(...base.map(c => c.l));
    const baseRange = baseHigh - baseLow;
    const baseRangePct = baseRange / trigger.c * 100;
    const atrPct = atr / trigger.c * 100;
    const compressed = baseRangePct <= Math.max(atrPct * 3.2, 0.28);

    const baseBreakLong = isLong && compressed && trigger.c > baseHigh && trigger.o <= baseHigh * 1.004;
    const baseBreakShort = isShort && compressed && trigger.c < baseLow && trigger.o >= baseLow * 0.996;

    const recent = candles.slice(i - 4, i);
    const recentHigh = Math.max(...recent.map(c => c.h));
    const recentLow = Math.min(...recent.map(c => c.l));
    const impulseLong = isLong && trigger.c > recentHigh && rangeAtr >= 0.75;
    const impulseShort = isShort && trigger.c < recentLow && rangeAtr >= 0.75;

    const isBaseBreak = baseBreakLong || baseBreakShort;
    const isImpulse = impulseLong || impulseShort;
    if (!isBaseBreak && !isImpulse) return this.reject('breakout');

    const signalType: PolSignalType = isBaseBreak ? 'BASE_BREAKOUT' : 'IMPULSE_CLOSE';
    const stopRaw = isBaseBreak
      ? (isLong ? Math.min(trigger.o, baseLow) : Math.max(trigger.o, baseHigh))
      : trigger.o;
    const entry = trigger.c;
    const stopLoss = stopRaw;
    const riskDist = Math.abs(entry - stopLoss);
    const slPct = riskDist / entry * 100;
    if (slPct < cfg.minSlPct) return this.reject('sl_small');
    if (slPct > cfg.maxSlPct) return this.reject('sl_big');

    const tpDist = riskDist * cfg.tpRr;
    const takeProfit = isLong ? entry + tpDist : entry - tpDist;
    const tpPct = slPct * cfg.tpRr;
    const positionSize = cfg.riskUsdt / (slPct / 100);
    const marginUsdt = positionSize / cfg.leverage;

    const score = this.score({
      signalType, bodyRatio, closeWickRatio, oppositeWickRatio, rangeAtr, baseRangePct, atrPct, compressed,
    });
    if (score < 78) return this.reject('score');

    const grade: PolSignal['grade'] = score >= 92 ? 'A+' : score >= 84 ? 'A' : 'B';
    return {
      id: `POL_${trigger.t}`,
      symbol: SYMBOL,
      direction: dir,
      signalType,
      entry: this.roundPrice(entry),
      stopLoss: this.roundPrice(stopLoss),
      takeProfit: this.roundPrice(takeProfit),
      slPct: Number(slPct.toFixed(4)),
      tpPct: Number(tpPct.toFixed(4)),
      riskUsdt: Number(cfg.riskUsdt.toFixed(2)),
      rewardUsdt: Number((cfg.riskUsdt * cfg.tpRr).toFixed(2)),
      positionSize: Number(positionSize.toFixed(4)),
      marginUsdt: Number(marginUsdt.toFixed(4)),
      leverage: cfg.leverage,
      spreadPct: Number(market.spreadPct.toFixed(4)),
      bodyRangeRatio: Number(bodyRatio.toFixed(3)),
      closeWickRange: Number(closeWickRatio.toFixed(3)),
      oppositeWickRange: Number(oppositeWickRatio.toFixed(3)),
      rangeAtr: Number(rangeAtr.toFixed(3)),
      baseRangePct: Number(baseRangePct.toFixed(3)),
      score,
      grade,
      reasons: [
        signalType === 'BASE_BREAKOUT' ? 'base rotta' : 'impulso pulito',
        `body ${(bodyRatio * 100).toFixed(0)}%`,
        `wick close ${(closeWickRatio * 100).toFixed(1)}%`,
        `wick opp ${(oppositeWickRatio * 100).toFixed(1)}%`,
        `RR ${cfg.tpRr.toFixed(1)}R`,
      ],
      timestamp: new Date(trigger.t).toISOString(),
      candleCloseAgeMs: closeAgeMs,
      mexcUrl: MEXC_URL,
    };
  }

  private score(x: {
    signalType: PolSignalType;
    bodyRatio: number;
    closeWickRatio: number;
    oppositeWickRatio: number;
    rangeAtr: number;
    baseRangePct: number;
    atrPct: number;
    compressed: boolean;
  }) {
    let pts = x.signalType === 'BASE_BREAKOUT' ? 22 : 16;
    pts += x.bodyRatio >= 0.88 ? 24 : x.bodyRatio >= 0.80 ? 19 : 14;
    pts += x.closeWickRatio <= 0.015 ? 18 : x.closeWickRatio <= 0.03 ? 14 : 8;
    pts += x.oppositeWickRatio <= 0.025 ? 20 : x.oppositeWickRatio <= 0.05 ? 15 : 8;
    pts += x.rangeAtr >= 1.2 ? 15 : x.rangeAtr >= 0.8 ? 11 : 6;
    if (x.compressed) pts += 10;
    if (x.baseRangePct <= Math.max(x.atrPct * 2.4, 0.22)) pts += 6;
    return Math.min(100, pts);
  }

  private lastClosedIndex(candles: Candle[]) {
    const now = Date.now();
    let i = candles.length - 1;
    if (now < candles[i].t + TF_MS + 1_000) i -= 1;
    if (i < 40) return null;
    return { i, closeAgeMs: now - (candles[i].t + TF_MS) };
  }

  private async fetchMarket() {
    const ticker = await this.retry(() => this.exchange.fetchTicker(SYMBOL), 'ticker');
    const bid = Number(ticker.bid ?? ticker.info?.bid1 ?? 0);
    const ask = Number(ticker.ask ?? ticker.info?.ask1 ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(ticker.last ?? 0);
    const spreadPct = bid > 0 && ask > 0 && mid > 0 ? (ask - bid) / mid * 100 : 999;
    return {
      last: Number(ticker.last ?? 0),
      bid,
      ask,
      spreadPct,
      amount24: Number(ticker.quoteVolume ?? ticker.info?.amount24 ?? 0),
      fundingRate: Number(ticker.info?.fundingRate ?? 0),
      ts: Date.now(),
    };
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

  private async retry<T>(fn: () => Promise<T>, label: string, tries = 3): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        if (i < tries - 1) await new Promise(r => setTimeout(r, 250 + i * 250));
      }
    }
    throw new Error(`${label}: ${lastErr?.message ?? lastErr}`);
  }

  private roundPrice(value: number) {
    return Number(value.toFixed(5));
  }

  private reject(reason: string): null {
    this.bump(reason);
    return null;
  }

  private bump(key: string) {
    this.debug[key] = (this.debug[key] ?? 0) + 1;
  }

  async getStatus() {
    const cfg = await this.ensureConfig();
    return {
      source: SOURCE,
      symbol: SYMBOL,
      timeframe: TF,
      lastScanAt: this.lastScanAt,
      lastSignalAt: this.lastSignalAt,
      isScanning: this.isScanning,
      lastError: this.lastError,
      market: this.lastMarket,
      debug: this.debug,
      config: cfg,
    };
  }

  getSignals(limit = 50) {
    return this.recentSignals.slice(0, limit);
  }

  async getTrades(limit = 100) {
    return this.prisma.liveTrade.findMany({
      where: { symbol: SYMBOL, note: { startsWith: SOURCE } },
      orderBy: { openedAt: 'desc' },
      take: limit,
    });
  }

  async getAnalytics() {
    const trades = await this.prisma.liveTrade.findMany({
      where: { symbol: SYMBOL, note: { startsWith: SOURCE } },
      orderBy: { openedAt: 'asc' },
    });
    const open = trades.filter(t => ['open', 'pending'].includes(t.status));
    const closedWithPnl = trades.filter(t => !['open', 'pending', 'error', 'expired'].includes(t.status) && t.pnl !== null);
    const wins = closedWithPnl.filter(t => (t.pnl ?? 0) > 0);
    const losses = closedWithPnl.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closedWithPnl.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees = closedWithPnl.reduce((s, t) => s + (t.feesOpen ?? 0) + (t.feesClose ?? 0), 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length) : 0;
    return {
      totalTrades: trades.length,
      openTrades: open.length,
      closedTrades: closedWithPnl.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closedWithPnl.length ? Number((wins.length / closedWithPnl.length * 100).toFixed(1)) : null,
      totalPnl: Number(totalPnl.toFixed(4)),
      totalFees: Number(totalFees.toFixed(6)),
      avgWin: Number(avgWin.toFixed(4)),
      avgLoss: Number(avgLoss.toFixed(4)),
      rrActual: avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : null,
    };
  }

  async updateConfig(data: any) {
    const patch: any = {};
    for (const key of [
      'enabled', 'liveEnabled', 'riskUsdt', 'tpRr', 'leverage', 'maxConcurrent',
      'minBodyRangeRatio', 'maxCloseWickRange', 'maxOppositeWickRange',
      'minRangeAtr', 'minSlPct', 'maxSlPct', 'maxSpreadPct', 'breakoutLookback',
    ]) {
      if (data[key] !== undefined) patch[key] = data[key];
    }
    return this.prisma.polLiveConfig.update({ where: { id: 1 }, data: patch });
  }

  async getCandles(symbol: string, limit = 120) {
    try {
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, limit + 1) as number[][];
      return ohlcv.slice(0, -1).map(c => ({
        time: Math.floor(c[0] / 1000),
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));
    } catch { return []; }
  }
}
