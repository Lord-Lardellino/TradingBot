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
const MIN_VOLUME_24H  = 3_000_000;   // soglia ridotta per ampliare pool candidati
const TOP_CANDIDATES  = 200;          // per ciclo: ruota su tutti via shuffle
const CANDLES_5M      = 120;
const CANDLES_1M      = 150;
const MAX_SL_PCT      = 2.0;   // SL al low/high del bounce candle (più ampio del wick trigger)
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
    const apiKey = this.config.get('MEXC_API_KEY', '');
    const secret = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
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

  @Cron('*/3 * * * * *')
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
      .filter((s) => s.direction === 'LONG'  && (s.grade === 'A+' || s.grade === 'A'))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_LONG_CYCLE);
    const shorts = signals
      .filter((s) => s.direction === 'SHORT' && (s.grade === 'A+' || s.grade === 'A'))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SHORT_CYCLE);
    return [...longs, ...shorts];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRATEGIA: "EMA34 4-Candle Bounce" (ERB v9) — 2026-05-18
  //
  //   Pattern 4 candele:
  //   LONG:  n-5=RED, n-4=RED  (bounce su EMA34, almeno uno wick EMA34)
  //          n-3=GREEN, n-2=GREEN (conferme, corpo ≥40%) → ENTRY al close n-2
  //          SL = min(low n-5, low n-4)
  //
  //   SHORT: n-5=GREEN, n-4=GREEN (bounce su EMA34)
  //          n-3=RED, n-2=RED (conferme, corpo ≥40%) → ENTRY al close n-2
  //          SL = max(high n-5, high n-4)
  //
  //   FILTRI:
  //   1. Lateral: max 2 crossings EMA34 in 20 candle
  //   2. Trend:   EMA34 slope > 0.045% su 6 candle
  //   3. EMA stability: slope EMA34 non ha cambiato direzione ≥4 volte in 20c
  //   4. Bounce wick: best wick delle 2 bounce candle entro 0.30% sopra/sotto EMA34
  //   5. SL max 2.0% → leva = 5/slPct (€0.50 risk / €0.75 profit a TP1 1:1.5)
  //
  //   SCORING (grade: A+ ≥55, A ≥42, B ≥32, C <32 — max 65 pts):
  //   • Slope EMA34           → 8-20 pts
  //   • Profondità bounce EMA → 5-20 pts
  //   • Corpi conferme (avg)  → 5-15 pts
  //   • Volume conf2          → 3-10 pts
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

      const n = c1.length;

      // ─── EMA34 su 1m ─────────────────────────────────────────────────────
      const ema34arr = this.indicators.emaArray(c1, 34);
      if (ema34arr.length < 8) return null;
      const ema_n2 = ema34arr.at(-2)!;
      const ema_n4 = ema34arr.at(-4)!;
      const ema_n8 = ema34arr.at(-8)!;

      // ─── FILTRO 1: LATERAL ────────────────────────────────────────────────
      let crossings = 0;
      for (let j = 2; j <= 20; j++) {
        const prevAbove = c1[n - j - 1] > ema34arr[n - j - 1];
        const currAbove = c1[n - j]     > ema34arr[n - j];
        if (prevAbove !== currAbove) crossings++;
      }
      if (crossings >= 3) { this.dbg['F1_lateral'] = (this.dbg['F1_lateral'] ?? 0) + 1; return null; }

      // ─── FILTRO 2: TREND EMA34 (slope 6 candle) ──────────────────────────
      const slopePct   = (ema_n2 - ema_n8) / ema_n8 * 100;
      const trendLong  = slopePct >  0.08;
      const trendShort = slopePct < -0.08;
      if (!trendLong && !trendShort) {
        this.dbg['F1_flat'] = (this.dbg['F1_flat'] ?? 0) + 1; return null;
      }

      const isLong    = trendLong;
      const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

      const allowedDirs = (this.p.allowedDirections ?? 'LONG,SHORT').split(',');
      if (!allowedDirs.includes(direction)) return null;

      // ─── FILTRO EMA34 STABILITY ───────────────────────────────────────────
      {
        let emaReversals = 0;
        let lastSign = 0;
        for (let j = n - 22; j <= n - 3; j++) {
          if (j < 1 || j >= ema34arr.length) continue;
          const slope = ema34arr[j] - ema34arr[j - 1];
          const sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
          if (sign !== 0 && lastSign !== 0 && sign !== lastSign) emaReversals++;
          if (sign !== 0) lastSign = sign;
        }
        if (emaReversals >= 4) { this.dbg['F_ema_osc'] = (this.dbg['F_ema_osc'] ?? 0) + 1; return null; }
      }

      // ─── FILTRO: TREND FRESCO — slope era già forte 20-26 candle fa? (=20-26 min) ─
      // Soglia = stessa del trend corrente: trend stantio solo se ERA GIÀ sopra soglia
      if (ema34arr.length >= 32) {
        const ema_n20 = ema34arr.at(-20)!;
        const ema_n26 = ema34arr.at(-26)!;
        const slopeOld = ema_n26 > 0 ? (ema_n20 - ema_n26) / ema_n26 * 100 : 0;
        if (isLong  && slopeOld >  0.08) { this.dbg['F_stale'] = (this.dbg['F_stale'] ?? 0) + 1; return null; }
        if (!isLong && slopeOld < -0.08) { this.dbg['F_stale'] = (this.dbg['F_stale'] ?? 0) + 1; return null; }
      }

      if (!this.diagSample) {
        this.diagSample = `[pre-pat] ${sym} ${direction} slope=${slopePct.toFixed(3)}% cross=${crossings}`;
      }

      // ─── 4-CANDLE BOUNCE PATTERN ──────────────────────────────────────────
      // n-5, n-4 = due bounce candle (RED per LONG, GREEN per SHORT) — almeno 1 wick su EMA34
      // n-3, n-2 = due conferme (GREEN per LONG, RED per SHORT) — corpo ≥40% → ENTRY al close n-2
      const b1O = o1[n-5], b1C = c1[n-5], b1H = h1[n-5], b1L = l1[n-5];
      const b2O = o1[n-4], b2C = c1[n-4], b2H = h1[n-4], b2L = l1[n-4];
      const conf1O = o1[n-3], conf1C = c1[n-3], conf1H = h1[n-3], conf1L = l1[n-3];
      const conf2O = o1[n-2], conf2C = c1[n-2], conf2H = h1[n-2], conf2L = l1[n-2];

      const entry = conf2C;

      if (isLong) {
        if (b1C >= b1O)       { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (b2C >= b2O)       { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (conf1C <= conf1O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
        if (conf2C <= conf2O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
      } else {
        if (b1C <= b1O)       { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (b2C <= b2O)       { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (conf1C >= conf1O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
        if (conf2C >= conf2O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
      }

      // Corpi sostanziosi su tutte e 4 le candele (≥40%)
      const b1Range    = b1H - b1L;    const b1Body    = b1Range > 0    ? Math.abs(b1C - b1O) / b1Range : 0;
      const b2Range    = b2H - b2L;    const b2Body    = b2Range > 0    ? Math.abs(b2C - b2O) / b2Range : 0;
      const conf1Range = conf1H - conf1L; const conf1Body = conf1Range > 0 ? Math.abs(conf1C - conf1O) / conf1Range : 0;
      const conf2Range = conf2H - conf2L; const conf2Body = conf2Range > 0 ? Math.abs(conf2C - conf2O) / conf2Range : 0;
      if (b1Body    < 0.40) { this.dbg['F3_body'] = (this.dbg['F3_body'] ?? 0) + 1; return null; }
      if (b2Body    < 0.40) { this.dbg['F3_body'] = (this.dbg['F3_body'] ?? 0) + 1; return null; }
      if (conf1Body < 0.40) { this.dbg['F3_body'] = (this.dbg['F3_body'] ?? 0) + 1; return null; }
      if (conf2Body < 0.40) { this.dbg['F3_body'] = (this.dbg['F3_body'] ?? 0) + 1; return null; }

      // ─── BOUNCE CANDLE: best wick delle 2 bounce verso EMA34 ─────────────
      // LONG:  min low dei 2 bounce entro 0.30% sopra EMA34 (o sotto = perfetto)
      // SHORT: max high dei 2 bounce entro 0.30% sotto EMA34 (o sopra = perfetto)
      const bestBounceLow  = Math.min(b1L, b2L);
      const bestBounceHigh = Math.max(b1H, b2H);
      const bounceLowToEma  = (bestBounceLow  - ema_n4) / ema_n4 * 100;
      const bounceHighToEma = (ema_n4 - bestBounceHigh) / ema_n4 * 100;
      if (isLong  && bounceLowToEma  > 0.30) { this.dbg['F_bounce_touch'] = (this.dbg['F_bounce_touch'] ?? 0) + 1; return null; }
      if (!isLong && bounceHighToEma > 0.30) { this.dbg['F_bounce_touch'] = (this.dbg['F_bounce_touch'] ?? 0) + 1; return null; }

      // ─── SL: extreme delle 2 bounce candle ───────────────────────────────
      const dynSlLevel = isLong ? bestBounceLow : bestBounceHigh;
      const slPct      = Math.max(Math.abs(entry - dynSlLevel) / entry * 100, 0.05);
      if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; return null; }
      const tp1Pct = slPct * 2.0;
      const tp2Pct = slPct * 3.0;

      // ─── VOLUME: ultima candela di conferma ───────────────────────────────
      const refVols   = v1.slice(n - 22, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const trigVolR  = refAvgVol > 0 ? v1[n - 2] / refAvgVol : 1;

      // ─── SCORING ──────────────────────────────────────────────────────────
      let score = 0;
      const reasons: string[] = [];

      // 1. Forza trend EMA34 (8-20 pts)
      const absSlope = Math.abs(slopePct);
      if      (absSlope > 0.15) { score += 20; reasons.push(`Trend forte ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.09) { score += 15; reasons.push(`Trend ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.06) { score += 12; }
      else                      { score +=  8; }

      // 2. Qualità bounce su EMA34 (5-20 pts)
      const bounceDepth = isLong ? -bounceLowToEma : -bounceHighToEma; // >0 = wick sotto/sopra EMA
      if      (bounceDepth >  0.15) { score += 20; reasons.push(`Bounce ${bounceDepth.toFixed(2)}%`); }
      else if (bounceDepth >  0.05) { score += 15; reasons.push(`Bounce EMA34`); }
      else if (bounceDepth >= 0.0)  { score += 10; reasons.push(`Touch EMA34`); }
      else                          { score +=  5; }

      // 3. Corpi di tutte e 4 le candele (5-15 pts)
      const avgBody = (b1Body + b2Body + conf1Body + conf2Body) / 4;
      if      (avgBody >= 0.70) { score += 15; reasons.push(`Corpi ${(avgBody*100).toFixed(0)}%`); }
      else if (avgBody >= 0.55) { score += 11; reasons.push(`Corpi ${(avgBody*100).toFixed(0)}%`); }
      else                      { score +=  5; }

      // 4. Volume conf2 (3-10 pts)
      if      (trigVolR >= 2.0) { score += 10; }
      else if (trigVolR >= 1.5) { score +=  7; }
      else                      { score +=  3; }

      this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
      this.diagSample = `[OK] ${sym} ${direction} slope=${slopePct.toFixed(3)}% depth=${bounceDepth.toFixed(2)}% body=${(avgBody*100).toFixed(0)}% vol=${trigVolR.toFixed(1)}x sl=${slPct.toFixed(2)}% tp1=${tp1Pct.toFixed(2)}% score=${score}`;

      if (score < this.p.minEmitScore) { this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1; return null; }

      const grade: ScannerSignal['grade'] =
        score >= 55 ? 'A+' : score >= 42 ? 'A' : score >= 32 ? 'B' : 'C';
      // Leva per €0.50 risk a €10 margin: 5/slPct
      const suggestedLeverage = Math.min(Math.round(5 / slPct), 100);

      const stopLoss    = parseFloat(dynSlLevel.toPrecision(6));
      const takeProfit1 = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
      const takeProfit2 = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));

      // Metriche informative per UI
      const atr14_1m = this.indicators.atr(h1, l1, c1, 14);
      const atr1mPct = entry > 0 ? atr14_1m / entry * 100 : 0;
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
