import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ─── Interfacce ───────────────────────────────────────────────────────────────

export interface SqzSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  patternType: 1 | 2;              // 1=SQZ_BREAK, 2=RSI_BOUNCE
  signalType: 'SQZ_BREAK' | 'RSI_BOUNCE';
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  slPct: number;
  tp1Pct: number;
  tp2Pct: number;
  suggestedLeverage: number;
  volumeRatio: number;
  rsi: number;
  bbWidth: number;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[];
  timestamp: string;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema9spark: number[];
  ema20spark: number[];
  bbUpperSpark: number[];
  bbLowerSpark: number[];
}

// ─── Costanti ─────────────────────────────────────────────────────────────────
// Strategia: SQZ Scalper — BB Squeeze Breakout + RSI(3) Extreme Bounce
// BB squeeze: banda < 2.5% del prezzo → compressione della volatilità
// Breakout confermato da volume ≥2.5× e chiusura oltre la banda superiore/inferiore
// RSI(3): rimbalzo da estremi (<15 / >85) con conferma direzionale EMA

const MIN_VOLUME_24H  = 3_000_000;
const TOP_CANDIDATES  = 100;
const CANDLES_1M      = 100;
const BB_PERIOD       = 20;
const BB_STD          = 2.0;
const SQZ_LB          = 20;        // lookback per rilevare il squeeze
const RSI_PERIOD      = 3;
const MAX_SL_PCT      = 1.5;
const MIN_SL_PCT      = 0.08;
const ATR_SL_MULT     = 0.55;
const TP1_RR          = 1.8;
const TP2_RR          = 3.0;
const BODY_MIN        = 0.25;
const VOL_SQZ_MIN     = 2.5;
const VOL_RSI_MIN     = 1.2;
const SIGNAL_COOLDOWN = 180_000;
const MAX_PER_CYCLE   = 5;
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 0.50;
const MIN_SCORE       = 38;

@Injectable()
export class SqzScannerService implements OnModuleInit {
  private readonly logger = new Logger(SqzScannerService.name);
  private exchange: ccxt.mexc;
  private validFuturesSymbols = new Set<string>();
  private recentSignals: SqzSignal[] = [];
  private isScanning     = false;
  private lastScanAt:    string | null = null;
  private scannedCount   = 0;
  private lastRawSignals = 0;
  private lastEmitted    = 0;
  private dbg: Record<string, number> = {};
  private cooldowns = new Map<string, number>();

  constructor(
    private config: ConfigService,
    private indicators: IndicatorsService,
    private events: EventsGateway,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get('MEXC_API_KEY', '');
    const secret = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await this.loadFuturesMarkets();
    this.logger.log(`SqzScanner: ${this.validFuturesSymbols.size} coppie futures USDT`);
    await this.initConfig();
  }

  @Cron('0 0 * * * *')
  async loadFuturesMarkets() {
    try {
      const markets = await this.exchange.loadMarkets(true);
      this.validFuturesSymbols = new Set(
        Object.keys(markets).filter((s) => s.endsWith('/USDT:USDT')),
      );
    } catch (err) {
      this.logger.error(`loadFuturesMarkets: ${err.message}`);
    }
  }

  @Cron('40 */1 * * * *')   // ogni minuto, 40s offset (flex=20s, sqz=40s)
  async scan() {
    if (this.isScanning || this.validFuturesSymbols.size === 0) return;
    this.isScanning = true;
    try {
      const tickers = await this.exchange.fetchTickers([...this.validFuturesSymbols]);
      const openSymbols = await this.getOpenSymbolsSet();

      const pool = Object.values(tickers).filter(
        (t) =>
          this.validFuturesSymbols.has(t.symbol) &&
          (t.quoteVolume ?? 0) >= MIN_VOLUME_24H &&
          !openSymbols.has(t.symbol),
      );
      const shuffled   = pool.slice().sort(() => Math.random() - 0.5);
      const candidates = shuffled.slice(0, TOP_CANDIDATES);
      this.scannedCount = this.validFuturesSymbols.size;
      this.dbg = {};

      const cycleSignals: SqzSignal[] = [];
      for (const ticker of candidates) {
        const sig = await this.analyzePair(ticker);
        if (sig) cycleSignals.push(sig);
        await new Promise((r) => setTimeout(r, 60));
      }
      this.lastRawSignals = cycleSignals.length;

      const longs  = cycleSignals.filter((s) => s.direction === 'LONG')
                                  .sort((a, b) => b.score - a.score).slice(0, MAX_PER_CYCLE);
      const shorts = cycleSignals.filter((s) => s.direction === 'SHORT')
                                  .sort((a, b) => b.score - a.score).slice(0, MAX_PER_CYCLE);
      const best   = [...longs, ...shorts];

      let emitted = 0;
      for (const sig of best) {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        if (Date.now() - last < SIGNAL_COOLDOWN) continue;
        this.cooldowns.set(sig.symbol, Date.now());

        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 300) this.recentSignals.pop();

        this.events.server.emit('sqz:signal', sig);
        await this.enterSimTrade(sig).catch(() => {});
        emitted++;

        this.logger.log(
          `[SQZ ${sig.grade}] ${sig.direction} ${sig.symbol} ${sig.signalType} | score ${sig.score} | SL ${sig.slPct.toFixed(2)}% TP1 ${sig.tp1Pct.toFixed(2)}%`,
        );
      }
      this.lastEmitted = emitted;
      this.lastScanAt  = new Date().toISOString();

      this.events.server.emit('sqz:status', {
        lastScanAt:   this.lastScanAt,
        scannedPairs: this.scannedCount,
        candidates:   candidates.length,
        rawSignals:   this.lastRawSignals,
        emitted:      this.lastEmitted,
        isScanning:   false,
        debug:        { ...this.dbg },
      });
    } catch (err) {
      this.logger.error(`SqzScan: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  @Cron('*/10 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.sqzSimulatedTrade.findMany({ where: { status: 'open' } });
      if (!open.length) return;
      const cfg = await this.getConfig();

      for (const t of open) {
        try {
          const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 3);
          if (!ohlcv.length) continue;
          const curr = ohlcv.at(-1)![4] as number;

          const isLong           = t.direction === 'LONG';
          const unrealizedPnl    = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const unrealizedPnlPct = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100;

          this.events.server.emit('sqz:positions', [{
            id: t.id, currentPrice: curr,
            unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(4)),
            unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
          }]);

          const hitSL  = isLong ? curr <= t.stopLoss    : curr >= t.stopLoss;
          const hitTP1 = isLong ? curr >= t.takeProfit1 : curr <= t.takeProfit1;
          const hitTP2 = isLong ? curr >= t.takeProfit2 : curr <= t.takeProfit2;
          if (!hitSL && !hitTP1 && !hitTP2) continue;

          const status     = hitTP2 ? 'tp2' : hitTP1 ? 'tp1' : 'sl';
          const closePrice = hitTP2 ? t.takeProfit2 : hitTP1 ? t.takeProfit1 : t.stopLoss;
          const pnlRaw     = (closePrice - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const fee        = (t.positionSize + Math.abs(pnlRaw)) * TAKER_FEE;
          const pnl        = pnlRaw - fee;
          const capitalAfter = t.capitalBefore + pnl;

          await this.prisma.sqzSimulatedTrade.update({
            where: { id: t.id },
            data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(fee.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
          });
          if (cfg.autoEnter) {
            await this.prisma.sqzSimConfig.update({ where: { id: 1 }, data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) } });
          }
          const updated = await this.prisma.sqzSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.server.emit('sqz:trade', updated);
          this.logger.log(`[SQZ CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err) {
      this.logger.error(`checkOpenTrades: ${err.message}`);
    }
  }

  // ─── SQZ SCALPER STRATEGY ─────────────────────────────────────────────────
  // BB Squeeze Breakout: banda compressa → breakout con volume forte
  // RSI(3) Bounce:       RSI estremo (<15/>85) + conferma direzionale EMA

  private async analyzePair(ticker: ccxt.Ticker): Promise<SqzSignal | null> {
    try {
      const sym   = ticker.symbol;
      const raw1m = await this.exchange.fetchOHLCV(sym, '1m', undefined, CANDLES_1M);
      if (raw1m.length < 30) {
        this.dbg['L0_no_data'] = (this.dbg['L0_no_data'] ?? 0) + 1; return null;
      }

      const op = raw1m.map((c) => c[1] as number);
      const hi = raw1m.map((c) => c[2] as number);
      const lo = raw1m.map((c) => c[3] as number);
      const cl = raw1m.map((c) => c[4] as number);
      const vo = raw1m.map((c) => c[5] as number);
      const n  = cl.length;

      // ─── Indicatori base ──────────────────────────────────────────────────
      const e9arr  = this.indicators.emaArray(cl, 9);
      const e20arr = this.indicators.emaArray(cl, 20);
      const e50arr = this.indicators.emaArray(cl, 50);
      if (e50arr.length < 5) return null;

      const e9  = e9arr.at(-1)!;
      const e20 = e20arr.at(-1)!;
      const e50 = e50arr.at(-1)!;

      const rsiArr = this.indicators.rsiArray(cl, RSI_PERIOD);
      if (rsiArr.length < 2) return null;
      const rsi  = rsiArr.at(-1)!;
      const rsiP = rsiArr.at(-2)!;

      // Volume ratio
      const refVols   = vo.slice(n - 22, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const volR      = refAvgVol > 0 ? vo[n - 2] / refAvgVol : 1;

      // ATR
      const atrVal = this.indicators.atr(hi, lo, cl, 14);

      // ─── BB Squeeze (inline) ──────────────────────────────────────────────
      const bandwidths: number[] = [];
      const bbUpperArr: number[] = [];
      const bbLowerArr: number[] = [];
      const startIdx = Math.max(BB_PERIOD - 1, n - SQZ_LB - BB_PERIOD - 2);
      for (let j = startIdx; j < n; j++) {
        const sl = cl.slice(j - BB_PERIOD + 1, j + 1);
        const mu = sl.reduce((a, b) => a + b, 0) / BB_PERIOD;
        const std = Math.sqrt(sl.reduce((a, b) => a + (b - mu) ** 2, 0) / BB_PERIOD);
        bbUpperArr.push(mu + BB_STD * std);
        bbLowerArr.push(mu - BB_STD * std);
        bandwidths.push(mu > 0 ? ((mu + BB_STD * std) - (mu - BB_STD * std)) / mu : 0);
      }
      const bwSetup  = bandwidths.at(-2) ?? 0;
      const bwMin    = Math.min(...bandwidths.slice(0, -2));
      const isSqz    = bwSetup <= bwMin * 1.10 && bwSetup < 0.025;
      const bbWidth  = bwSetup * 100;
      const bbNowU   = bbUpperArr.at(-1)!;
      const bbNowL   = bbLowerArr.at(-1)!;

      // ─── Body helper ──────────────────────────────────────────────────────
      const bdy = (i: number) => {
        const range = hi[i] - lo[i]; return range > 0 ? Math.abs(cl[i] - op[i]) / range : 0;
      };

      // ─── SL helper ────────────────────────────────────────────────────────
      const calcSl = (isLong: boolean): number => {
        const raw = isLong
          ? Math.min(lo[n - 2], lo[n - 1]) - atrVal * ATR_SL_MULT
          : Math.max(hi[n - 2], hi[n - 1]) + atrVal * ATR_SL_MULT;
        return raw;
      };

      // ═══ PATTERN 1: SQZ_BREAK ════════════════════════════════════════════
      // BB in squeeze → breakout candle rompe la banda con volume forte
      if (isSqz) {
        const entry = cl[n - 1];

        if (cl[n - 1] > op[n - 1] && cl[n - 1] > bbNowU && bdy(n - 1) >= BODY_MIN && volR >= VOL_SQZ_MIN && e9 > e50) {
          const sl     = calcSl(true);
          const slPct  = Math.max(Math.abs(entry - sl) / entry * 100, MIN_SL_PCT);
          if (slPct <= MAX_SL_PCT) {
            const tp1Pct = slPct * TP1_RR;
            const tp2Pct = slPct * TP2_RR;
            let score = 0; const reasons: string[] = [];
            score += 25; reasons.push('BB Squeeze breakout LONG');
            if (volR >= 4)   { score += 22; reasons.push(`Vol ×${volR.toFixed(1)}`); }
            else if (volR >= 3) { score += 16; }
            else if (volR >= VOL_SQZ_MIN) { score += 10; }
            const rsiDist = Math.abs(rsi - 50);
            if (rsiDist > 25) score += 20;
            else if (rsiDist > 15) score += 12;
            else score += 5;
            if (e9 > e20 && e20 > e50) { score += 14; reasons.push('EMA stack bullish'); }
            else if (e9 > e50)         { score +=  7; }
            const sqzDepth = bwMin > 0 ? (1 - bwSetup / bwMin) * 100 : 0;
            if (sqzDepth > 30) { score += 14; reasons.push(`Squeeze ${sqzDepth.toFixed(0)}%`); }
            else if (sqzDepth > 15) { score += 8; }
            if (slPct < 0.3) score += 10; else if (slPct < 0.6) score += 6;
            if (bdy(n - 1) >= 0.6) { score += 9; reasons.push('Corpo forte'); }
            else if (bdy(n - 1) >= 0.4) { score += 5; }

            this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
            if (score >= MIN_SCORE) {
              const grade: SqzSignal['grade'] = score >= 68 ? 'A+' : score >= 54 ? 'A' : score >= 42 ? 'B' : 'C';
              return this.buildSignal(sym, 'LONG', 1, 'SQZ_BREAK', entry, sl, slPct, tp1Pct, tp2Pct, volR, rsi, bbWidth, score, grade, reasons, raw1m, e9arr, e20arr, bbUpperArr, bbLowerArr);
            }
            this.dbg['F_sqz_score'] = (this.dbg['F_sqz_score'] ?? 0) + 1;
          } else { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
        } else if (cl[n - 1] < op[n - 1] && cl[n - 1] < bbNowL && bdy(n - 1) >= BODY_MIN && volR >= VOL_SQZ_MIN && e9 < e50) {
          const sl     = calcSl(false);
          const slPct  = Math.max(Math.abs(entry - sl) / entry * 100, MIN_SL_PCT);
          if (slPct <= MAX_SL_PCT) {
            const tp1Pct = slPct * TP1_RR;
            const tp2Pct = slPct * TP2_RR;
            let score = 0; const reasons: string[] = [];
            score += 25; reasons.push('BB Squeeze breakout SHORT');
            if (volR >= 4)   { score += 22; reasons.push(`Vol ×${volR.toFixed(1)}`); }
            else if (volR >= 3) { score += 16; }
            else if (volR >= VOL_SQZ_MIN) { score += 10; }
            const rsiDist = Math.abs(rsi - 50);
            if (rsiDist > 25) score += 20; else if (rsiDist > 15) score += 12; else score += 5;
            if (e9 < e20 && e20 < e50) { score += 14; reasons.push('EMA stack bearish'); }
            else if (e9 < e50)         { score +=  7; }
            const sqzDepth = bwMin > 0 ? (1 - bwSetup / bwMin) * 100 : 0;
            if (sqzDepth > 30) { score += 14; reasons.push(`Squeeze ${sqzDepth.toFixed(0)}%`); }
            else if (sqzDepth > 15) { score += 8; }
            if (slPct < 0.3) score += 10; else if (slPct < 0.6) score += 6;
            if (bdy(n - 1) >= 0.6) { score += 9; reasons.push('Corpo forte'); }
            else if (bdy(n - 1) >= 0.4) { score += 5; }

            this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
            if (score >= MIN_SCORE) {
              const grade: SqzSignal['grade'] = score >= 68 ? 'A+' : score >= 54 ? 'A' : score >= 42 ? 'B' : 'C';
              return this.buildSignal(sym, 'SHORT', 1, 'SQZ_BREAK', entry, sl, slPct, tp1Pct, tp2Pct, volR, rsi, bbWidth, score, grade, reasons, raw1m, e9arr, e20arr, bbUpperArr, bbLowerArr);
            }
            this.dbg['F_sqz_score'] = (this.dbg['F_sqz_score'] ?? 0) + 1;
          } else { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
        } else {
          this.dbg['F_sqz'] = (this.dbg['F_sqz'] ?? 0) + 1;
        }
      }

      // ═══ PATTERN 2: RSI_BOUNCE ════════════════════════════════════════════
      // RSI(3) estremo + conferma candela direzionale vicino EMA20
      const distE20L = (lo[n - 2] - e20) / e20 * 100;
      const distE20H = (e20 - hi[n - 2]) / e20 * 100;

      if (rsiP < 15 && rsi > rsiP && cl[n - 1] > op[n - 1] && bdy(n - 1) >= BODY_MIN
          && Math.abs(distE20L) < 2.0 && volR >= VOL_RSI_MIN && e9 > e20) {
        const entry = cl[n - 1];
        const sl    = calcSl(true);
        const slPct = Math.max(Math.abs(entry - sl) / entry * 100, MIN_SL_PCT);
        if (slPct <= MAX_SL_PCT) {
          const tp1Pct = slPct * TP1_RR;
          const tp2Pct = slPct * TP2_RR;
          let score = 0; const reasons: string[] = [];
          score += 18; reasons.push(`RSI(3) bounce ${rsiP.toFixed(0)}→${rsi.toFixed(0)}`);
          if (volR >= 2)   { score += 22; reasons.push(`Vol ×${volR.toFixed(1)}`); }
          else if (volR >= 1.5) { score += 14; }
          else { score += 8; }
          const rsiExt = 15 - rsiP;
          if (rsiExt > 10) { score += 20; reasons.push(`RSI estremo ${rsiP.toFixed(0)}`); }
          else if (rsiExt > 5) { score += 12; }
          else { score += 6; }
          if (e9 > e20 && e20 > e50) { score += 14; reasons.push('EMA bullish'); }
          else { score += 7; }
          const macdData = this.indicators.macd(cl, 12, 26, 9);
          if (macdData.histogram > macdData.prevHistogram) { score += 10; reasons.push('MACD↑'); }
          if (slPct < 0.3) score += 10; else if (slPct < 0.6) score += 6;
          if (bdy(n - 1) >= 0.5) { score += 9; reasons.push('Corpo solido'); }
          else if (bdy(n - 1) >= 0.35) { score += 5; }

          this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
          if (score >= MIN_SCORE) {
            const grade: SqzSignal['grade'] = score >= 68 ? 'A+' : score >= 54 ? 'A' : score >= 42 ? 'B' : 'C';
            return this.buildSignal(sym, 'LONG', 2, 'RSI_BOUNCE', entry, sl, slPct, tp1Pct, tp2Pct, volR, rsi, bbWidth, score, grade, reasons, raw1m, e9arr, e20arr, bbUpperArr, bbLowerArr);
          }
          this.dbg['F_rsi_score'] = (this.dbg['F_rsi_score'] ?? 0) + 1;
        } else { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
      } else if (rsiP > 85 && rsi < rsiP && cl[n - 1] < op[n - 1] && bdy(n - 1) >= BODY_MIN
                 && Math.abs(distE20H) < 2.0 && volR >= VOL_RSI_MIN && e9 < e20) {
        const entry = cl[n - 1];
        const sl    = calcSl(false);
        const slPct = Math.max(Math.abs(entry - sl) / entry * 100, MIN_SL_PCT);
        if (slPct <= MAX_SL_PCT) {
          const tp1Pct = slPct * TP1_RR;
          const tp2Pct = slPct * TP2_RR;
          let score = 0; const reasons: string[] = [];
          score += 18; reasons.push(`RSI(3) bounce ${rsiP.toFixed(0)}→${rsi.toFixed(0)}`);
          if (volR >= 2)   { score += 22; reasons.push(`Vol ×${volR.toFixed(1)}`); }
          else if (volR >= 1.5) { score += 14; }
          else { score += 8; }
          const rsiExt = rsiP - 85;
          if (rsiExt > 10) { score += 20; reasons.push(`RSI estremo ${rsiP.toFixed(0)}`); }
          else if (rsiExt > 5) { score += 12; }
          else { score += 6; }
          if (e9 < e20 && e20 < e50) { score += 14; reasons.push('EMA bearish'); }
          else { score += 7; }
          const macdData = this.indicators.macd(cl, 12, 26, 9);
          if (macdData.histogram < macdData.prevHistogram) { score += 10; reasons.push('MACD↓'); }
          if (slPct < 0.3) score += 10; else if (slPct < 0.6) score += 6;
          if (bdy(n - 1) >= 0.5) { score += 9; reasons.push('Corpo solido'); }
          else if (bdy(n - 1) >= 0.35) { score += 5; }

          this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
          if (score >= MIN_SCORE) {
            const grade: SqzSignal['grade'] = score >= 68 ? 'A+' : score >= 54 ? 'A' : score >= 42 ? 'B' : 'C';
            return this.buildSignal(sym, 'SHORT', 2, 'RSI_BOUNCE', entry, sl, slPct, tp1Pct, tp2Pct, volR, rsi, bbWidth, score, grade, reasons, raw1m, e9arr, e20arr, bbUpperArr, bbLowerArr);
          }
          this.dbg['F_rsi_score'] = (this.dbg['F_rsi_score'] ?? 0) + 1;
        } else { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
      } else {
        this.dbg['F_rsi'] = (this.dbg['F_rsi'] ?? 0) + 1;
      }

      return null;
    } catch {
      this.dbg['L0_error'] = (this.dbg['L0_error'] ?? 0) + 1;
      return null;
    }
  }

  private buildSignal(
    sym: string, direction: 'LONG' | 'SHORT', patternType: 1 | 2, signalType: 'SQZ_BREAK' | 'RSI_BOUNCE',
    entry: number, sl: number, slPct: number, tp1Pct: number, tp2Pct: number,
    volR: number, rsi: number, bbWidth: number, score: number, grade: SqzSignal['grade'],
    reasons: string[],
    raw1m: number[][], e9arr: number[], e20arr: number[], bbUpperArr: number[], bbLowerArr: number[],
  ): SqzSignal {
    const isLong     = direction === 'LONG';
    const stopLoss   = parseFloat(sl.toPrecision(6));
    const tp1        = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
    const tp2        = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));
    const lev        = Math.min(Math.round(5 / slPct), 100);
    return {
      id:              `${sym}_${Date.now()}`,
      symbol:          sym,
      direction,
      patternType,
      signalType,
      entry,
      stopLoss,
      takeProfit1:     tp1,
      takeProfit2:     tp2,
      slPct:           parseFloat(slPct.toFixed(3)),
      tp1Pct:          parseFloat(tp1Pct.toFixed(3)),
      tp2Pct:          parseFloat(tp2Pct.toFixed(3)),
      suggestedLeverage: lev,
      volumeRatio:     parseFloat(volR.toFixed(2)),
      rsi:             parseFloat(rsi.toFixed(1)),
      bbWidth:         parseFloat(bbWidth.toFixed(3)),
      score,
      grade,
      reasons,
      timestamp:       new Date().toISOString(),
      mexcUrl:         `https://futures.mexc.com/exchange/${sym.replace('/USDT:USDT', '_USDT')}`,
      sparkline:       raw1m.slice(-60).map((c) => ({ t: c[0] as number, o: c[1] as number, h: c[2] as number, l: c[3] as number, c: c[4] as number })),
      ema9spark:       e9arr.slice(-60),
      ema20spark:      e20arr.slice(-60),
      bbUpperSpark:    bbUpperArr.slice(-60),
      bbLowerSpark:    bbLowerArr.slice(-60),
    };
  }

  // ─── SIMULAZIONE ──────────────────────────────────────────────────────────

  private async enterSimTrade(sig: SqzSignal) {
    const cfg = await this.getConfig();
    if (!cfg.autoEnter) return;
    const openCount = await this.prisma.sqzSimulatedTrade.count({ where: { status: 'open' } });
    if (openCount >= cfg.maxConcurrent) return;

    const pSize      = RISK_EUR * 100 / sig.slPct;
    const feeOpen    = pSize * TAKER_FEE;
    const capitalBefore = cfg.startingCapital;

    const id = `${sig.id}_sqz`;
    const existing = await this.prisma.sqzSimulatedTrade.findUnique({ where: { id } });
    if (existing) return;

    const trade = await this.prisma.sqzSimulatedTrade.create({
      data: {
        id,
        symbol:       sig.symbol,
        direction:    sig.direction,
        patternType:  sig.patternType,
        entry:        sig.entry,
        stopLoss:     sig.stopLoss,
        takeProfit1:  sig.takeProfit1,
        takeProfit2:  sig.takeProfit2,
        leverage:     sig.suggestedLeverage,
        riskEur:      RISK_EUR,
        positionSize: parseFloat(pSize.toFixed(4)),
        marginEur:    parseFloat((pSize / sig.suggestedLeverage).toFixed(4)),
        grade:        sig.grade,
        score:        sig.score,
        fees:         parseFloat(feeOpen.toFixed(4)),
        capitalBefore: parseFloat(capitalBefore.toFixed(4)),
        status:       'open',
      },
    });
    this.events.server.emit('sqz:trade', trade);
  }

  private async initConfig() {
    await this.prisma.sqzSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, marginPerTrade: 10, maxConcurrent: 3, autoEnter: true },
      update: {},
    });
  }

  private async getConfig() {
    return this.prisma.sqzSimConfig.findFirstOrThrow({ where: { id: 1 } });
  }

  private async getOpenSymbolsSet(): Promise<Set<string>> {
    const open = await this.prisma.sqzSimulatedTrade.findMany({ where: { status: 'open' }, select: { symbol: true } });
    return new Set(open.map((t) => t.symbol));
  }

  // ─── API ──────────────────────────────────────────────────────────────────

  getRecentSignals(limit = 50) { return this.recentSignals.slice(0, limit); }
  getDebug() { return { ...this.dbg, timestamp: new Date().toISOString() }; }
  getStatus() {
    return {
      lastScanAt:   this.lastScanAt,
      scannedPairs: this.scannedCount,
      candidates:   TOP_CANDIDATES,
      rawSignals:   this.lastRawSignals,
      emitted:      this.lastEmitted,
      isScanning:   this.isScanning,
    };
  }

  async getAnalytics() {
    const cfg    = await this.getConfig();
    const all    = await this.prisma.sqzSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = all.filter((t) => t.status !== 'open');
    const open   = all.filter((t) => t.status === 'open');

    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalPnlPct = cfg.startingCapital > 0 ? totalPnl / cfg.startingCapital * 100 : 0;
    const winRate  = closed.length > 0 ? wins / closed.length * 100 : 0;
    const avgWin   = wins > 0 ? closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / wins : 0;
    const avgLoss  = losses > 0 ? Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0)) / losses : 0;
    const grossWin = closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0));

    const byType = (type: number) => {
      const t = closed.filter((tr) => tr.patternType === type);
      return { trades: t.length, wins: t.filter((tr) => (tr.pnl ?? 0) > 0).length };
    };

    let peak = cfg.startingCapital, dd = 0, maxDd = 0;
    for (const t of [...closed].reverse()) {
      const cap = t.capitalAfter ?? cfg.startingCapital;
      if (cap > peak) peak = cap;
      dd = (peak - cap) / peak * 100;
      if (dd > maxDd) maxDd = dd;
    }

    return {
      totalTrades: all.length, openTrades: open.length, wins, losses,
      winRate:     parseFloat(winRate.toFixed(1)),
      totalPnl:    parseFloat(totalPnl.toFixed(3)),
      totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
      currentCapital: cfg.startingCapital,
      avgWinEur:   parseFloat(avgWin.toFixed(3)),
      avgLossEur:  parseFloat(avgLoss.toFixed(3)),
      rrActual:    avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : 0,
      profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
      maxDrawdownPct: parseFloat(maxDd.toFixed(1)),
      breakdown: { sqz: byType(1), rsi: byType(2) },
      config: { startingCapital: cfg.startingCapital, marginPerTrade: cfg.marginPerTrade, maxConcurrent: cfg.maxConcurrent, autoEnter: cfg.autoEnter },
    };
  }

  async getOpenTrades() {
    return this.prisma.sqzSimulatedTrade.findMany({ where: { status: 'open' }, orderBy: { openedAt: 'desc' } });
  }

  async getClosedTrades(limit = 100) {
    return this.prisma.sqzSimulatedTrade.findMany({ where: { status: { not: 'open' } }, orderBy: { closedAt: 'desc' }, take: limit });
  }

  async updateConfig(cfg: Partial<{ startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean }>) {
    await this.prisma.sqzSimConfig.update({ where: { id: 1 }, data: cfg });
    return { ok: true };
  }

  async resetSim() {
    await this.prisma.sqzSimulatedTrade.deleteMany();
    await this.prisma.sqzSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    return { ok: true };
  }

  async closeManual(id: string) {
    const t = await this.prisma.sqzSimulatedTrade.findUnique({ where: { id } });
    if (!t || t.status !== 'open') return { ok: false };
    const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 2).catch(() => []);
    const curr  = ohlcv.length ? (ohlcv.at(-1)![4] as number) : t.entry;
    const isLong = t.direction === 'LONG';
    const pnlRaw = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
    const fee    = (t.positionSize + Math.abs(pnlRaw)) * TAKER_FEE;
    const pnl    = pnlRaw - fee;
    const cfg    = await this.getConfig();
    const capitalAfter = cfg.startingCapital + pnl;
    await this.prisma.sqzSimulatedTrade.update({
      where: { id },
      data: { status: 'manual', closePrice: curr, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(fee.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
    });
    return { ok: true };
  }
}
