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
}

// ─── Costanti ─────────────────────────────────────────────────────────────────
const MIN_VOLUME_24H = 150_000;
const TOP_CANDIDATES = 60;
const CANDLES_5M     = 80;   // EMA34 su 5m stabilizzata con 47+ candle
const CANDLES_1M     = 80;   // finestra di analisi 1m
const MAX_SL_PCT     = 0.80;
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

      const candidates = Object.values(tickers)
        .filter(
          (t) =>
            this.validFuturesSymbols.has(t.symbol) &&
            (t.quoteVolume ?? 0) >= MIN_VOLUME_24H &&
            !openSymbols.has(t.symbol),
        )
        .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
        .slice(0, TOP_CANDIDATES);

      this.scannedCount = this.validFuturesSymbols.size;
      this.dbg = {};

      const cycleSignals: ScannerSignal[] = [];
      for (const ticker of candidates) {
        const sig = await this.analyzePair(ticker);
        if (sig) cycleSignals.push(sig);
        await new Promise((r) => setTimeout(r, 50));
      }
      const dbgStr = Object.entries(this.dbg).map(([k,v]) => `${k}:${v}`).join(' | ');
      this.logger.log(`[VCB debug] ${dbgStr || 'no rejections logged'}`);

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
  // STRATEGIA: "Volatility Contraction Breakout" (VCB v1) — 2026-05-14
  //
  //   Pre-pump/dump detection via squeeze:
  //   1. Mercato si comprime (6 candle con range e volume calanti)
  //   2. Breakout esplosivo fuori dalla zona di compressione
  //      con volume ≥ 2× media e corpo ≥ 40% (non un doji)
  //   3. EMA34 su 5m per conferma trend (scoring bonus)
  //   4. Entry entro 0.25% dal close del breakout — zero chase
  //   5. SL appena fuori dalla zona di compressione, TP = squeeze height × 1.8
  //
  //   Simmetrico LONG/SHORT — opera su futures — time exit 3 min.
  // ═══════════════════════════════════════════════════════════════════════════

  private async analyzePair(ticker: ccxt.Ticker): Promise<ScannerSignal | null> {
    try {
      const sym = ticker.symbol;

      const [raw5m, raw1m] = await Promise.all([
        this.exchange.fetchOHLCV(sym, '5m', undefined, CANDLES_5M),
        this.exchange.fetchOHLCV(sym, '1m', undefined, CANDLES_1M),
      ]);

      if (raw5m.length < 40 || raw1m.length < 35) { this.dbg['L0_no_data'] = (this.dbg['L0_no_data'] ?? 0) + 1; return null; }

      const o1 = raw1m.map(c => c[1] as number);
      const h1 = raw1m.map(c => c[2] as number);
      const l1 = raw1m.map(c => c[3] as number);
      const c1 = raw1m.map(c => c[4] as number);
      const v1 = raw1m.map(c => c[5] as number);
      const c5 = raw5m.map(c => c[4] as number);

      const entry = ticker.last ?? c1.at(-1)!;
      const n     = c1.length;

      // Index layout (1m):
      //   n-1 = candle live (in formazione) — entry = ticker.last
      //   n-2 = BREAKOUT TRIGGER (ultimo candle chiuso)
      //   [n-2-SQZ_WINDOW .. n-3] = SQUEEZE WINDOW (6 candle)
      //   [REF_START .. SQZ_START-1] = finestra di riferimento (fino a 20 candle)

      const SQZ_END   = n - 2;                   // esclusivo — finisce prima del trigger
      const SQZ_START = SQZ_END - SQZ_WINDOW;    // n-8 (incluso)
      const REF_END   = SQZ_START;
      const REF_START = Math.max(0, REF_END - 20);

      if (SQZ_START < 1 || REF_START >= REF_END) return null;

      // ─── Finestra di riferimento (20 candle prima dello squeeze) ─────────
      let refSumRange = 0, refSumVol = 0;
      const refLen = REF_END - REF_START;
      for (let i = REF_START; i < REF_END; i++) {
        refSumRange += h1[i] - l1[i];
        refSumVol   += v1[i];
      }
      const refAvgRange = refSumRange / refLen;
      const refAvgVol   = refSumVol   / refLen;

      // ─── LAYER 1: SQUEEZE QUALITY ─────────────────────────────────────────
      // La zona di compressione deve essere significativamente più stretta
      // e silenziosa della finestra di riferimento.

      const sqzHighs = h1.slice(SQZ_START, SQZ_END);
      const sqzLows  = l1.slice(SQZ_START, SQZ_END);
      const sqzVols  = v1.slice(SQZ_START, SQZ_END);

      const sqzZoneHigh = Math.max(...sqzHighs);
      const sqzZoneLow  = Math.min(...sqzLows);
      const sqzZoneRange = sqzZoneHigh - sqzZoneLow;

      let sqzSumRange = 0, sqzSumVol = 0;
      for (let i = 0; i < SQZ_WINDOW; i++) {
        sqzSumRange += sqzHighs[i] - sqzLows[i];
        sqzSumVol   += sqzVols[i];
      }
      const sqzAvgRange = sqzSumRange / SQZ_WINDOW;
      const sqzAvgVol   = sqzSumVol   / SQZ_WINDOW;

      // Rapporto zona squeeze vs candle di riferimento
      const sqzZoneRel  = refAvgRange > 0 ? sqzZoneRange / refAvgRange : 999;
      const sqzRangeRat = refAvgRange > 0 ? sqzAvgRange  / refAvgRange : 1;
      const sqzVolRat   = refAvgVol   > 0 ? sqzAvgVol    / refAvgVol   : 1;

      if (sqzZoneRel  >= 5.0) { this.dbg['L1_no_sqz']  = (this.dbg['L1_no_sqz']  ?? 0) + 1; return null; }
      if (sqzRangeRat >= 0.90) { this.dbg['L1_no_comp'] = (this.dbg['L1_no_comp'] ?? 0) + 1; return null; }
      if (sqzVolRat   >= 0.95) { this.dbg['L1_vol_hi']  = (this.dbg['L1_vol_hi']  ?? 0) + 1; return null; }

      // ─── LAYER 2: BREAKOUT TRIGGER (n-2, ultimo candle chiuso) ──────────
      // Deve rompere FUORI dalla zona di compressione con volume esplosivo.

      const trigO   = o1[n - 2], trigC = c1[n - 2];
      const trigH   = h1[n - 2], trigL = l1[n - 2];
      const trigVol = v1[n - 2];

      const brkLong  = trigC > sqzZoneHigh;
      const brkShort = trigC < sqzZoneLow;
      if (!brkLong && !brkShort) { this.dbg['L2_no_brk'] = (this.dbg['L2_no_brk'] ?? 0) + 1; return null; }

      const isLong    = brkLong;
      const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

      const allowedDirs = (this.p.allowedDirections ?? 'LONG,SHORT').split(',');
      if (!allowedDirs.includes(direction)) return null;

      // Candle direzionale (verde per LONG, rossa per SHORT)
      if (isLong  && trigC <= trigO) { this.dbg['L2_dir'] = (this.dbg['L2_dir'] ?? 0) + 1; return null; }
      if (!isLong && trigC >= trigO) { this.dbg['L2_dir'] = (this.dbg['L2_dir'] ?? 0) + 1; return null; }

      // Corpo ≥ 40% del range
      const trigRange = trigH - trigL;
      const trigBody  = trigRange > 0 ? Math.abs(trigC - trigO) / trigRange : 0;
      if (trigBody < 0.40) { this.dbg['L2_body'] = (this.dbg['L2_body'] ?? 0) + 1; return null; }

      // Volume spike ≥ 2× riferimento (conferma istituzionale)
      const trigVolR = refAvgVol > 0 ? trigVol / refAvgVol : 1;
      if (trigVolR < 2.0) { this.dbg['L2_vol'] = (this.dbg['L2_vol'] ?? 0) + 1; return null; }

      // Espansione del range: la candle di breakout deve essere più grande delle squeeze
      const rangeExp = sqzAvgRange > 0 ? trigRange / sqzAvgRange : 1;
      if (rangeExp < 1.5) { this.dbg['L2_range'] = (this.dbg['L2_range'] ?? 0) + 1; return null; }

      // Anti-chase: prezzo live entro 0.25% dal close del breakout
      const chaseD = (entry - trigC) / trigC * 100;
      if (isLong  && chaseD >  0.25) { this.dbg['L2_chase'] = (this.dbg['L2_chase'] ?? 0) + 1; return null; }
      if (!isLong && chaseD < -0.25) { this.dbg['L2_chase'] = (this.dbg['L2_chase'] ?? 0) + 1; return null; }

      // ─── LAYER 3: INDICATORI ─────────────────────────────────────────────

      const rsi1m    = this.indicators.rsi(c1, 14);
      if (rsi1m < 25 || rsi1m > 75) { this.dbg['L3_rsi'] = (this.dbg['L3_rsi'] ?? 0) + 1; return null; }

      const atr14_1m = this.indicators.atr(h1, l1, c1, 14);
      const atr1mPct = entry > 0 ? (atr14_1m / entry) * 100 : 0;
      if (atr1mPct < 0.10) { this.dbg['L3_atr'] = (this.dbg['L3_atr'] ?? 0) + 1; return null; }

      const macd1m = this.indicators.macd(c1, 12, 26, 9);
      const macdOk = isLong
        ? macd1m.histogram > macd1m.prevHistogram
        : macd1m.histogram < macd1m.prevHistogram;

      // ─── SL / TP ──────────────────────────────────────────────────────────
      // SL: appena oltre l'estremità opposta della zona di squeeze + buffer ATR
      // TP: misurazione classica = altezza squeeze × RR ratio

      const atrBuf  = Math.max(atr14_1m * 0.25, entry * 0.001);
      const rawSlPct = isLong
        ? (entry - sqzZoneLow  + atrBuf) / entry * 100
        : (sqzZoneHigh - entry + atrBuf) / entry * 100;
      const slPct   = Math.max(rawSlPct, this.p.minSlPct);
      if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; return null; }

      const tp1Pct = slPct * this.p.tp1Rr;
      const tp2Pct = slPct * this.p.tp2Rr;
      if (tp1Pct > 8.0 * atr1mPct) { this.dbg['TP_unreach'] = (this.dbg['TP_unreach'] ?? 0) + 1; return null; }

      // ─── SCORING (max 100 pts) — A+≥70, A≥50, B≥35 ─────────────────────

      let score = 0;
      const reasons: string[] = [];

      // 1. Tightezza zona squeeze vs candle normali: 6-20 pts
      if      (sqzZoneRel < 1.0) { score += 20; reasons.push(`Squeeze ultra tight (${sqzZoneRel.toFixed(2)}× ATR)`); }
      else if (sqzZoneRel < 1.5) { score += 15; reasons.push(`Squeeze tight (${sqzZoneRel.toFixed(2)}×)`); }
      else if (sqzZoneRel < 2.5) { score += 10; }
      else                       { score +=  6; }

      // 2. Compressione volume durante squeeze: 6-20 pts
      if      (sqzVolRat < 0.40) { score += 20; reasons.push(`Vol squeeze forte (${(sqzVolRat*100).toFixed(0)}% avg)`); }
      else if (sqzVolRat < 0.60) { score += 15; reasons.push(`Vol squeeze (${(sqzVolRat*100).toFixed(0)}%)`); }
      else if (sqzVolRat < 0.75) { score += 10; }
      else                       { score +=  6; }

      // 3. Volume spike breakout: 12-25 pts
      if      (trigVolR >= 5.0) { score += 25; reasons.push(`Breakout vol ×${trigVolR.toFixed(1)} (istituzionale)`); }
      else if (trigVolR >= 3.5) { score += 20; reasons.push(`Breakout vol ×${trigVolR.toFixed(1)}`); }
      else if (trigVolR >= 2.5) { score += 15; }
      else                      { score += 12; }

      // 4. Corpo candle breakout: 4-15 pts
      if      (trigBody >= 0.80) { score += 15; reasons.push(`Marubozu ${(trigBody*100).toFixed(0)}%`); }
      else if (trigBody >= 0.65) { score += 11; }
      else if (trigBody >= 0.50) { score +=  7; }
      else                       { score +=  4; }

      // 5. EMA34 su 5m — trend alignment bonus: 0-10 pts
      const ema34_5 = this.indicators.emaArray(c5, 34);
      const e34_5   = ema34_5.at(-1)!;
      const aboveEma34 = entry > e34_5;
      if ((isLong && aboveEma34) || (!isLong && !aboveEma34)) {
        const distEma34 = Math.abs(entry - e34_5) / e34_5 * 100;
        if (distEma34 >= 0.20) { score += 10; reasons.push(`EMA34 allineata (${distEma34.toFixed(2)}% away)`); }
        else                   { score +=  6; }
      }

      // 6. MACD in direzione breakout: 0-5 pts
      if (macdOk) { score += 5; reasons.push(`MACD ${isLong ? '↑' : '↓'}`); }

      // 7. RSI in zona neutrale (breakout più affidabile da 40-60): 3-5 pts
      if (rsi1m >= 40 && rsi1m <= 60) { score += 5; }
      else                             { score += 3; }

      this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);

      if (score < this.p.minEmitScore) { this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1; return null; }

      const grade: ScannerSignal['grade'] =
        score >= 70 ? 'A+' : score >= 50 ? 'A' : score >= 35 ? 'B' : 'C';
      const suggestedLeverage =
        grade === 'A+' ? 10 : grade === 'A' ? 8 : grade === 'B' ? 5 : 3;

      const stopLoss    = parseFloat((entry * (isLong ? 1 - slPct / 100 : 1 + slPct / 100)).toPrecision(6));
      const takeProfit1 = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
      const takeProfit2 = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));

      const rsi5mVal = this.indicators.rsi(c5, 14);
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
        emaConfirm:       (isLong && aboveEma34) || (!isLong && !aboveEma34),
        timeframeConfirm: (isLong && aboveEma34) || (!isLong && !aboveEma34),
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
