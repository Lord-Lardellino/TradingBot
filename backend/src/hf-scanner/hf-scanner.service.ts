import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ─── Interfacce ───────────────────────────────────────────────────────────────

export interface HfSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  patternType: 1 | 2 | 3 | 4;
  // 1=EMA_CROSS  EMA9 incrocia EMA21 con volume
  // 2=FVG        Fair Value Gap retest (3-candle imbalance)
  // 3=DBL        Micro Double Bottom / Top con candela di conferma
  // 4=ORB        Range Breakout (consolidazione → breakout direzionale)
  patternName: string;
  entry: number;
  stopLoss: number;
  takeProfit: number;   // singolo TP a RR 1:2
  slPct: number;
  tpPct: number;
  suggestedLeverage: number;
  volumeRatio: number;
  rsi3: number;
  atrPct: number;       // ATR/entry % — utile per calibrare dimensione posizione
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[];
  timestamp: string;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema9spark: number[];
  ema21spark: number[];
}

// ─── Costanti ─────────────────────────────────────────────────────────────────

const MIN_VOLUME_24H  = 2_000_000;
const TOP_CANDIDATES  = 300;
const CANDLES         = 90;       // candele fetch — abbastanza per ATR14 + pattern look-back
const MAX_SL_PCT      = 1.50;     // SL mai oltre l'1.5% dall'entry
const ATR_SL_MULT     = 1.2;      // SL = entry ± ATR × 1.2 (floor structurale)
const TP_RR           = 2.0;      // singolo TP a RR 1:2
const SIGNAL_COOLDOWN = 60_000;   // 1 min cooldown per coppia → ≥1 segnale/min
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 0.50;
const MIN_SCORE       = 42;
const MAX_PER_CYCLE   = 10;

// EMA21 slope minimo per filtrare mercato flat
const SLOPE_MIN_PCT   = 0.03;

@Injectable()
export class HfScannerService implements OnModuleInit {
  private readonly logger = new Logger(HfScannerService.name);
  private exchange: ccxt.mexc;
  private validFuturesSymbols = new Set<string>();
  private recentSignals: HfSignal[] = [];
  private isScanning    = false;
  private lastScanAt:   string | null = null;
  private scannedCount  = 0;
  private lastRawSignals = 0;
  private lastEmitted    = 0;
  private dbg: Record<string, number> = {};
  private cooldowns = new Map<string, number>();
  private readonly sessionStart = new Date();

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
    this.logger.log(`HfScanner: ${this.validFuturesSymbols.size} coppie futures USDT`);
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

  @Cron('40 */1 * * * *')
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
      const candidates = pool.slice().sort(() => Math.random() - 0.5).slice(0, TOP_CANDIDATES);
      this.scannedCount = this.validFuturesSymbols.size;
      this.dbg = {};

      const cycleSignals: HfSignal[] = [];
      for (const ticker of candidates) {
        const sig = await this.analyzePair(ticker);
        if (sig) cycleSignals.push(sig);
        await new Promise((r) => setTimeout(r, 30));
      }
      this.lastRawSignals = cycleSignals.length;

      const longs  = cycleSignals.filter((s) => s.direction === 'LONG').sort((a, b) => b.score - a.score).slice(0, MAX_PER_CYCLE);
      const shorts = cycleSignals.filter((s) => s.direction === 'SHORT').sort((a, b) => b.score - a.score).slice(0, MAX_PER_CYCLE);
      const best   = [...longs, ...shorts];

      let emitted = 0;
      for (const sig of best) {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        if (Date.now() - last < SIGNAL_COOLDOWN) continue;
        this.cooldowns.set(sig.symbol, Date.now());

        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 300) this.recentSignals.pop();

        this.events.server.emit('hf:signal', sig);
        await this.enterSimTrade(sig).catch(() => {});
        emitted++;
        this.logger.log(`[HF ${sig.grade}] ${sig.direction} ${sig.symbol} ${sig.patternName} score=${sig.score} SL=${sig.slPct.toFixed(2)}% TP=${sig.tpPct.toFixed(2)}%`);
      }
      this.lastEmitted = emitted;
      this.lastScanAt  = new Date().toISOString();
      this.events.server.emit('hf:status', {
        lastScanAt: this.lastScanAt, scannedPairs: this.scannedCount,
        candidates: candidates.length, rawSignals: this.lastRawSignals,
        emitted: this.lastEmitted, isScanning: false, debug: { ...this.dbg },
      });
    } catch (err) {
      this.logger.error(`HfScan: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ─── CHECK OPEN TRADES — singolo TP ───────────────────────────────────────
  @Cron('*/10 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.hfSimulatedTrade.findMany({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (!open.length) return;
      const cfg = await this.getConfig();

      for (const t of open) {
        try {
          const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 3);
          if (!ohlcv.length) continue;
          const curr   = ohlcv.at(-1)![4] as number;
          const isLong = t.direction === 'LONG';

          const unrealizedPnl    = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const unrealizedPnlPct = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100;
          this.events.server.emit('hf:positions', [{
            id: t.id, currentPrice: curr,
            unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(4)),
            unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
          }]);

          const hitSL = isLong ? curr <= t.stopLoss    : curr >= t.stopLoss;
          const hitTP = isLong ? curr >= t.takeProfit1 : curr <= t.takeProfit1;
          if (!hitSL && !hitTP) continue;

          const status     = hitTP ? 'tp1' : 'sl';
          const closePrice = hitTP ? t.takeProfit1 : t.stopLoss;
          const pnlRaw     = (closePrice - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const fee        = (t.positionSize + Math.abs(pnlRaw)) * TAKER_FEE;
          const pnl        = pnlRaw - fee;
          const capitalAfter = t.capitalBefore + pnl;

          await this.prisma.hfSimulatedTrade.update({
            where: { id: t.id },
            data: {
              status, closePrice, pnl: parseFloat(pnl.toFixed(4)),
              fees: parseFloat(fee.toFixed(4)),
              capitalAfter: parseFloat(capitalAfter.toFixed(4)),
              closedAt: new Date(),
            },
          });
          if (cfg.autoEnter) {
            await this.prisma.hfSimConfig.update({ where: { id: 1 }, data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) } });
          }
          const updated = await this.prisma.hfSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.server.emit('hf:trade', updated);
          this.logger.log(`[HF CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err) {
      this.logger.error(`HF checkOpenTrades: ${err.message}`);
    }
  }

  // ─── ANALISI COPPIA — 4 Pattern ───────────────────────────────────────────

  private async analyzePair(ticker: ccxt.Ticker): Promise<HfSignal | null> {
    try {
      const sym   = ticker.symbol;
      const raw   = await this.exchange.fetchOHLCV(sym, '1m', undefined, CANDLES);
      if (raw.length < 35) { this.dbg['L0_no_data'] = (this.dbg['L0_no_data'] ?? 0) + 1; return null; }

      const o1 = raw.map((c) => c[1] as number);
      const h1 = raw.map((c) => c[2] as number);
      const l1 = raw.map((c) => c[3] as number);
      const c1 = raw.map((c) => c[4] as number);
      const v1 = raw.map((c) => c[5] as number);
      const n  = c1.length;

      // ── Indicatori ────────────────────────────────────────────────────────
      const ema9arr  = this.indicators.emaArray(c1, 9);
      const ema21arr = this.indicators.emaArray(c1, 21);
      const rsi3arr  = this.indicators.rsiArray(c1, 3);
      const atr14    = this.indicators.atr(h1, l1, c1, 14);

      if (ema21arr.length < 8 || rsi3arr.length < 5) return null;

      const ema9_1  = ema9arr.at(-1)!;
      const ema9_2  = ema9arr.at(-2)!;
      const ema21_1 = ema21arr.at(-1)!;
      const ema21_2 = ema21arr.at(-2)!;
      const ema21_6 = ema21arr.at(-6)!;
      const rsi_1   = rsi3arr.at(-1)!;

      // Entry = ultimo candle confermato chiuso
      const entry = c1[n - 2];
      if (!entry || entry <= 0) return null;

      const atrPct = atr14 / entry * 100;

      // ── Filtro slope EMA21 ────────────────────────────────────────────────
      const ema21Slope = (ema21_1 - ema21_6) / ema21_6 * 100;
      const trendUp    = ema21Slope >  SLOPE_MIN_PCT;
      const trendDown  = ema21Slope < -SLOPE_MIN_PCT;
      if (!trendUp && !trendDown) { this.dbg['F1_flat'] = (this.dbg['F1_flat'] ?? 0) + 1; return null; }

      // ── Filtro volume morto ────────────────────────────────────────────────
      const refVols   = v1.slice(n - 22, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const volR      = refAvgVol > 0 ? v1[n - 2] / refAvgVol : 1;
      if (volR < 0.4) { this.dbg['F_vol_dead'] = (this.dbg['F_vol_dead'] ?? 0) + 1; return null; }

      // ── Helper SL via ATR + strutturale ───────────────────────────────────
      // Prende il MAGGIORE tra SL strutturale e ATR-floor: evita micro-stop
      const calcSlLong  = (structural: number) => Math.min(structural, entry - atr14 * ATR_SL_MULT);
      const calcSlShort = (structural: number) => Math.max(structural, entry + atr14 * ATR_SL_MULT);
      const slPctOf     = (slLv: number, dir: 'L' | 'S') =>
        dir === 'L' ? (entry - slLv) / entry * 100 : (slLv - entry) / entry * 100;

      // ──────────────────────────────────────────────────────────────────────
      // PATTERN 1: EMA_CROSS — EMA9 incrocia EMA21 nell'ultima candela
      // Confluenza: EMA21 slope direzionale + volume > media
      // ──────────────────────────────────────────────────────────────────────
      {
        const crossLong  = ema9_2 <  ema21_2 && ema9_1 >= ema21_1 && trendUp;
        const crossShort = ema9_2 >  ema21_2 && ema9_1 <= ema21_1 && trendDown;

        if (crossLong || crossShort) {
          const isLong = crossLong;

          const swingLow  = Math.min(...l1.slice(n - 6, n - 1));
          const swingHigh = Math.max(...h1.slice(n - 6, n - 1));
          const structSl  = isLong ? swingLow  * 0.999 : swingHigh * 1.001;
          const slLevel   = isLong ? calcSlLong(structSl) : calcSlShort(structSl);
          const slPct     = Math.max(slPctOf(slLevel, isLong ? 'L' : 'S'), 0.05);
          if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
          else {
            let score = 30;
            const reasons: string[] = ['EMA9×EMA21'];
            const crossGap = Math.abs(ema9_1 - ema21_1) / ema21_1 * 100;
            if      (crossGap > 0.10) { score += 10; reasons.push(`Gap ${crossGap.toFixed(2)}%`); }
            else if (crossGap > 0.05) { score +=  6; }
            score += this._slopeBonus(Math.abs(ema21Slope), reasons);
            score += this._volBonus(volR, reasons);
            score += this._rsiBonus(rsi_1, isLong, reasons);
            if (volR >= 1.2) { score += 5; reasons.push(`RVOL ×${volR.toFixed(1)}`); }
            this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
            if (score >= MIN_SCORE) {
              return this._sig(sym, isLong ? 'LONG' : 'SHORT', entry, slLevel, slPct, 1, 'EMA_CROSS', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
            }
            this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
          }
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // PATTERN 2: FVG — Fair Value Gap retest
      // 3 candle consecutive: la middle crea un gap.
      // Bullish FVG: candle3.low > candle1.high  → zona [c1.high, c3.low]
      // Bearish FVG: candle3.high < candle1.low  → zona [c3.high, c1.low]
      // Ingresso: prezzo ritorna nella zona (retest) e rimbalza
      // ──────────────────────────────────────────────────────────────────────
      fvg: {
        for (let age = 5; age <= 22; age++) {
          const ia = n - age - 2, ib = n - age - 1, ic = n - age;
          if (ia < 2) break;

          const a_hi = h1[ia], a_lo = l1[ia];
          const b_range = h1[ib] - l1[ib];
          const b_body  = Math.abs(c1[ib] - o1[ib]);
          const c_hi = h1[ic], c_lo = l1[ic];

          // Candle B deve avere corpo significativo (imbalance candle ≥35%)
          if (b_range <= 0 || b_body / b_range < 0.35) continue;

          const hiLast = h1[n - 2], loLast = l1[n - 2], oLast = o1[n - 2];

          // ── Bullish FVG ──────────────────────────────────────────────────
          if (c_lo > a_hi && trendUp) {
            const fvgLow  = a_hi;
            const fvgHigh = c_lo;
            const gapPct  = (fvgHigh - fvgLow) / fvgLow * 100;
            if (gapPct < 0.04 || gapPct > 2.5) continue;

            // Verifica che dopo il FVG il prezzo sia salito sopra la zona (conferma)
            let priceAbove = false;
            for (let j = ic + 1; j <= n - 3; j++) { if (h1[j] > fvgHigh) { priceAbove = true; break; } }
            if (!priceAbove) continue;

            // Retest: il candle n-2 ha toccato la zona e rimbalza bullish
            const inZone  = loLast <= fvgHigh * 1.002 && entry >= fvgLow * 0.997;
            const bounce  = entry > oLast && entry > (fvgLow + fvgHigh) / 2;
            if (!inZone || !bounce) continue;

            const structSl = fvgLow * 0.997;
            const slLevel  = calcSlLong(structSl);
            const slPct    = Math.max(slPctOf(slLevel, 'L'), 0.05);
            if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; continue; }

            let score = 32;
            const reasons: string[] = ['FVG Support'];
            if      (gapPct > 0.30) { score += 12; reasons.push(`Gap ${gapPct.toFixed(2)}%`); }
            else if (gapPct > 0.10) { score +=  8; reasons.push(`Gap ${gapPct.toFixed(2)}%`); }
            else                    { score +=  4; }
            const retestDepth = (fvgHigh - loLast) / fvgHigh * 100;
            if (retestDepth > 0.10) { score += 8; reasons.push(`Retest ${retestDepth.toFixed(2)}%`); }
            score += this._slopeBonus(Math.abs(ema21Slope), reasons);
            score += this._volBonus(volR, reasons);
            score += this._rsiBonus(rsi_1, true, reasons);
            if (ema9_1 > ema21_1) { score += 6; reasons.push('EMA9>21'); }
            this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
            if (score >= MIN_SCORE) {
              return this._sig(sym, 'LONG', entry, slLevel, slPct, 2, 'FVG', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
            }
            this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
            break fvg;
          }

          // ── Bearish FVG ──────────────────────────────────────────────────
          if (c_hi < a_lo && trendDown) {
            const fvgLow  = c_hi;
            const fvgHigh = a_lo;
            const gapPct  = (fvgHigh - fvgLow) / fvgLow * 100;
            if (gapPct < 0.04 || gapPct > 2.5) continue;

            let priceBelow = false;
            for (let j = ic + 1; j <= n - 3; j++) { if (l1[j] < fvgLow) { priceBelow = true; break; } }
            if (!priceBelow) continue;

            const inZone = hiLast >= fvgLow * 0.998 && entry <= fvgHigh * 1.003;
            const bounce = entry < oLast && entry < (fvgLow + fvgHigh) / 2;
            if (!inZone || !bounce) continue;

            const structSl = fvgHigh * 1.003;
            const slLevel  = calcSlShort(structSl);
            const slPct    = Math.max(slPctOf(slLevel, 'S'), 0.05);
            if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; continue; }

            let score = 32;
            const reasons: string[] = ['FVG Resistance'];
            if      (gapPct > 0.30) { score += 12; reasons.push(`Gap ${gapPct.toFixed(2)}%`); }
            else if (gapPct > 0.10) { score +=  8; reasons.push(`Gap ${gapPct.toFixed(2)}%`); }
            else                    { score +=  4; }
            const retestDepth = (hiLast - fvgLow) / fvgLow * 100;
            if (retestDepth > 0.10) { score += 8; reasons.push(`Retest ${retestDepth.toFixed(2)}%`); }
            score += this._slopeBonus(Math.abs(ema21Slope), reasons);
            score += this._volBonus(volR, reasons);
            score += this._rsiBonus(rsi_1, false, reasons);
            if (ema9_1 < ema21_1) { score += 6; reasons.push('EMA9<21'); }
            this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
            if (score >= MIN_SCORE) {
              return this._sig(sym, 'SHORT', entry, slLevel, slPct, 2, 'FVG', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
            }
            this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
            break fvg;
          }
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // PATTERN 3: DBL — Micro Double Bottom / Top
      // Due minimi (o massimi) nello stesso livello (±0.25%) separati da ≥4 candele
      // con recovery intermedia + candela di conferma bullish/bearish ≥40% body
      // ──────────────────────────────────────────────────────────────────────
      dbl: {
        const earlyA = n - 22, earlyB = n - 11; // prima finestra
        const lateA  = n - 10, lateB  = n - 3;  // seconda finestra

        // ── Double Bottom ────────────────────────────────────────────────
        if (trendUp) {
          let ei = earlyA, li = lateA;
          for (let i = earlyA + 1; i <= earlyB; i++) if (l1[i] < l1[ei]) ei = i;
          for (let i = lateA  + 1; i <= lateB;  i++) if (l1[i] < l1[li]) li = i;

          const earlyLow = l1[ei], lateLow = l1[li];
          const diffPct = Math.abs(earlyLow - lateLow) / earlyLow * 100;
          const separated = li - ei >= 4;

          if (diffPct <= 0.25 && separated) {
            let peakBetween = 0;
            for (let i = ei + 1; i < li; i++) peakBetween = Math.max(peakBetween, h1[i]);
            const recovPct = peakBetween > 0 ? (peakBetween - earlyLow) / earlyLow * 100 : 0;

            if (recovPct >= 0.15) {
              const ci = n - 2;
              const cBody = (h1[ci] - l1[ci]) > 0 ? Math.abs(c1[ci] - o1[ci]) / (h1[ci] - l1[ci]) : 0;
              const isBull = c1[ci] > o1[ci] && cBody >= 0.40;

              if (isBull) {
                const structSl = Math.min(earlyLow, lateLow) * 0.998;
                const slLevel  = calcSlLong(structSl);
                const slPct    = Math.max(slPctOf(slLevel, 'L'), 0.05);
                if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
                else {
                  let score = 28;
                  const reasons: string[] = ['Double Bottom'];
                  if      (diffPct < 0.08) { score += 14; reasons.push(`Lows Δ${diffPct.toFixed(2)}%`); }
                  else if (diffPct < 0.18) { score +=  9; reasons.push(`Lows Δ${diffPct.toFixed(2)}%`); }
                  else                     { score +=  4; }
                  if      (recovPct > 0.50) { score +=  8; reasons.push(`Recov ${recovPct.toFixed(2)}%`); }
                  else if (recovPct > 0.25) { score +=  5; }
                  else                     { score +=  2; }
                  if (cBody >= 0.65) { score += 6; reasons.push(`Body ${(cBody * 100).toFixed(0)}%`); }
                  score += this._slopeBonus(Math.abs(ema21Slope), reasons);
                  score += this._volBonus(volR, reasons);
                  score += this._rsiBonus(rsi_1, true, reasons);
                  if (ema9_1 > ema21_1) { score += 6; reasons.push('EMA9>21'); }
                  this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
                  if (score >= MIN_SCORE) {
                    return this._sig(sym, 'LONG', entry, slLevel, slPct, 3, 'DBL_BTM', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
                  }
                  this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
                }
              }
            }
          }
        }

        // ── Double Top ───────────────────────────────────────────────────
        if (trendDown) {
          let ei = earlyA, li = lateA;
          for (let i = earlyA + 1; i <= earlyB; i++) if (h1[i] > h1[ei]) ei = i;
          for (let i = lateA  + 1; i <= lateB;  i++) if (h1[i] > h1[li]) li = i;

          const earlyHigh = h1[ei], lateHigh = h1[li];
          const diffPct = Math.abs(earlyHigh - lateHigh) / earlyHigh * 100;
          const separated = li - ei >= 4;

          if (diffPct <= 0.25 && separated) {
            let troughBetween = earlyHigh;
            for (let i = ei + 1; i < li; i++) troughBetween = Math.min(troughBetween, l1[i]);
            const retracePct = (earlyHigh - troughBetween) / earlyHigh * 100;

            if (retracePct >= 0.15) {
              const ci = n - 2;
              const cBody = (h1[ci] - l1[ci]) > 0 ? Math.abs(c1[ci] - o1[ci]) / (h1[ci] - l1[ci]) : 0;
              const isBear = c1[ci] < o1[ci] && cBody >= 0.40;

              if (isBear) {
                const structSl = Math.max(earlyHigh, lateHigh) * 1.002;
                const slLevel  = calcSlShort(structSl);
                const slPct    = Math.max(slPctOf(slLevel, 'S'), 0.05);
                if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
                else {
                  let score = 28;
                  const reasons: string[] = ['Double Top'];
                  if      (diffPct < 0.08) { score += 14; reasons.push(`Highs Δ${diffPct.toFixed(2)}%`); }
                  else if (diffPct < 0.18) { score +=  9; reasons.push(`Highs Δ${diffPct.toFixed(2)}%`); }
                  else                     { score +=  4; }
                  if      (retracePct > 0.50) { score +=  8; reasons.push(`Retrace ${retracePct.toFixed(2)}%`); }
                  else if (retracePct > 0.25) { score +=  5; }
                  else                        { score +=  2; }
                  if (cBody >= 0.65) { score += 6; reasons.push(`Body ${(cBody * 100).toFixed(0)}%`); }
                  score += this._slopeBonus(Math.abs(ema21Slope), reasons);
                  score += this._volBonus(volR, reasons);
                  score += this._rsiBonus(rsi_1, false, reasons);
                  if (ema9_1 < ema21_1) { score += 6; reasons.push('EMA9<21'); }
                  this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
                  if (score >= MIN_SCORE) {
                    return this._sig(sym, 'SHORT', entry, slLevel, slPct, 3, 'DBL_TOP', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
                  }
                  this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
                }
              }
            }
          }
        }
      }

      // ──────────────────────────────────────────────────────────────────────
      // PATTERN 4: RANGE_BRK — Opening Range Breakout (adattato crypto 24/7)
      // Ultime 10 candele formano una consolidazione (0.20%–1.50% range)
      // Il candle confermato (n-2) chiude fuori dal range con volume elevato
      // SL = lato opposto del range × margine di sicurezza
      // ──────────────────────────────────────────────────────────────────────
      {
        const rs = n - 12, re = n - 3;
        let rangeHigh = h1[rs], rangeLow = l1[rs];
        for (let i = rs + 1; i <= re; i++) {
          if (h1[i] > rangeHigh) rangeHigh = h1[i];
          if (l1[i] < rangeLow)  rangeLow  = l1[i];
        }
        const rangeSize = (rangeHigh - rangeLow) / rangeLow * 100;

        if (rangeSize >= 0.20 && rangeSize <= 1.50) {
          const oEntry = o1[n - 2];
          const bullBreak = entry > rangeHigh * 1.001 && entry > oEntry && trendUp  && volR >= 1.20;
          const bearBreak = entry < rangeLow  * 0.999 && entry < oEntry && trendDown && volR >= 1.20;

          if (bullBreak || bearBreak) {
            const isLong   = bullBreak;
            const structSl = isLong ? rangeLow  * 0.997 : rangeHigh * 1.003;
            const slLevel  = isLong ? calcSlLong(structSl) : calcSlShort(structSl);
            const slPct    = Math.max(slPctOf(slLevel, isLong ? 'L' : 'S'), 0.05);

            if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; }
            else {
              const breakPct = isLong
                ? (entry - rangeHigh) / rangeHigh * 100
                : (rangeLow - entry)  / rangeLow  * 100;

              let score = 30;
              const reasons: string[] = ['Range Breakout'];
              if      (breakPct > 0.20) { score += 10; reasons.push(`Break ${breakPct.toFixed(2)}%`); }
              else if (breakPct > 0.05) { score +=  6; }
              else                      { score +=  2; }
              if      (rangeSize < 0.50) { score +=  8; reasons.push(`Range ${rangeSize.toFixed(2)}%`); }
              else if (rangeSize < 0.80) { score +=  5; }
              else                       { score +=  2; }
              score += this._slopeBonus(Math.abs(ema21Slope), reasons);
              score += this._volBonus(volR, reasons);
              score += this._rsiBonus(rsi_1, isLong, reasons);
              if (isLong  && ema9_1 > ema21_1) { score += 6; reasons.push('EMA9>21'); }
              if (!isLong && ema9_1 < ema21_1) { score += 6; reasons.push('EMA9<21'); }
              this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
              if (score >= MIN_SCORE) {
                return this._sig(sym, isLong ? 'LONG' : 'SHORT', entry, slLevel, slPct, 4, 'RANGE_BRK', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
              }
              this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
            }
          }
        }
      }

      this.dbg['F_no_pattern'] = (this.dbg['F_no_pattern'] ?? 0) + 1;
      return null;
    } catch {
      this.dbg['L0_error'] = (this.dbg['L0_error'] ?? 0) + 1;
      return null;
    }
  }

  // ─── BONUS HELPERS ────────────────────────────────────────────────────────

  private _slopeBonus(abs: number, r: string[]): number {
    if      (abs > 0.20) { r.push(`Slope ${abs.toFixed(2)}%`); return 15; }
    else if (abs > 0.12) { r.push(`Slope ${abs.toFixed(2)}%`); return 10; }
    else if (abs > 0.06) { return 6; }
    return 3;
  }

  private _volBonus(volR: number, r: string[]): number {
    if      (volR >= 2.5) { r.push(`Vol ×${volR.toFixed(1)}`); return 12; }
    else if (volR >= 1.5) { r.push(`Vol ×${volR.toFixed(1)}`); return  8; }
    else if (volR >= 1.0) { return 5; }
    return 2;
  }

  private _rsiBonus(rsi: number, isLong: boolean, r: string[]): number {
    if (isLong) {
      if      (rsi < 35) { r.push(`RSI ${rsi.toFixed(0)}`); return 8; }
      else if (rsi < 50) { return 5; }
      return 2;
    } else {
      if      (rsi > 65) { r.push(`RSI ${rsi.toFixed(0)}`); return 8; }
      else if (rsi > 50) { return 5; }
      return 2;
    }
  }

  // ─── BUILD SIGNAL ─────────────────────────────────────────────────────────

  private _sig(
    sym: string, direction: 'LONG' | 'SHORT', entry: number,
    slLevel: number, slPct: number,
    patternType: 1 | 2 | 3 | 4, patternName: string,
    score: number, volR: number, rsi3: number, atrPct: number,
    reasons: string[], raw: number[][], ema9arr: number[], ema21arr: number[],
  ): HfSignal {
    const isLong  = direction === 'LONG';
    const tpPct   = slPct * TP_RR;
    const stopLoss    = parseFloat(slLevel.toPrecision(6));
    const takeProfit  = parseFloat((entry * (isLong ? 1 + tpPct / 100 : 1 - tpPct / 100)).toPrecision(6));
    const grade: HfSignal['grade'] = score >= 68 ? 'A+' : score >= 55 ? 'A' : score >= 42 ? 'B' : 'C';
    const suggestedLeverage = Math.min(Math.round(5 / slPct), 100);

    return {
      id: `${sym}_${Date.now()}`, symbol: sym, direction,
      patternType, patternName, entry, stopLoss, takeProfit,
      slPct:  parseFloat(slPct.toFixed(3)),
      tpPct:  parseFloat(tpPct.toFixed(3)),
      suggestedLeverage, volumeRatio: parseFloat(volR.toFixed(2)),
      rsi3: parseFloat(rsi3.toFixed(1)), atrPct: parseFloat(atrPct.toFixed(3)),
      score, grade, reasons, timestamp: new Date().toISOString(),
      mexcUrl: `https://futures.mexc.com/exchange/${sym.replace('/USDT:USDT', '_USDT')}`,
      sparkline: raw.slice(-60).map((c) => ({ t: c[0] as number, o: c[1] as number, h: c[2] as number, l: c[3] as number, c: c[4] as number })),
      ema9spark:  ema9arr.slice(-60),
      ema21spark: ema21arr.slice(-60),
    };
  }

  // ─── SIMULAZIONE ──────────────────────────────────────────────────────────

  private async enterSimTrade(sig: HfSignal) {
    const cfg = await this.getConfig();
    if (!cfg.autoEnter) return;
    const openCount = await this.prisma.hfSimulatedTrade.count({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (openCount >= cfg.maxConcurrent) return;

    const pSize   = RISK_EUR * 100 / sig.slPct;
    const feeOpen = pSize * TAKER_FEE;
    const id      = `${sig.id}_hf`;
    const exists  = await this.prisma.hfSimulatedTrade.findUnique({ where: { id } });
    if (exists) return;

    const trade = await this.prisma.hfSimulatedTrade.create({
      data: {
        id, symbol: sig.symbol, direction: sig.direction, patternType: sig.patternType,
        entry: sig.entry, stopLoss: sig.stopLoss,
        takeProfit1: sig.takeProfit,   // singolo TP
        takeProfit2: sig.takeProfit,   // stesso valore — non usato nella logica di chiusura
        leverage: sig.suggestedLeverage, riskEur: RISK_EUR,
        positionSize: parseFloat(pSize.toFixed(4)),
        marginEur: parseFloat((pSize / sig.suggestedLeverage).toFixed(4)),
        grade: sig.grade, score: sig.score,
        fees: parseFloat(feeOpen.toFixed(4)),
        capitalBefore: parseFloat(cfg.startingCapital.toFixed(4)),
        status: 'open',
      },
    });
    this.events.server.emit('hf:trade', trade);
  }

  private async initConfig() {
    await this.prisma.hfSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, marginPerTrade: 10, maxConcurrent: 5, autoEnter: true },
      update: {},
    });
  }

  private async getConfig() { return this.prisma.hfSimConfig.findFirstOrThrow({ where: { id: 1 } }); }

  private async getOpenSymbolsSet() {
    const open = await this.prisma.hfSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } }, select: { symbol: true },
    });
    return new Set(open.map((t) => t.symbol));
  }

  // ─── API ──────────────────────────────────────────────────────────────────

  getRecentSignals(limit = 50) { return this.recentSignals.slice(0, limit); }
  getDebug() { return { ...this.dbg, timestamp: new Date().toISOString() }; }
  getStatus() {
    return { lastScanAt: this.lastScanAt, scannedPairs: this.scannedCount, candidates: TOP_CANDIDATES, rawSignals: this.lastRawSignals, emitted: this.lastEmitted, isScanning: this.isScanning };
  }

  async getAnalytics() {
    const cfg  = await this.getConfig();
    const all  = await this.prisma.hfSimulatedTrade.findMany({ where: { openedAt: { gte: this.sessionStart } }, orderBy: { openedAt: 'desc' } });
    const closed = all.filter((t) => t.status !== 'open');
    const open   = all.filter((t) => t.status === 'open');
    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0).length;
    const totalPnl    = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate     = closed.length > 0 ? wins / closed.length * 100 : 0;
    const avgWin      = wins > 0 ? closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / wins : 0;
    const avgLoss     = losses > 0 ? Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0)) / losses : 0;
    const grossWin    = closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss   = Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0));
    let peak = cfg.startingCapital, maxDd = 0;
    for (const t of [...closed].reverse()) {
      const cap = t.capitalAfter ?? cfg.startingCapital;
      if (cap > peak) peak = cap;
      const dd = (peak - cap) / peak * 100; if (dd > maxDd) maxDd = dd;
    }
    return {
      totalTrades: all.length, openTrades: open.length, wins, losses,
      winRate: parseFloat(winRate.toFixed(1)), totalPnl: parseFloat(totalPnl.toFixed(3)),
      totalPnlPct: parseFloat((cfg.startingCapital > 0 ? totalPnl / cfg.startingCapital * 100 : 0).toFixed(2)),
      currentCapital: cfg.startingCapital,
      avgWinEur: parseFloat(avgWin.toFixed(3)), avgLossEur: parseFloat(avgLoss.toFixed(3)),
      rrActual: avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : 0,
      profitFactor: grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
      maxDrawdownPct: parseFloat(maxDd.toFixed(1)),
      config: { startingCapital: cfg.startingCapital, marginPerTrade: cfg.marginPerTrade, maxConcurrent: cfg.maxConcurrent, autoEnter: cfg.autoEnter },
    };
  }

  async getOpenTrades() { return this.prisma.hfSimulatedTrade.findMany({ where: { status: 'open', openedAt: { gte: this.sessionStart } }, orderBy: { openedAt: 'desc' } }); }
  async getClosedTrades(limit = 100) { return this.prisma.hfSimulatedTrade.findMany({ where: { status: { not: 'open' }, openedAt: { gte: this.sessionStart } }, orderBy: { closedAt: 'desc' }, take: limit }); }

  async updateConfig(cfg: Partial<{ startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean }>) {
    await this.prisma.hfSimConfig.update({ where: { id: 1 }, data: cfg }); return { ok: true };
  }
  async resetSim() {
    await this.prisma.hfSimulatedTrade.deleteMany();
    await this.prisma.hfSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    return { ok: true };
  }
  async closeManual(id: string) {
    const t = await this.prisma.hfSimulatedTrade.findUnique({ where: { id } });
    if (!t || t.status !== 'open') return { ok: false };
    const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 2).catch(() => []);
    const curr  = ohlcv.length ? (ohlcv.at(-1)![4] as number) : t.entry;
    const isLong = t.direction === 'LONG';
    const pnlRaw = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
    const fee    = (t.positionSize + Math.abs(pnlRaw)) * TAKER_FEE;
    const pnl    = pnlRaw - fee;
    const cfg    = await this.getConfig();
    await this.prisma.hfSimulatedTrade.update({
      where: { id },
      data: { status: 'manual', closePrice: curr, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(fee.toFixed(4)), capitalAfter: parseFloat((cfg.startingCapital + pnl).toFixed(4)), closedAt: new Date() },
    });
    return { ok: true };
  }
}
