import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { IntraSimulationService } from './intra-simulation.service';

export interface IntraSignal {
  id: string;
  symbol: string;
  direction: 'LONG';
  entry: number;
  pumpCandle4hPct: number;
  distToEma34: number;
  trigBodyRatio: number;
  trigVolRatio: number;
  ema34_4h: number;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  quoteVolume24h: number;
  timestamp: string;
  mexcUrl: string;
}

const MIN_VOLUME_24H = 200_000;
const TOP_CANDIDATES = 50;
const CANDLES_4H     = 200;
const MIN_PUMP_PCT   = 8.0;
const SIGNAL_COOLDOWN = 4 * 60 * 60 * 1000; // one signal per symbol per 4h

@Injectable()
export class IntraScannerService implements OnModuleInit {
  private readonly logger = new Logger(IntraScannerService.name);
  private exchange: ccxt.mexc;
  private validFuturesSymbols = new Set<string>();
  private recentSignals: IntraSignal[] = [];
  private isScanning   = false;
  private lastScanAt: string | null = null;
  private scannedCount = 0;
  private lastSignalAt = new Map<string, number>();

  constructor(
    private config: ConfigService,
    private indicators: IndicatorsService,
    private events: EventsGateway,
    private intraSimulation: IntraSimulationService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get('MEXC_API_KEY', '');
    const secret = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options:         { defaultType: 'swap' },
    });
    await this.loadFuturesSymbols();
  }

  private async loadFuturesSymbols() {
    try {
      const markets = await this.exchange.loadMarkets();
      for (const [symbol, market] of Object.entries(markets)) {
        if ((market as any).swap && symbol.endsWith('/USDT:USDT')) {
          this.validFuturesSymbols.add(symbol);
        }
      }
      this.logger.log(`[INTRA] Loaded ${this.validFuturesSymbols.size} futures symbols`);
    } catch (e: any) {
      this.logger.error(`[INTRA] Failed to load markets: ${e?.message}`);
    }
  }

  @Cron('10 */5 * * * *')
  async scan() {
    if (this.isScanning) return;
    this.isScanning = true;
    this.scannedCount = 0;

    try {
      const tickers = await this.exchange.fetchTickers();
      const candidates = Object.values(tickers)
        .filter((t: any) =>
          t.symbol?.endsWith('/USDT:USDT') &&
          this.validFuturesSymbols.has(t.symbol) &&
          (t.quoteVolume ?? 0) >= MIN_VOLUME_24H,
        )
        .sort((a: any, b: any) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
        .slice(0, TOP_CANDIDATES);

      for (const ticker of candidates) {
        await this.analyzePair(ticker.symbol, ticker.last ?? 0, ticker.quoteVolume ?? 0);
        await new Promise((r) => setTimeout(r, 120));
        this.scannedCount++;
      }

      this.lastScanAt = new Date().toISOString();
      this.logger.log(`[INTRA] Scan done: ${this.scannedCount} pairs`);
    } catch (e: any) {
      this.logger.error(`[INTRA] Scan error: ${e?.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  private async analyzePair(symbol: string, livePrice: number, volume24h: number): Promise<void> {
    const lastAt = this.lastSignalAt.get(symbol) ?? 0;
    if (Date.now() - lastAt < SIGNAL_COOLDOWN) return;

    try {
      const ohlcv4h = await this.exchange.fetchOHLCV(symbol, '4h', undefined, CANDLES_4H);
      if (!ohlcv4h || ohlcv4h.length < 60) return;

      const n  = ohlcv4h.length;
      const o4 = ohlcv4h.map((c) => c[1]!);
      const h4 = ohlcv4h.map((c) => c[2]!);
      const l4 = ohlcv4h.map((c) => c[3]!);
      const c4 = ohlcv4h.map((c) => c[4]!);
      const v4 = ohlcv4h.map((c) => c[5]!);

      // EMA34 at trigger candle (n-2)
      const ema34Arr = this.indicators.emaArray(c4, 34);
      if (ema34Arr.length < 2) return;
      const ema34 = ema34Arr.at(-2)!;
      if (!ema34 || ema34 <= 0) return;

      // ── LAYER 1: Pump — bullish candle ≥ 8% body in last 15 closed bars ──────
      let pumpPct = 0;
      let pumpIdx = -1;
      for (let i = n - 17; i <= n - 3; i++) {
        if (i < 0 || c4[i] <= o4[i]) continue;
        const body = (c4[i] - o4[i]) / o4[i] * 100;
        if (body >= MIN_PUMP_PCT && body > pumpPct) { pumpPct = body; pumpIdx = i; }
      }
      if (pumpIdx < 0) return;

      // ── LAYER 2: Retest — price consolidated near EMA34 after pump ───────────
      // Retest più stretto: price deve avvicinarsi entro 1.5% dall'EMA34 (era 3%)
      let retestFound  = false;
      let minDistToEma = Infinity;
      for (let i = pumpIdx + 1; i <= n - 2; i++) {
        const distLow   = (l4[i] - ema34) / ema34 * 100;
        const distClose = Math.abs(c4[i] - ema34) / ema34 * 100;
        if (distLow <= 1.5 || distClose <= 1.5) retestFound = true;
        if (distClose < minDistToEma) minDistToEma = distClose;
      }
      if (!retestFound) return;

      // ── LAYER 3: Trigger — last closed 4H candle bullish & above EMA34 ───────
      const trigIdx = n - 2;
      const trigO = o4[trigIdx], trigC = c4[trigIdx];
      const trigH = h4[trigIdx], trigL = l4[trigIdx];

      if (trigC <= trigO) return;
      const trigRange = trigH - trigL;
      if (trigRange <= 0) return;
      const trigBody = (trigC - trigO) / trigRange;
      if (trigBody < 0.25) return;
      if (trigC <= ema34) return;

      // Volume: trigger vs 20-bar average
      const refLen = Math.min(20, trigIdx);
      let refVolSum = 0;
      for (let i = trigIdx - refLen; i < trigIdx; i++) {
        if (i >= 0) refVolSum += v4[i];
      }
      const refAvgVol = refLen > 0 ? refVolSum / refLen : v4[trigIdx];
      const trigVolR  = refAvgVol > 0 ? v4[trigIdx] / refAvgVol : 1;

      // ── Entry: anti-chase stretto — live price within 0.8% above trigger close ─
      const entry  = livePrice > 0 ? livePrice : trigC;
      const chaseD = (entry - trigC) / trigC * 100;
      if (chaseD > 0.8 || chaseD < -2.0) return;
      if (entry <= ema34) return;
      // Entry non deve essere troppo lontana da EMA34 (max 2%)
      if ((entry - ema34) / ema34 * 100 > 2.0) return;

      // ── Scoring ───────────────────────────────────────────────────────────────
      let score = 0;
      score += pumpPct >= 25 ? 30 : pumpPct >= 15 ? 22 : pumpPct >= 10 ? 15 : 12;
      score += minDistToEma <= 0.5 ? 20 : minDistToEma <= 1.0 ? 17 : minDistToEma <= 2.0 ? 14 : 10;
      score += trigBody >= 0.80 ? 20 : trigBody >= 0.65 ? 16 : trigBody >= 0.50 ? 12 : 8;
      score += trigVolR >= 3.0 ? 20 : trigVolR >= 2.0 ? 15 : trigVolR >= 1.5 ? 12 : 8;

      const grade = score >= 70 ? 'A+' : score >= 50 ? 'A' : score >= 35 ? 'B' : 'C';
      if (grade === 'C') return;

      const signal: IntraSignal = {
        id:              `intra_${symbol}_${Date.now()}`,
        symbol,
        direction:       'LONG',
        entry:           parseFloat(entry.toPrecision(8)),
        pumpCandle4hPct: parseFloat(pumpPct.toFixed(2)),
        distToEma34:     parseFloat(minDistToEma.toFixed(3)),
        trigBodyRatio:   parseFloat(trigBody.toFixed(3)),
        trigVolRatio:    parseFloat(trigVolR.toFixed(2)),
        ema34_4h:        parseFloat(ema34.toPrecision(8)),
        score,
        grade:           grade as any,
        quoteVolume24h:  volume24h,
        timestamp:       new Date().toISOString(),
        mexcUrl:         `https://www.mexc.com/futures/${symbol.replace('/', '_').replace(':USDT', '')}`,
      };

      this.recentSignals.unshift(signal);
      if (this.recentSignals.length > 100) this.recentSignals.pop();
      this.lastSignalAt.set(symbol, Date.now());

      this.events.emitIntraSignal(signal);
      await this.intraSimulation.enterTrade(signal);

      this.logger.log(
        `[INTRA] ${grade} ${symbol} | pump ${pumpPct.toFixed(1)}% | retest ${minDistToEma.toFixed(2)}% | score ${score}`,
      );
    } catch { /* pair unavailable */ }
  }

  getRecentSignals(limit = 50): IntraSignal[] {
    return this.recentSignals.slice(0, limit);
  }

  getStatus() {
    return {
      isScanning:   this.isScanning,
      lastScanAt:   this.lastScanAt,
      scannedCount: this.scannedCount,
      signalCount:  this.recentSignals.length,
    };
  }
}
