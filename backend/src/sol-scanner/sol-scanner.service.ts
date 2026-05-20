import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ─── Interfaccia ──────────────────────────────────────────────────────────────

export interface SolSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  patternType: 1 | 2;              // 1=VWAP_BOUNCE, 2=EMA_PULLBACK
  signalType: 'VWAP_BOUNCE' | 'EMA_PULLBACK';
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
  vwap: number;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[];
  timestamp: string;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema9spark: number[];
  ema20spark: number[];
  vwapSpark: number[];
}

// ─── Costanti ─────────────────────────────────────────────────────────────────
// Strategia: VWAP Scalper — rimbalzo su VWAP rolling + EMA9/20/50 pullback
// Ricerca: pro scalper su SOL/USDT 1m usano VWAP come magnete istituzionale +
// EMA stack 9/20/50 per filtrare il trend + RSI(5) per timing estremi

const SYMBOL          = 'SOL/USDT:USDT';
const CANDLES_1M      = 150;
const VWAP_WINDOW     = 120;    // 2h rolling VWAP
const SIGNAL_COOLDOWN = 360_000; // 6 min → max ~20 segnali/notte
const MAX_SL_PCT      = 1.20;   // SL più ampio per evitare falsi stop
const MIN_SL_PCT      = 0.18;   // copre round-trip fee + rumore minimo
const ATR_SL_MULT     = 1.20;   // ATR×1.2 = buffer realistico per SOL 1m
const TP1_RR          = 2.0;
const TP2_RR          = 3.5;
const BODY_MIN        = 0.45;   // corpo forte: riduce segnali falsi
const BOUNCE_PCT      = 0.002;  // 0.2% proximity → zona più stretta
const VOL_MIN         = 1.2;    // volume minimo per entrare
const TAKER_FEE       = 0.00038;
const MIN_SCORE       = 52;     // soglia alta: solo A/A+

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class SolScannerService implements OnModuleInit {
  private readonly logger = new Logger(SolScannerService.name);
  private exchange: ccxt.mexc;
  private recentSignals: SolSignal[] = [];
  private isAnalyzing   = false;
  private lastScanAt:   string | null = null;
  private lastSignalAt: string | null = null;
  private dbg: Record<string, number> = {};
  private readonly sessionStart = new Date();

  constructor(
    private config:     ConfigService,
    private indicators: IndicatorsService,
    private events:     EventsGateway,
    private prisma:     PrismaService,
  ) {}

  async onModuleInit() {
    const apiKey  = this.config.get('MEXC_API_KEY', '');
    const secret  = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await this.ensureConfig();
    this.logger.log(`[SOL] VWAP Scalper attivo su ${SYMBOL} — check ogni 15s`);
  }

  // ─── Scan ogni 15 secondi ──────────────────────────────────────────────────

  @Cron('*/15 * * * * *')
  async scan() {
    if (this.isAnalyzing) return;
    this.isAnalyzing = true;
    try {
      const sig = await this.analyze();
      this.lastScanAt = new Date().toISOString();

      this.events.emitSolStatus({
        lastScanAt:   this.lastScanAt,
        lastSignalAt: this.lastSignalAt,
        isScanning:   false,
        debug:        { ...this.dbg },
      });

      if (!sig) return;

      // Cooldown 90s
      const last = this.recentSignals[0];
      if (last && Date.now() - new Date(last.timestamp).getTime() < SIGNAL_COOLDOWN) return;

      this.recentSignals.unshift(sig);
      if (this.recentSignals.length > 200) this.recentSignals.pop();
      this.lastSignalAt = sig.timestamp;

      this.events.emitSolSignal(sig);
      await this.enterSimTrade(sig);

      this.logger.log(
        `[SOL] [${sig.grade}] ${sig.signalType} ${sig.direction} score=${sig.score} SL=${sig.slPct.toFixed(2)}% entry=${sig.entry.toFixed(2)}`,
      );
    } catch (err) {
      this.logger.error(`[SOL] scan: ${err.message}`);
    } finally {
      this.isAnalyzing = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Core analysis: VWAP Bounce + EMA Pullback
  // ═══════════════════════════════════════════════════════════════════════════

  private async analyze(): Promise<SolSignal | null> {
    try {
      const raw = await this.exchange.fetchOHLCV(SYMBOL, '1m', undefined, CANDLES_1M);
      if (raw.length < 60) return null;

      const n = raw.length;
      const op = raw.map(r => r[1] as number);
      const hi = raw.map(r => r[2] as number);
      const lo = raw.map(r => r[3] as number);
      const cl = raw.map(r => r[4] as number);
      const vo = raw.map(r => r[5] as number);

      // ── Indicatori ──────────────────────────────────────────────────────────
      const ema9arr  = this.indicators.emaArray(cl, 9);
      const ema20arr = this.indicators.emaArray(cl, 20);
      const ema50arr = this.indicators.emaArray(cl, 50);
      const rsi5arr  = this.indicators.rsiArray(cl, 5);
      const atrVal   = this.indicators.atr(hi, lo, cl, 14);
      const volR     = this.indicators.volumeRatio(vo, 20);

      const e9   = ema9arr.at(-1)!;
      const e9p3 = ema9arr.at(-4) ?? ema9arr.at(-1)!;
      const e20  = ema20arr.at(-1)!;
      const e50  = ema50arr.at(-1)!;
      const rsi  = rsi5arr.at(-1)!;
      const rsiP = rsi5arr.at(-2) ?? rsi;

      // Rolling VWAP su VWAP_WINDOW barre
      let cumTPV = 0, cumVol = 0;
      const vwapArr: number[] = [];
      for (let i = n - VWAP_WINDOW; i < n; i++) {
        const tp = (hi[i] + lo[i] + cl[i]) / 3;
        cumTPV += tp * vo[i];
        cumVol += vo[i];
        vwapArr.push(cumVol > 0 ? cumTPV / cumVol : cl[i]);
      }
      const vwap = vwapArr.at(-1)!;

      // Body helper
      const bdy = (i: number) => {
        const r = hi[i] - lo[i];
        return r > 0 ? Math.abs(cl[i] - op[i]) / r : 0;
      };

      const entry = cl[n - 1]; // ultima candela chiusa = entry

      // ── SETUP 1: VWAP BOUNCE ───────────────────────────────────────────────
      // Istituzionalmente: quando SOL torna sul VWAP si attivano algoritmi di
      // acquisto/vendita (benchmark VWAP). Il primo rimbalzo è il segnale.

      // LONG: la barra n-2 ha toccato la zona VWAP con wick, n-1 conferma rialzo
      // Il wick deve essere NELLA zona VWAP (entro BOUNCE_PCT sopra, o al max 2× sotto)
      const vwapTouchL = lo[n-2] <= vwap * (1 + BOUNCE_PCT) && lo[n-2] >= vwap * (1 - BOUNCE_PCT * 2);
      const vwapConfL  = cl[n-1] > op[n-1] && bdy(n-1) >= BODY_MIN && cl[n-1] >= vwap * 0.9990;
      const vwapRsiL   = rsi >= 28 && rsi <= 48 && rsi >= rsiP - 3; // RSI dal lato oversold

      // SHORT: barra n-2 tocca VWAP dall'alto, n-1 conferma ribasso
      const vwapTouchS = hi[n-2] >= vwap * (1 - BOUNCE_PCT) && hi[n-2] <= vwap * (1 + BOUNCE_PCT * 2);
      const vwapConfS  = cl[n-1] < op[n-1] && bdy(n-1) >= BODY_MIN && cl[n-1] <= vwap * 1.0010;
      const vwapRsiS   = rsi >= 52 && rsi <= 72 && rsi <= rsiP + 3; // RSI dal lato overbought

      if ((vwapTouchL && vwapConfL && vwapRsiL && volR >= VOL_MIN) || (vwapTouchS && vwapConfS && vwapRsiS && volR >= VOL_MIN)) {
        const isLong  = vwapTouchL && vwapConfL && vwapRsiL;
        const slLevel = isLong
          ? Math.min(lo[n-2], lo[n-1]) - atrVal * ATR_SL_MULT
          : Math.max(hi[n-2], hi[n-1]) + atrVal * ATR_SL_MULT;
        const slPct   = Math.abs(entry - slLevel) / entry * 100;

        if (slPct < MIN_SL_PCT) {
          this.dbg['F_sl_min'] = (this.dbg['F_sl_min'] ?? 0) + 1;
        } else if (slPct > MAX_SL_PCT) {
          this.dbg['F_sl_max'] = (this.dbg['F_sl_max'] ?? 0) + 1;
        } else {
          const sig = this.score(
            'VWAP_BOUNCE', isLong, entry, slLevel, slPct,
            rsi, volR, vwap, atrVal, e9, e20, e50, e9p3,
            n, cl, hi, lo, op, raw, ema9arr, ema20arr, vwapArr,
          );
          if (sig) return sig;
        }
      } else {
        if (!vwapTouchL && !vwapTouchS) this.dbg['F_vwap'] = (this.dbg['F_vwap'] ?? 0) + 1;
        else if (!vwapConfL && !vwapConfS) this.dbg['F_body'] = (this.dbg['F_body'] ?? 0) + 1;
        else this.dbg['F_rsi'] = (this.dbg['F_rsi'] ?? 0) + 1;
      }

      // ── SETUP 2: EMA PULLBACK ──────────────────────────────────────────────
      // Trend-following: EMA9 > 20 > 50 (bull) o inverso (bear).
      // Prezzo torna a testare EMA20 (dinamico supporto/resistenza) e rimbalza.

      const bullStack = e9 > e20 && e20 > e50;
      const bearStack = e9 < e20 && e20 < e50;
      const e9Slope   = (e9 - e9p3) / e9p3 * 100;

      // LONG: stack rialzista, wick tocca zona EMA20, n-1 conferma rialzo
      const emaTouchL = lo[n-2] <= e20 * (1 + BOUNCE_PCT) && lo[n-2] >= e20 * (1 - BOUNCE_PCT * 2);
      const emaConfL  = cl[n-1] > op[n-1] && bdy(n-1) >= BODY_MIN && cl[n-1] > e20 * 0.9990;
      const emaRsiL   = rsi >= 30 && rsi <= 50; // strettamente oversold → neutrale

      // SHORT: stack ribassista, wick tocca zona EMA20 dall'alto, n-1 conferma
      const emaTouchS = hi[n-2] >= e20 * (1 - BOUNCE_PCT) && hi[n-2] <= e20 * (1 + BOUNCE_PCT * 2);
      const emaConfS  = cl[n-1] < op[n-1] && bdy(n-1) >= BODY_MIN && cl[n-1] < e20 * 1.0010;
      const emaRsiS   = rsi >= 50 && rsi <= 70; // strettamente neutrale → overbought

      const emaL = bullStack && e9Slope > 0.030 && emaTouchL && emaConfL && emaRsiL && volR >= VOL_MIN;
      const emaS = bearStack && e9Slope < -0.030 && emaTouchS && emaConfS && emaRsiS && volR >= VOL_MIN;

      if (emaL || emaS) {
        const isLong  = emaL;
        const slLevel = isLong
          ? Math.min(lo[n-2], lo[n-1]) - atrVal * ATR_SL_MULT
          : Math.max(hi[n-2], hi[n-1]) + atrVal * ATR_SL_MULT;
        const slPct   = Math.abs(entry - slLevel) / entry * 100;

        if (slPct < MIN_SL_PCT) {
          this.dbg['F_sl_min'] = (this.dbg['F_sl_min'] ?? 0) + 1;
        } else if (slPct > MAX_SL_PCT) {
          this.dbg['F_sl_max'] = (this.dbg['F_sl_max'] ?? 0) + 1;
        } else {
          const sig = this.score(
            'EMA_PULLBACK', isLong, entry, slLevel, slPct,
            rsi, volR, vwap, atrVal, e9, e20, e50, e9p3,
            n, cl, hi, lo, op, raw, ema9arr, ema20arr, vwapArr,
          );
          if (sig) return sig;
        }
      } else {
        if (!bullStack && !bearStack) this.dbg['F_ema_stack'] = (this.dbg['F_ema_stack'] ?? 0) + 1;
        else if (!emaTouchL && !emaTouchS) this.dbg['F_ema_touch'] = (this.dbg['F_ema_touch'] ?? 0) + 1;
        else if (!emaConfL && !emaConfS) this.dbg['F_body2'] = (this.dbg['F_body2'] ?? 0) + 1;
        else this.dbg['F_rsi2'] = (this.dbg['F_rsi2'] ?? 0) + 1;
      }

      return null;
    } catch (err) {
      this.dbg['L0_error'] = (this.dbg['L0_error'] ?? 0) + 1;
      return null;
    }
  }

  // ─── Scoring ──────────────────────────────────────────────────────────────

  private score(
    signalType: 'VWAP_BOUNCE' | 'EMA_PULLBACK',
    isLong: boolean,
    entry: number,
    slLevel: number,
    slPct: number,
    rsi: number,
    volR: number,
    vwap: number,
    atr: number,
    e9: number,
    e20: number,
    e50: number,
    e9p3: number,
    n: number,
    cl: number[],
    hi: number[],
    lo: number[],
    op: number[],
    raw: any[],
    ema9arr: number[],
    ema20arr: number[],
    vwapArr: number[],
  ): SolSignal | null {
    let pts = 0;
    const reasons: string[] = [];

    // Tipo segnale
    if (signalType === 'VWAP_BOUNCE') { pts += 20; reasons.push('VWAP Bounce'); }
    else                              { pts += 14; reasons.push('EMA Pullback'); }

    // RSI estremo (più lontano da 50 = miglior setup di rimbalzo)
    const rsiDist = isLong ? 50 - rsi : rsi - 50;
    if      (rsiDist >= 22) { pts += 24; reasons.push(`RSI ${rsi.toFixed(0)}`); }
    else if (rsiDist >= 12) { pts += 17; }
    else if (rsiDist >= 3)  { pts += 9; }
    else                    { pts += 3; }

    // Volume
    if      (volR >= 3.0) { pts += 16; reasons.push(`Vol ×${volR.toFixed(1)}`); }
    else if (volR >= 2.0) { pts += 13; reasons.push(`Vol ×${volR.toFixed(1)}`); }
    else if (volR >= 1.3) { pts += 9; }
    else if (volR >= 0.8) { pts += 5; }
    else                  { pts += 0; }

    // EMA stack completo
    const stackOk = isLong ? (e9 > e20 && e20 > e50) : (e9 < e20 && e20 < e50);
    const partOk  = isLong ? (e9 > e20 || e20 > e50) : (e9 < e20 || e20 < e50);
    if      (stackOk) { pts += 15; reasons.push('EMA stacked'); }
    else if (partOk)  { pts +=  7; }

    // Prezzo rispetto VWAP (corretto lato)
    const distVwap = (entry - vwap) / vwap * 100;
    if (isLong && distVwap >= 0 && distVwap < 0.3) { pts += 8; reasons.push('sopra VWAP'); }
    if (!isLong && distVwap <= 0 && distVwap > -0.3) { pts += 8; reasons.push('sotto VWAP'); }

    // SL tight bonus
    if      (slPct < 0.18) { pts += 12; reasons.push(`SL ${slPct.toFixed(2)}%`); }
    else if (slPct < 0.32) { pts +=  7; }
    else if (slPct < 0.50) { pts +=  3; }

    // Body della candela di conferma
    const bdy = (hi[n-1] - lo[n-1]) > 0 ? Math.abs(cl[n-1] - op[n-1]) / (hi[n-1] - lo[n-1]) : 0;
    if      (bdy >= 0.70) { pts += 8; }
    else if (bdy >= 0.45) { pts += 5; }
    else                  { pts += 2; }

    this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, pts);

    if (pts < MIN_SCORE) {
      this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1;
      return null;
    }

    const grade: SolSignal['grade'] = pts >= 72 ? 'A+' : pts >= 58 ? 'A' : pts >= 52 ? 'B' : 'C';
    const tp1Pct = slPct * TP1_RR;
    const tp2Pct = slPct * TP2_RR;
    const takeProfit1 = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
    const takeProfit2 = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));
    const suggestedLeverage = Math.min(Math.round(4 / slPct), 100);

    const sparkSlice = raw.slice(-60);
    const e9sl  = ema9arr.slice(-60);
    const e20sl = ema20arr.slice(-60);

    return {
      id:               `SOL_${Date.now()}`,
      symbol:           SYMBOL,
      direction:        isLong ? 'LONG' : 'SHORT',
      patternType:      signalType === 'VWAP_BOUNCE' ? 1 : 2,
      signalType,
      entry:            parseFloat(entry.toFixed(3)),
      stopLoss:         parseFloat(slLevel.toFixed(3)),
      takeProfit1,
      takeProfit2,
      slPct:            parseFloat(slPct.toFixed(3)),
      tp1Pct:           parseFloat(tp1Pct.toFixed(3)),
      tp2Pct:           parseFloat(tp2Pct.toFixed(3)),
      suggestedLeverage,
      volumeRatio:      parseFloat(volR.toFixed(2)),
      rsi:              parseFloat(rsi.toFixed(1)),
      vwap:             parseFloat(vwap.toFixed(3)),
      score:            pts,
      grade,
      reasons,
      timestamp:        new Date().toISOString(),
      mexcUrl:          'https://futures.mexc.com/exchange/SOL_USDT',
      sparkline: sparkSlice.map(r => ({
        t: r[0] as number, o: r[1] as number, h: r[2] as number,
        l: r[3] as number, c: r[4] as number,
      })),
      ema9spark:  e9sl,
      ema20spark: e20sl,
      vwapSpark:  vwapArr.slice(-60),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIMULAZIONE
  // ═══════════════════════════════════════════════════════════════════════════

  private async ensureConfig() {
    const existing = await this.prisma.solSimConfig.findUnique({ where: { id: 1 } });
    if (existing) return existing;
    return this.prisma.solSimConfig.create({
      data: { startingCapital: 500, marginPerTrade: 10, maxConcurrent: 2, autoEnter: true },
    });
  }

  private async currentCapital(): Promise<number> {
    const cfg    = await this.ensureConfig();
    const closed = await this.prisma.solSimulatedTrade.findMany({
      where: { status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
    });
    return closed.reduce((cap, t) => cap + (t.pnl ?? 0), cfg.startingCapital);
  }

  private async enterSimTrade(signal: SolSignal) {
    const cfg = await this.ensureConfig();
    if (!cfg.autoEnter) return;

    const openCount = await this.prisma.solSimulatedTrade.count({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (openCount >= cfg.maxConcurrent) return;

    const capital      = await this.currentCapital();
    const TARGET_RISK  = 0.50;
    const positionSize = TARGET_RISK * 100 / signal.slPct;
    const leverage     = Math.min(Math.round(positionSize / cfg.marginPerTrade), 125);
    const fees         = positionSize * TAKER_FEE * 2;

    const trade = await this.prisma.solSimulatedTrade.create({
      data: {
        id:            `SOL_${Date.now()}`,
        symbol:        signal.symbol,
        direction:     signal.direction,
        patternType:   signal.patternType,
        entry:         signal.entry,
        stopLoss:      signal.stopLoss,
        takeProfit1:   signal.takeProfit1,
        takeProfit2:   signal.takeProfit2,
        leverage,
        marginEur:     cfg.marginPerTrade,
        positionSize,
        riskEur:       parseFloat(TARGET_RISK.toFixed(4)),
        grade:         signal.grade,
        score:         signal.score,
        status:        'open',
        fees:          parseFloat(fees.toFixed(4)),
        capitalBefore: parseFloat(capital.toFixed(4)),
      },
    });
    this.events.emitSolTrade(trade);
    this.logger.log(
      `[SOL-SIM] ${signal.direction} | ${signal.signalType} | risk €${TARGET_RISK} | sz €${positionSize.toFixed(2)} | leva ${leverage}× | ${signal.grade}`,
    );
  }

  private async closeTrade(trade: any, closePrice: number, status: string) {
    const isLong    = trade.direction === 'LONG';
    const priceDiff = isLong
      ? (closePrice - trade.entry) / trade.entry
      : (trade.entry - closePrice) / trade.entry;
    const pnl          = trade.positionSize * priceDiff - trade.fees;
    const capitalAfter = trade.capitalBefore + pnl;

    const updated = await this.prisma.solSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status,
        closePrice:   parseFloat(closePrice.toFixed(8)),
        pnl:          parseFloat(pnl.toFixed(4)),
        capitalAfter: parseFloat(capitalAfter.toFixed(4)),
        closedAt:     new Date(),
      },
    });
    this.events.emitSolTrade(updated);
  }

  @Cron('*/5 * * * * *')
  async checkOpenTrades() {
    const openTrades = await this.prisma.solSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (!openTrades.length) return;

    let ticker: ccxt.Ticker;
    try { ticker = await this.exchange.fetchTicker(SYMBOL); } catch { return; }
    const price = ticker.last ?? 0;
    if (!price) return;

    const positionUpdates: any[] = [];
    for (const trade of openTrades) {
      const isLong = trade.direction === 'LONG';
      const hitSL  = isLong ? price <= trade.stopLoss    : price >= trade.stopLoss;
      const hitTP2 = isLong ? price >= trade.takeProfit2 : price <= trade.takeProfit2;
      const hitTP1 = isLong ? price >= trade.takeProfit1 : price <= trade.takeProfit1;

      if (hitSL || hitTP1 || hitTP2) {
        const status     = hitTP2 ? 'tp2' : hitTP1 ? 'tp1' : 'sl';
        const closePrice = hitTP2 ? trade.takeProfit2 : hitTP1 ? trade.takeProfit1 : trade.stopLoss;
        await this.closeTrade(trade, closePrice, status);
      } else {
        const priceDiff        = isLong
          ? (price - trade.entry) / trade.entry
          : (trade.entry - price) / trade.entry;
        const unrealizedPnl    = trade.positionSize * priceDiff - trade.fees;
        const unrealizedPnlPct = (unrealizedPnl / trade.capitalBefore) * 100;
        positionUpdates.push({
          id:               trade.id,
          currentPrice:     parseFloat(price.toPrecision(8)),
          unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(4)),
          unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
        });
      }
    }
    if (positionUpdates.length) this.events.emitSolPositions(positionUpdates);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  getRecentSignals(limit = 50) { return this.recentSignals.slice(0, limit); }

  getStatus() {
    return {
      lastScanAt:   this.lastScanAt,
      lastSignalAt: this.lastSignalAt,
      isScanning:   this.isAnalyzing,
      debug:        { ...this.dbg },
    };
  }

  async getAnalytics() {
    const cfg    = await this.ensureConfig();
    const closed = await this.prisma.solSimulatedTrade.findMany({
      where:   { status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
      orderBy: { closedAt: 'asc' },
    });
    const opens = await this.prisma.solSimulatedTrade.count({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });

    const totalNetPnl   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFeesPaid = closed.reduce((s, t) => s + (t.fees ?? 0), 0);
    const wins   = closed.filter(t => (t.pnl ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    const winRate      = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
    const avgWinEur    = wins.length   > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLossEur   = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0) / losses.length : 0;
    const totalWins    = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalLosses  = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    let peak = cfg.startingCapital, maxDD = 0, runCap = cfg.startingCapital;
    const equityCurve: { date: string; capital: number }[] = [
      { date: new Date(Date.now() - 86400000).toISOString(), capital: cfg.startingCapital },
    ];
    for (const t of closed) {
      runCap += (t.pnl ?? 0);
      if (runCap > peak) peak = runCap;
      const dd = ((peak - runCap) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      equityCurve.push({ date: (t.closedAt ?? new Date()).toISOString(), capital: parseFloat(runCap.toFixed(4)) });
    }

    // Breakdown per tipo segnale
    const vwapTrades = closed.filter(t => t.patternType === 1);
    const emaTrades  = closed.filter(t => t.patternType === 2);

    return {
      startingCapital: cfg.startingCapital,
      currentCapital:  parseFloat((cfg.startingCapital + totalNetPnl).toFixed(4)),
      totalPnl:        parseFloat(totalNetPnl.toFixed(4)),
      totalPnlPct:     parseFloat((totalNetPnl / cfg.startingCapital * 100).toFixed(2)),
      totalFeesPaid:   parseFloat(totalFeesPaid.toFixed(4)),
      totalTrades:     closed.length,
      openTrades:      opens,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         parseFloat(winRate.toFixed(1)),
      avgWinEur:       parseFloat(avgWinEur.toFixed(4)),
      avgLossEur:      parseFloat(avgLossEur.toFixed(4)),
      rrActual:        parseFloat((avgLossEur > 0 ? avgWinEur / avgLossEur : 0).toFixed(2)),
      profitFactor:    parseFloat(Math.min(profitFactor, 999).toFixed(2)),
      maxDrawdownPct:  parseFloat(maxDD.toFixed(2)),
      equityCurve,
      breakdown: {
        vwap: { trades: vwapTrades.length, wins: vwapTrades.filter(t => (t.pnl ?? 0) > 0).length },
        ema:  { trades: emaTrades.length,  wins: emaTrades.filter(t => (t.pnl ?? 0) > 0).length },
      },
      config: {
        startingCapital: cfg.startingCapital,
        marginPerTrade:  cfg.marginPerTrade,
        maxConcurrent:   cfg.maxConcurrent,
        autoEnter:       cfg.autoEnter,
      },
    };
  }

  async getOpenTrades() {
    return this.prisma.solSimulatedTrade.findMany({
      where:   { status: 'open', openedAt: { gte: this.sessionStart } },
      orderBy: { openedAt: 'desc' },
    });
  }

  async getClosedTrades(limit = 100) {
    return this.prisma.solSimulatedTrade.findMany({
      where:   { status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
      orderBy: { closedAt: 'desc' },
      take:    limit,
    });
  }

  async updateConfig(data: Partial<{ startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean }>) {
    return this.prisma.solSimConfig.update({ where: { id: 1 }, data });
  }

  async resetSim() {
    await this.prisma.solSimulatedTrade.deleteMany({});
  }

  async closeManual(id: string) {
    const trade = await this.prisma.solSimulatedTrade.findUnique({ where: { id } });
    if (!trade || trade.status !== 'open') return;
    const ticker = await this.exchange.fetchTicker(SYMBOL);
    await this.closeTrade(trade, ticker.last, 'manual');
  }
}
