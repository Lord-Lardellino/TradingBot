import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { SimulationService } from '../simulation/simulation.service';
import { AiBrainService, BrainParams, BRAIN_DEFAULTS } from '../ai-brain/ai-brain.service';
import { LiveTradingService } from '../live/live-trading.service';

export interface ScannerSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  slPct: number;
  tp1Pct: number;
  tp2Pct: number;
  suggestedLeverage: number;
  priceChange5m: number;
  priceChange15m: number;
  volumeRatio: number;
  rsi5m: number;
  rsi15m: number;
  macdConfirm: boolean;
  emaConfirm: boolean;
  timeframeConfirm: boolean;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[];
  quoteVolume24h: number;
  timestamp: string;
  mexcUrl: string;
  macdHistogram: number;
  vwapAbove: boolean;
  atr14Pct: number;
  rsiAboveSignal: boolean;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema34spark: number[];
}

// ─── Costanti ─────────────────────────────────────────────────────────────────
const MIN_VOLUME_24H  = 10_000_000;  // liquidità reale: spread bassi, slippage contenuto
const TOP_CANDIDATES  = 200;          // per ciclo: ruota su tutti via shuffle
const CANDLES_5M      = 80;
const CANDLES_1M      = 80;
const FIXED_SL_PCT    = 0.50;  // SL fisso: ~€0.50 loss su A+ (10x, €100 pos)
const FIXED_TP1_PCT   = 1.00;  // TP1 fisso: ~€1.00 gain — 1:2 RR garantito
const FIXED_TP2_PCT   = 1.50;  // TP2 fisso: 1:3 RR
const SIGNAL_COOLDOWN = 300_000;
const MAX_LONG_CYCLE  = 3;
const MAX_SHORT_CYCLE = 3;
const SQZ_WINDOW      = 6;   // candle di compressione prima del breakout

@Injectable()
export class ScannerService implements OnModuleInit {
  private readonly logger = new Logger(ScannerService.name);
  private exchange: ccxt.mexc;
  private validFuturesSymbols = new Set<string>();
  private recentSignals: ScannerSignal[] = [];
  private isScanning   = false;
  private lastScanAt: string | null = null;
  private scannedCount = 0;

  private p: BrainParams = { ...BRAIN_DEFAULTS, enabled: false, lastAnalysisAt: null, lastWinRate: null, totalAnalyses: 0 };
  private dbg: Record<string, number> = {};
  private diagSample: string | null = null;
  private lastRawSignals = 0;
  private lastEmitted    = 0;

  constructor(
    private config: ConfigService,
    private indicators: IndicatorsService,
    private events: EventsGateway,
    private simulation: SimulationService,
    private brain: AiBrainService,
    private liveTrading: LiveTradingService,
  ) {}

  async onModuleInit() {
    this.exchange = new ccxt.mexc({
      apiKey:          this.config.get('MEXC_API_KEY', ''),
      secret:          this.config.get('MEXC_API_SECRET', ''),
      enableRateLimit: true,
      options:         { defaultType: 'swap' },
    });
    await this.loadFuturesMarkets();
    this.logger.log(`Scanner: ${this.validFuturesSymbols.size} coppie futures USDT`);
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

  @Cron('*/10 * * * * *')
  async scan() {
    if (this.isScanning || this.validFuturesSymbols.size === 0) return;
    this.isScanning = true;
    this.p = await this.brain.getParams();

    try {
      const [tickers, openSymbols] = await Promise.all([
        this.exchange.fetchTickers([...this.validFuturesSymbols]),
        this.simulation.getOpenSymbols(),
      ]);

      // Pool qualificato: volume solido + nessuna posizione aperta
      const qualifiedPool = Object.values(tickers).filter(
        (t) =>
          this.validFuturesSymbols.has(t.symbol) &&
          (t.quoteVolume ?? 0) >= MIN_VOLUME_24H &&
          !openSymbols.has(t.symbol),
      );
      // Shuffle per ruotare tra tutti i pair qualificati ad ogni ciclo
      // (evita di analizzare sempre le stesse 200 coppie top-volume)
      const shuffled = qualifiedPool.slice().sort(() => Math.random() - 0.5);
      const candidates = shuffled.slice(0, TOP_CANDIDATES);

      this.scannedCount = this.validFuturesSymbols.size;
      this.dbg = {};
      this.diagSample = null;

      const cycleSignals: ScannerSignal[] = [];
      for (const ticker of candidates) {
        const sig = await this.analyzePair(ticker);
        if (sig) cycleSignals.push(sig);
        await new Promise((r) => setTimeout(r, 50));
      }
      const dbgStr = Object.entries(this.dbg)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k,v]) => `${k}:${v}`).join(' | ');
      this.logger.log(`[ERB debug] rejected=${Object.values(this.dbg).filter((_, i) => !Object.keys(this.dbg)[i].startsWith('_')).reduce((a,b)=>a+(b as number),0)} | ${dbgStr || 'no rejections'} | maxScore:${this.dbg['_max']??0}`);
      if (this.diagSample) this.logger.log(`[ERB diag] ${this.diagSample}`);

      // Brain in modalità pausa: scanner continua a girare ma non entra in trade
      if (this.p.mode === 'paused') {
        this.logger.warn('[Scanner] ⏸️ Trading sospeso dal Brain — analizza i log e riattiva manualmente');
        this.lastScanAt = new Date().toISOString();
        return;
      }

      const emitSignals = this.selectBest(cycleSignals);
      this.lastRawSignals = cycleSignals.length;

      for (const signal of emitSignals) {
        // Cooldown ridotto a 2 min per permettere ri-entrata veloce sulla stessa coppia
        const alreadySent = this.recentSignals.find(
          (s) => s.symbol === signal.symbol && Date.now() - new Date(s.timestamp).getTime() < SIGNAL_COOLDOWN,
        );
        if (alreadySent) continue;

        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > 500) this.recentSignals.pop();

        this.events.emitPumpSignal(signal);
        this.simulation.enterTrade(signal).catch(() => {});
        this.liveTrading.enterTrade(signal).catch(() => {});

        this.logger.log(
          `[${signal.grade}] ${signal.direction} ${signal.symbol} | score ${signal.score} | SL ${signal.slPct.toFixed(2)}% | TP1 ${signal.tp1Pct.toFixed(2)}% | leva ${signal.suggestedLeverage}×`,
        );
      }

      this.lastEmitted = emitSignals.length;
      this.lastScanAt  = new Date().toISOString();
      this.events.emitScannerStatus({
        lastScanAt:   this.lastScanAt,
        scannedPairs: this.scannedCount,
        candidates:   candidates.length,
        rawSignals:   this.lastRawSignals,
        emitted:      this.lastEmitted,
      });
    } catch (err) {
      this.logger.error(`scan: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  private selectBest(signals: ScannerSignal[]): ScannerSignal[] {
    const longs  = signals
      .filter((s) => s.direction === 'LONG'  && s.score >= this.p.minEmitScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_LONG_CYCLE);
    const shorts = signals
      .filter((s) => s.direction === 'SHORT' && s.score >= this.p.minEmitScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SHORT_CYCLE);
    return [...longs, ...shorts];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGIA: "EMA34 Rebound" (ERB v7) — 2026-05-16
  //
  //   Principio: SOLO EMA34 + price action. Nessun RSI, MACD, volume come filtro.
  //   Il prezzo tocca l'EMA34 e rimbalza nella direzione del trend.
  //
  //   FILTRI (tutti basati su EMA34 e candele):
  //   1. Lateral: max 2 crossings EMA34 in 20 candle → mercato laterale = no
  //   2. Trend: EMA34 slope > 0.075% (6c) → pendenza marcata obbligatoria
  //   3. Prossimità: LONG [-0.25%, +0.45%] / SHORT [-0.45%, +0.25%] da EMA34
  //      (range allineato all'SL fisso: SL è sempre dall'altra parte dell'EMA34)
  //   4. Touch: wick di una delle 3 candle recenti ha toccato EMA34
  //   5. SL/TP fissi: SL 0.50% + TP1 1.00% (sempre 1:2 RR) → ~-€0.50/+€1.00
  //   6. Dir: candle trigger (n-2) chiude nella direzione del trade
  //   7. Body: corpo >= 30% → no doji / spinning top
  //   8. Trig dist: close del trigger entro 0.35% da EMA34 (no ingressi tardivi)
  //
  //   SCORING (grade: A+ ≥62, A ≥50, B ≥38, C <38 — max 72 pts):
  //   • Slope EMA34          → 8-20 pts
  //   • Distanza entry-EMA34 → 5-25 pts  ← fattore principale
  //   • Wick verso EMA34     → 5-15 pts
  //   • Corpo candle         → 6-12 pts
  // ═══════════════════════════════════════════════════════════════════════════

  private async analyzePair(ticker: ccxt.Ticker): Promise<ScannerSignal | null> {
    try {
      const sym = ticker.symbol;

      const [raw5m, raw1m] = await Promise.all([
        this.exchange.fetchOHLCV(sym, '5m', undefined, CANDLES_5M),
        this.exchange.fetchOHLCV(sym, '1m', undefined, CANDLES_1M),
      ]);

      if (raw5m.length < 40 || raw1m.length < 40) {
        this.dbg['L0_no_data'] = (this.dbg['L0_no_data'] ?? 0) + 1; return null;
      }

      const o1 = raw1m.map(c => c[1] as number);
      const h1 = raw1m.map(c => c[2] as number);
      const l1 = raw1m.map(c => c[3] as number);
      const c1 = raw1m.map(c => c[4] as number);
      const v1 = raw1m.map(c => c[5] as number);
      const c5 = raw5m.map(c => c[4] as number);

      const n     = c1.length;
      const entry = ticker.last ?? c1.at(-1)!;

      // ─── EMA34 su 1m ─────────────────────────────────────────────────────
      const ema34arr = this.indicators.emaArray(c1, 34);
      const ema_n2   = ema34arr.at(-2)!;
      const ema_n8   = ema34arr.at(-8)!;

      // ─── FILTRO 1: LATERAL ────────────────────────────────────────────────
      // Prezzo che oscilla ripetutamente sull'EMA34 = mercato laterale = scarto.
      // Un rimbalzo valido genera 1-2 crossing al massimo.
      let crossings = 0;
      for (let j = 2; j <= 20; j++) {
        const prevAbove = c1[n - j - 1] > ema34arr[n - j - 1];
        const currAbove = c1[n - j]     > ema34arr[n - j];
        if (prevAbove !== currAbove) crossings++;
      }
      // Un bounce valido genera max 2 crossing (scende a EMA, risale). >= 3 = oscillazione laterale.
      if (crossings >= 3) { this.dbg['F1_lateral'] = (this.dbg['F1_lateral'] ?? 0) + 1; return null; }

      // ─── FILTRO 2: TREND EMA34 (slope 6 candle) ──────────────────────────
      // EMA34 deve essere decisamente direzionata. Soglia 0.075%: esclude trend piatti
      // come il cerchio rosso, richiede la pendenza marcata delle frecce verdi.
      const slopePct   = (ema_n2 - ema_n8) / ema_n8 * 100;
      const trendLong  = slopePct >  0.075;
      const trendShort = slopePct < -0.075;
      if (!trendLong && !trendShort) {
        this.dbg['F1_flat'] = (this.dbg['F1_flat'] ?? 0) + 1; return null;
      }

      const isLong    = trendLong;
      const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

      const allowedDirs = (this.p.allowedDirections ?? 'LONG,SHORT').split(',');
      if (!allowedDirs.includes(direction)) return null;

      // ─── FILTRO 3: PROSSIMITÀ EMA34 ───────────────────────────────────────
      // Con SL fisso 0.50%, il prezzo deve essere entro quel range dall'EMA34:
      // SL deve atterrare dall'altra parte dell'EMA34 (senso geometrico del bounce).
      // LONG:  [-0.25%, +0.45%] — price vicino a EMA34, SL sempre sotto EMA34
      // SHORT: [-0.45%, +0.25%] — price vicino a EMA34, SL sempre sopra EMA34
      const emaDist    = (entry - ema_n2) / ema_n2 * 100;
      const emaDistAbs = Math.abs(emaDist);

      if (!this.diagSample) {
        this.diagSample = `[pre-F3] ${sym} ${direction} slope=${slopePct.toFixed(3)}% emaDist=${emaDist.toFixed(2)}% cross=${crossings}`;
      }

      if (isLong  && (emaDist < -0.25 || emaDist > 0.45)) {
        this.dbg['F2_far'] = (this.dbg['F2_far'] ?? 0) + 1; return null;
      }
      if (!isLong && (emaDist >  0.25 || emaDist < -0.45)) {
        this.dbg['F2_far'] = (this.dbg['F2_far'] ?? 0) + 1; return null;
      }

      // ─── FILTRO 4: WICK → EMA34 ───────────────────────────────────────────
      // Almeno una delle 3 candle recenti deve aver toccato/lambito l'EMA34.
      // wickPct < -1.5% = EMA34 neanche sfiorata → non è un vero bounce.
      const bestLow  = Math.min(l1[n-2], l1[n-3], l1[n-4]);
      const bestHigh = Math.max(h1[n-2], h1[n-3], h1[n-4]);
      const wickPct  = isLong
        ? (ema_n2 - bestLow)  / ema_n2 * 100
        : (bestHigh - ema_n2) / ema_n2 * 100;
      if (wickPct < -1.5) { this.dbg['F2_no_touch'] = (this.dbg['F2_no_touch'] ?? 0) + 1; return null; }

      // ─── SL / TP fissi — RR sempre 1:2 ───────────────────────────────────
      // SL e TP fissi per ogni trade: perdita e guadagno sempre identici in %.
      // Per qualità/aggressività si agisce sulla leva, non sullo stop.
      const atr14_1m = this.indicators.atr(h1, l1, c1, 14);
      const atr1mPct = entry > 0 ? atr14_1m / entry * 100 : 0;
      const slPct    = FIXED_SL_PCT;
      const tp1Pct   = FIXED_TP1_PCT;
      const tp2Pct   = FIXED_TP2_PCT;

      // Dati del candle n-2 (ultimo chiuso, candle di conferma bounce)
      const trigO = o1[n - 2], trigC = c1[n - 2];
      const trigH = h1[n - 2], trigL = l1[n - 2];

      // ─── FILTRO 5: DIREZIONE CANDLE TRIGGER ───────────────────────────────
      // Il candle di conferma deve chiudere nella direzione del bounce.
      const trigRange     = trigH - trigL;
      const trigBody      = trigRange > 0 ? Math.abs(trigC - trigO) / trigRange : 0;
      const bullishCandle = trigC > trigO;
      if ( isLong && !bullishCandle) { this.dbg['F3_dir'] = (this.dbg['F3_dir'] ?? 0) + 1; return null; }
      if (!isLong &&  bullishCandle) { this.dbg['F3_dir'] = (this.dbg['F3_dir'] ?? 0) + 1; return null; }
      if (trigBody < 0.30) { this.dbg['F3_body'] = (this.dbg['F3_body'] ?? 0) + 1; return null; }

      // ─── FILTRO 6: TRIGGER CLOSE VICINO ALL'EMA34 ────────────────────────
      // La candela di bounce deve essersi chiusa entro 0.35% dall'EMA34.
      // Con SL fisso 0.50%, se il trigger è già oltre 0.35% il RR è compromesso.
      const trigCloseDist = (trigC - ema_n2) / ema_n2 * 100;
      if (isLong  && trigCloseDist > 0.35) { this.dbg['F2_trig_far'] = (this.dbg['F2_trig_far'] ?? 0) + 1; return null; }
      if (!isLong && trigCloseDist < -0.35) { this.dbg['F2_trig_far'] = (this.dbg['F2_trig_far'] ?? 0) + 1; return null; }

      // ─── SCORING (basato solo su qualità EMA34 bounce) ────────────────────
      let score = 0;
      const reasons: string[] = [];

      // 1. Forza trend EMA34 (8-20 pts)
      const absSlope = Math.abs(slopePct);
      if      (absSlope > 0.15) { score += 20; reasons.push(`Trend forte ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.09) { score += 15; reasons.push(`Trend ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.06) { score += 12; }
      else                      { score +=  8; }

      // 2. Prossimità entry → EMA34 (5-25 pts) — più vicino = migliore RR
      if      (emaDistAbs < 0.10) { score += 25; reasons.push(`EMA34 ${emaDist.toFixed(2)}%`); }
      else if (emaDistAbs < 0.30) { score += 20; reasons.push(`EMA34 ${emaDist.toFixed(2)}%`); }
      else if (emaDistAbs < 0.60) { score += 14; }
      else                        { score +=  7; }

      // 3. Wick verso EMA34 (5-15 pts) — mostra la pressione di rimbalzo
      if      (wickPct > 0.10) { score += 15; reasons.push(`Wick EMA34 ${wickPct.toFixed(2)}%`); }
      else if (wickPct > 0)    { score += 12; reasons.push(`Sfiorato EMA34`); }
      else if (wickPct > -0.30){ score +=  9; }
      else                     { score +=  5; }

      // 4. Corpo candle trigger (6-12 pts) — già filtrato >= 30%
      if      (trigBody >= 0.70) { score += 12; reasons.push(`Corpo ${(trigBody*100).toFixed(0)}%`); }
      else if (trigBody >= 0.50) { score +=  9; reasons.push(`Corpo ${(trigBody*100).toFixed(0)}%`); }
      else                       { score +=  6; }

      this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
      this.diagSample = `[OK] ${sym} ${direction} slope=${slopePct.toFixed(3)}% emaDist=${emaDist.toFixed(2)}% trigClose=${trigCloseDist.toFixed(2)}% wick=${wickPct.toFixed(2)}% body=${(trigBody*100).toFixed(0)}% cross=${crossings} score=${score}`;

      if (score < this.p.minEmitScore) { this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1; return null; }

      const grade: ScannerSignal['grade'] =
        score >= 62 ? 'A+' : score >= 50 ? 'A' : score >= 38 ? 'B' : 'C';
      const suggestedLeverage =
        grade === 'A+' ? 10 : grade === 'A' ? 8 : grade === 'B' ? 5 : 3;

      const stopLoss    = parseFloat((entry * (isLong ? 1 - slPct / 100 : 1 + slPct / 100)).toPrecision(6));
      const takeProfit1 = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
      const takeProfit2 = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));

      // Metriche informative per UI (non usate come filtri)
      const refVols   = v1.slice(n - 22, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const trigVolR  = refAvgVol > 0 ? v1[n - 2] / refAvgVol : 1;
      const rsi1m    = this.indicators.rsi(c1, 14);
      const rsi5mVal = this.indicators.rsi(c5, 14);
      const macd1m   = this.indicators.macd(c1, 12, 26, 9);
      const macdOk   = isLong ? macd1m.histogram > macd1m.prevHistogram : macd1m.histogram < macd1m.prevHistogram;
      const vwap     = this.calculateDayVwap(raw5m);

      return {
        id:               `${sym}_${Date.now()}`,
        symbol:           sym,
        direction,
        entry,
        stopLoss,
        takeProfit1,
        takeProfit2,
        slPct:            parseFloat(slPct.toFixed(3)),
        tp1Pct:           parseFloat(tp1Pct.toFixed(3)),
        tp2Pct:           parseFloat(tp2Pct.toFixed(3)),
        suggestedLeverage,
        priceChange5m:    parseFloat(((entry - (c1.at(-6) ?? c1[0])) / (c1.at(-6) ?? c1[0]) * 100).toFixed(3)),
        priceChange15m:   parseFloat(((c5.at(-1)! - (c5.at(-4) ?? c5[0])) / (c5.at(-4) ?? c5[0]) * 100).toFixed(3)),
        volumeRatio:      parseFloat(trigVolR.toFixed(2)),
        rsi5m:            parseFloat(rsi5mVal.toFixed(1)),
        rsi15m:           parseFloat(rsi1m.toFixed(1)),
        macdConfirm:      macdOk,
        emaConfirm:       trendLong || trendShort,
        timeframeConfirm: trendLong || trendShort,
        score,
        grade,
        reasons,
        quoteVolume24h:   ticker.quoteVolume ?? 0,
        timestamp:        new Date().toISOString(),
        mexcUrl:          this.buildMexcUrl(sym),
        macdHistogram:    parseFloat(macd1m.histogram.toFixed(6)),
        vwapAbove:        entry > vwap,
        atr14Pct:         parseFloat(atr1mPct.toFixed(3)),
        rsiAboveSignal:   rsi1m > 50,
        sparkline:   raw1m.slice(-70).map(c => ({
          t: c[0] as number,
          o: c[1] as number,
          h: c[2] as number,
          l: c[3] as number,
          c: c[4] as number,
        })),
        ema34spark:  ema34arr.slice(-70),
      };
    } catch {
      this.dbg['L0_error'] = (this.dbg['L0_error'] ?? 0) + 1;
      return null;
    }
  }

  // ─── VWAP giornaliero UTC ────────────────────────────────────────────────
  private calculateDayVwap(raw5m: number[][]): number {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const dayTs = startOfDay.getTime();
    const candles = raw5m.filter(c => c[0] >= dayTs);
    const use = candles.length >= 5 ? candles : raw5m.slice(-30);
    let cumTPV = 0, cumVol = 0;
    for (const c of use) {
      const tp = ((c[2] as number) + (c[3] as number) + (c[4] as number)) / 3;
      cumTPV += tp * (c[5] as number);
      cumVol  += c[5] as number;
    }
    return cumVol > 0 ? cumTPV / cumVol : (raw5m.at(-1)![4] as number);
  }

  private buildMexcUrl(symbol: string): string {
    return `https://futures.mexc.com/exchange/${symbol.replace('/USDT:USDT', '_USDT')}`;
  }

  getRecentSignals(limit = 50) { return this.recentSignals.slice(0, limit); }
  getDebug() { return { ...this.dbg, timestamp: new Date().toISOString() }; }
  getStatus() {
    return {
      lastScanAt:   this.lastScanAt,
      scannedPairs: this.scannedCount,
      totalSignals: this.recentSignals.length,
      isScanning:   this.isScanning,
      rawSignals:   this.lastRawSignals,
      emitted:      this.lastEmitted,
    };
  }
}
