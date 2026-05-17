import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ─── Interfacce ───────────────────────────────────────────────────────────────

export interface MtfSignal {
  id: string;
  tf: string;
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
  volumeRatio: number;
  rsi: number;
  macdConfirm: boolean;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[];
  quoteVolume24h: number;
  timestamp: string;
  mexcUrl: string;
  atr14Pct: number;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema34spark: number[];
}

export interface MtfStatus {
  tf: string;
  lastScanAt: string | null;
  scannedPairs: number;
  candidates: number;
  rawSignals: number;
  emitted: number;
  isScanning: boolean;
}

export interface MtfAnalytics {
  tf: string;
  startingCapital: number;
  currentCapital: number;
  totalPnl: number;
  totalPnlPct: number;
  totalGrossPnl: number;
  totalFeesPaid: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinEur: number;
  avgLossEur: number;
  rrActual: number;
  profitFactor: number;
  maxDrawdownPct: number;
  bestTrade: any | null;
  worstTrade: any | null;
  byGrade: Record<string, { trades: number; wins: number; pnl: number; winRate: number }>;
  equityCurve: { date: string; capital: number }[];
  config: { startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean };
}

// ─── Configurazione per timeframe ─────────────────────────────────────────────

interface TfConfig {
  candles: number;
  slopeThreshold: number;   // % su 6 candle EMA34
  crossingsWindow: number;  // candle per il controllo lateral
  fixedSlPct: number;
  fixedTp1Pct: number;
  fixedTp2Pct: number;
  emaDistLong: [number, number];   // [min, max] emaDist per LONG
  emaDistShort: [number, number];  // [min, max] emaDist per SHORT
  trigCloseDistMax: number;        // max | trigCloseDist | per LONG/SHORT
  wickThreshold: number;           // min wickPct (negativo = non ha toccato EMA)
  cooldown: number;                // ms tra segnali per stessa coppia
}

const TF_CONFIGS: Record<string, TfConfig> = {
  '5m': {
    candles:           80,
    slopeThreshold:    0.040,
    crossingsWindow:   20,
    fixedSlPct:        0.60,
    fixedTp1Pct:       1.20,
    fixedTp2Pct:       1.80,
    emaDistLong:       [-0.25, 0.60],
    emaDistShort:      [-0.60, 0.25],
    trigCloseDistMax:  0.45,
    wickThreshold:     -2.0,
    cooldown:          300_000,   // 5 min
  },
  '15m': {
    candles:           80,
    slopeThreshold:    0.030,
    crossingsWindow:   20,
    fixedSlPct:        0.80,
    fixedTp1Pct:       1.60,
    fixedTp2Pct:       2.40,
    emaDistLong:       [-0.35, 0.80],
    emaDistShort:      [-0.80, 0.35],
    trigCloseDistMax:  0.60,
    wickThreshold:     -2.5,
    cooldown:          900_000,   // 15 min
  },
  '1h': {
    candles:           80,
    slopeThreshold:    0.020,
    crossingsWindow:   15,
    fixedSlPct:        1.20,
    fixedTp1Pct:       2.40,
    fixedTp2Pct:       3.60,
    emaDistLong:       [-0.50, 1.20],
    emaDistShort:      [-1.20, 0.50],
    trigCloseDistMax:  0.90,
    wickThreshold:     -3.0,
    cooldown:          3_600_000, // 1 ora
  },
};

const MIN_VOLUME_24H  = 10_000_000;
const TOP_CANDIDATES  = 150;
const TAKER_FEE       = 0.00038;

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class MtfScannerService implements OnModuleInit {
  private readonly logger = new Logger(MtfScannerService.name);
  private exchange: ccxt.mexc;
  private validFuturesSymbols = new Set<string>();

  // Segnali recenti per TF
  private signals: Record<string, MtfSignal[]> = { '5m': [], '15m': [], '1h': [] };
  // Stato scan per TF
  private scanning: Record<string, boolean> = { '5m': false, '15m': false, '1h': false };
  private lastScanAt: Record<string, string | null> = { '5m': null, '15m': null, '1h': null };
  private statusData: Record<string, { candidates: number; rawSignals: number; emitted: number }> = {
    '5m':  { candidates: 0, rawSignals: 0, emitted: 0 },
    '15m': { candidates: 0, rawSignals: 0, emitted: 0 },
    '1h':  { candidates: 0, rawSignals: 0, emitted: 0 },
  };
  private dbgData: Record<string, Record<string, number>> = { '5m': {}, '15m': {}, '1h': {} };
  private readonly sessionStart = new Date();

  constructor(
    private config:     ConfigService,
    private indicators: IndicatorsService,
    private events:     EventsGateway,
    private prisma:     PrismaService,
  ) {}

  async onModuleInit() {
    this.exchange = new ccxt.mexc({
      apiKey:          this.config.get('MEXC_API_KEY', ''),
      secret:          this.config.get('MEXC_API_SECRET', ''),
      enableRateLimit: true,
      options:         { defaultType: 'swap' },
    });
    await this.loadFuturesMarkets();
    await this.initSimConfigs();
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

  // 5m scanner: ogni 60 secondi
  @Cron('0 */1 * * * *')
  async scan5m() { await this.scanTf('5m'); }

  // 15m scanner: ogni 2 minuti
  @Cron('0 */2 * * * *')
  async scan15m() { await this.scanTf('15m'); }

  // 1h scanner: ogni 5 minuti
  @Cron('0 */5 * * * *')
  async scan1h() { await this.scanTf('1h'); }

  private async scanTf(tf: string) {
    if (this.scanning[tf] || this.validFuturesSymbols.size === 0) return;
    this.scanning[tf] = true;

    try {
      const tickers = await this.exchange.fetchTickers([...this.validFuturesSymbols]);
      const openSym = await this.getOpenSymbols(tf);

      const pool = Object.values(tickers).filter(
        (t) => this.validFuturesSymbols.has(t.symbol) &&
               (t.quoteVolume ?? 0) >= MIN_VOLUME_24H &&
               !openSym.has(t.symbol),
      );
      const shuffled   = pool.slice().sort(() => Math.random() - 0.5);
      const candidates = shuffled.slice(0, TOP_CANDIDATES);

      this.statusData[tf].candidates = candidates.length;
      this.dbgData[tf] = {};

      const cycleSignals: MtfSignal[] = [];
      for (const ticker of candidates) {
        const sig = await this.analyzeForTf(ticker, tf);
        if (sig) cycleSignals.push(sig);
        await new Promise((r) => setTimeout(r, 60));
      }

      const dbg = Object.entries(this.dbgData[tf]).map(([k, v]) => `${k}:${v}`).join(' | ');
      this.logger.log(`[MTF-${tf}] ${cycleSignals.length} raw | ${dbg || 'no rejections'}`);

      this.statusData[tf].rawSignals = cycleSignals.length;

      const emitList = cycleSignals
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      let emitted = 0;
      const cfg = TF_CONFIGS[tf];
      for (const signal of emitList) {
        const alreadySent = this.signals[tf].find(
          (s) => s.symbol === signal.symbol &&
                 Date.now() - new Date(s.timestamp).getTime() < cfg.cooldown,
        );
        if (alreadySent) continue;

        this.signals[tf].unshift(signal);
        if (this.signals[tf].length > 200) this.signals[tf].pop();

        this.events.emitMtfSignal(signal);
        await this.enterSimTrade(signal, tf);
        emitted++;

        this.logger.log(
          `[MTF-${tf}] [${signal.grade}] ${signal.direction} ${signal.symbol} score=${signal.score} SL=${cfg.fixedSlPct}% TP1=${cfg.fixedTp1Pct}%`,
        );
      }

      this.statusData[tf].emitted = emitted;
      this.lastScanAt[tf] = new Date().toISOString();
      this.events.emitMtfStatus({
        tf,
        lastScanAt:   this.lastScanAt[tf],
        scannedPairs: this.validFuturesSymbols.size,
        candidates:   candidates.length,
        rawSignals:   cycleSignals.length,
        emitted,
        isScanning:   false,
      });
    } catch (err) {
      this.logger.error(`scanTf(${tf}): ${err.message}`);
    } finally {
      this.scanning[tf] = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ANALISI ERB v7 — identica alla 1m, parametri adattati al timeframe
  // ═══════════════════════════════════════════════════════════════════════════

  private async analyzeForTf(ticker: ccxt.Ticker, tf: string): Promise<MtfSignal | null> {
    const cfg = TF_CONFIGS[tf];
    const dbg = this.dbgData[tf];

    try {
      const sym = ticker.symbol;
      const raw = await this.exchange.fetchOHLCV(sym, tf, undefined, cfg.candles);
      if (raw.length < 40) { dbg['L0_no_data'] = (dbg['L0_no_data'] ?? 0) + 1; return null; }

      const o = raw.map(c => c[1] as number);
      const h = raw.map(c => c[2] as number);
      const l = raw.map(c => c[3] as number);
      const c = raw.map(c => c[4] as number);
      const v = raw.map(c => c[5] as number);
      const n = c.length;
      const entry = ticker.last ?? c.at(-1)!;

      // EMA34
      const ema34arr = this.indicators.emaArray(c, 34);
      const ema_n2   = ema34arr.at(-2)!;
      const ema_n8   = ema34arr.at(-8)!;

      // F1 — LATERAL (crossings in N candle)
      let crossings = 0;
      for (let j = 2; j <= cfg.crossingsWindow; j++) {
        const prevAbove = c[n - j - 1] > ema34arr[n - j - 1];
        const currAbove = c[n - j]     > ema34arr[n - j];
        if (prevAbove !== currAbove) crossings++;
      }
      if (crossings >= 3) { dbg['F1_lateral'] = (dbg['F1_lateral'] ?? 0) + 1; return null; }

      // F2 — TREND (slope EMA34)
      const slopePct   = (ema_n2 - ema_n8) / ema_n8 * 100;
      const trendLong  = slopePct >  cfg.slopeThreshold;
      const trendShort = slopePct < -cfg.slopeThreshold;
      if (!trendLong && !trendShort) { dbg['F1_flat'] = (dbg['F1_flat'] ?? 0) + 1; return null; }

      const isLong    = trendLong;
      const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

      // F3 — PROSSIMITÀ EMA34 (allineata con SL fisso)
      const emaDist    = (entry - ema_n2) / ema_n2 * 100;
      const emaDistAbs = Math.abs(emaDist);
      const [dLongMin, dLongMax]   = cfg.emaDistLong;
      const [dShortMin, dShortMax] = cfg.emaDistShort;
      if (isLong  && (emaDist < dLongMin  || emaDist > dLongMax))  { dbg['F2_far'] = (dbg['F2_far'] ?? 0) + 1; return null; }
      if (!isLong && (emaDist < dShortMin || emaDist > dShortMax)) { dbg['F2_far'] = (dbg['F2_far'] ?? 0) + 1; return null; }

      // F4 — WICK verso EMA34
      const bestLow  = Math.min(l[n-2], l[n-3], l[n-4]);
      const bestHigh = Math.max(h[n-2], h[n-3], h[n-4]);
      const wickPct  = isLong
        ? (ema_n2 - bestLow)  / ema_n2 * 100
        : (bestHigh - ema_n2) / ema_n2 * 100;
      if (wickPct < cfg.wickThreshold) { dbg['F2_no_touch'] = (dbg['F2_no_touch'] ?? 0) + 1; return null; }

      // F5 — SL check: entry non troppo lontana da EMA34 rispetto all'SL fisso
      const distToEmaPct = (isLong ? Math.max(entry - ema_n2, 0) : Math.max(ema_n2 - entry, 0)) / entry * 100;
      if (distToEmaPct > cfg.fixedSlPct) { dbg['SL_wide'] = (dbg['SL_wide'] ?? 0) + 1; return null; }

      // F6 — CANDLE TRIGGER (n-2): direzione + corpo
      const trigO = o[n - 2], trigC = c[n - 2];
      const trigH = h[n - 2], trigL = l[n - 2];
      const trigRange     = trigH - trigL;
      const trigBody      = trigRange > 0 ? Math.abs(trigC - trigO) / trigRange : 0;
      const bullishCandle = trigC > trigO;
      if ( isLong && !bullishCandle) { dbg['F3_dir'] = (dbg['F3_dir'] ?? 0) + 1; return null; }
      if (!isLong &&  bullishCandle) { dbg['F3_dir'] = (dbg['F3_dir'] ?? 0) + 1; return null; }
      if (trigBody < 0.30)           { dbg['F3_body'] = (dbg['F3_body'] ?? 0) + 1; return null; }

      // F7 — TRIGGER CLOSE vicino a EMA34
      const trigCloseDist = (trigC - ema_n2) / ema_n2 * 100;
      if (isLong  && trigCloseDist >  cfg.trigCloseDistMax) { dbg['F2_trig_far'] = (dbg['F2_trig_far'] ?? 0) + 1; return null; }
      if (!isLong && trigCloseDist < -cfg.trigCloseDistMax) { dbg['F2_trig_far'] = (dbg['F2_trig_far'] ?? 0) + 1; return null; }

      // ─── SCORING ──────────────────────────────────────────────────────────
      let score = 0;
      const reasons: string[] = [];

      const absSlope = Math.abs(slopePct);
      if      (absSlope > 0.12) { score += 20; reasons.push(`Trend forte ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.07) { score += 15; reasons.push(`Trend ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.04) { score += 12; }
      else                      { score +=  8; }

      if      (emaDistAbs < 0.10) { score += 25; reasons.push(`EMA34 ${emaDist.toFixed(2)}%`); }
      else if (emaDistAbs < 0.30) { score += 20; reasons.push(`EMA34 ${emaDist.toFixed(2)}%`); }
      else if (emaDistAbs < 0.70) { score += 14; }
      else                        { score +=  7; }

      if      (wickPct > 0.10) { score += 15; reasons.push(`Wick EMA34 ${wickPct.toFixed(2)}%`); }
      else if (wickPct > 0)    { score += 12; reasons.push(`Sfiorato EMA34`); }
      else if (wickPct > -0.50){ score +=  9; }
      else                     { score +=  5; }

      if      (trigBody >= 0.70) { score += 12; reasons.push(`Corpo ${(trigBody*100).toFixed(0)}%`); }
      else if (trigBody >= 0.50) { score +=  9; reasons.push(`Corpo ${(trigBody*100).toFixed(0)}%`); }
      else                       { score +=  6; }

      dbg['_max'] = Math.max(dbg['_max'] ?? 0, score);

      // Minimo 30 punti per emissione
      if (score < 30) { dbg['SCORE'] = (dbg['SCORE'] ?? 0) + 1; return null; }

      const grade: MtfSignal['grade'] =
        score >= 62 ? 'A+' : score >= 50 ? 'A' : score >= 38 ? 'B' : 'C';
      const leverage =
        grade === 'A+' ? 8 : grade === 'A' ? 6 : grade === 'B' ? 4 : 3;

      const slPct  = cfg.fixedSlPct;
      const tp1Pct = cfg.fixedTp1Pct;
      const tp2Pct = cfg.fixedTp2Pct;

      const stopLoss    = parseFloat((entry * (isLong ? 1 - slPct / 100 : 1 + slPct / 100)).toPrecision(6));
      const takeProfit1 = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
      const takeProfit2 = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));

      // Metriche informative
      const refVols   = v.slice(n - 22, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const trigVolR  = refAvgVol > 0 ? v[n - 2] / refAvgVol : 1;
      const atr14    = this.indicators.atr(h, l, c, 14);
      const atr14Pct = entry > 0 ? atr14 / entry * 100 : 0;
      const rsi14    = this.indicators.rsi(c, 14);
      const macd1    = this.indicators.macd(c, 12, 26, 9);
      const macdOk   = isLong ? macd1.histogram > macd1.prevHistogram : macd1.histogram < macd1.prevHistogram;

      return {
        id:               `${sym}_${tf}_${Date.now()}`,
        tf,
        symbol:           sym,
        direction,
        entry,
        stopLoss,
        takeProfit1,
        takeProfit2,
        slPct:            parseFloat(slPct.toFixed(3)),
        tp1Pct:           parseFloat(tp1Pct.toFixed(3)),
        tp2Pct:           parseFloat(tp2Pct.toFixed(3)),
        suggestedLeverage: leverage,
        volumeRatio:      parseFloat(trigVolR.toFixed(2)),
        rsi:              parseFloat(rsi14.toFixed(1)),
        macdConfirm:      macdOk,
        score,
        grade,
        reasons,
        quoteVolume24h:   ticker.quoteVolume ?? 0,
        timestamp:        new Date().toISOString(),
        mexcUrl:          `https://futures.mexc.com/exchange/${sym.replace('/USDT:USDT', '_USDT')}`,
        atr14Pct:         parseFloat(atr14Pct.toFixed(3)),
        sparkline: raw.slice(-70).map(rc => ({
          t: rc[0] as number, o: rc[1] as number, h: rc[2] as number,
          l: rc[3] as number, c: rc[4] as number,
        })),
        ema34spark: ema34arr.slice(-70),
      };
    } catch {
      dbg['L0_error'] = (dbg['L0_error'] ?? 0) + 1;
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SIMULAZIONE MTF
  // ═══════════════════════════════════════════════════════════════════════════

  private async initSimConfigs() {
    for (const tf of ['5m', '15m', '1h']) {
      await this.ensureConfig(tf);
    }
  }

  private async ensureConfig(tf: string) {
    const existing = await this.prisma.mtfSimConfig.findUnique({ where: { tf } });
    if (existing) return existing;
    return this.prisma.mtfSimConfig.create({
      data: { tf, startingCapital: 500, marginPerTrade: 10, maxConcurrent: 3, autoEnter: true },
    });
  }

  private async getOpenSymbols(tf: string): Promise<Set<string>> {
    const open = await this.prisma.mtfSimulatedTrade.findMany({
      where:  { tf, status: 'open', openedAt: { gte: this.sessionStart } },
      select: { symbol: true },
    });
    return new Set(open.map((t) => t.symbol));
  }

  private async currentCapital(tf: string): Promise<number> {
    const cfg = await this.ensureConfig(tf);
    const closed = await this.prisma.mtfSimulatedTrade.findMany({
      where: { tf, status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
    });
    return closed.reduce((cap, t) => cap + (t.pnl ?? 0), cfg.startingCapital);
  }

  private async enterSimTrade(signal: MtfSignal, tf: string) {
    const cfg = await this.ensureConfig(tf);
    if (!cfg.autoEnter) return;

    const openCount = await this.prisma.mtfSimulatedTrade.count({
      where: { tf, status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (openCount >= cfg.maxConcurrent) return;

    const already = await this.prisma.mtfSimulatedTrade.findFirst({
      where: { tf, symbol: signal.symbol, status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (already) return;

    const capital      = await this.currentCapital(tf);
    const marginEur    = cfg.marginPerTrade;
    const positionSize = marginEur * signal.suggestedLeverage;
    const riskEur      = positionSize * (signal.slPct / 100);
    const fees         = positionSize * TAKER_FEE * 2;

    const trade = await this.prisma.mtfSimulatedTrade.create({
      data: {
        id:           `${signal.symbol}_${tf}_${Date.now()}`,
        tf,
        symbol:       signal.symbol,
        direction:    signal.direction,
        entry:        signal.entry,
        stopLoss:     signal.stopLoss,
        takeProfit1:  signal.takeProfit1,
        takeProfit2:  signal.takeProfit2,
        leverage:     signal.suggestedLeverage,
        marginEur,
        positionSize,
        riskEur:      parseFloat(riskEur.toFixed(4)),
        grade:        signal.grade,
        score:        signal.score,
        status:       'open',
        fees:         parseFloat(fees.toFixed(4)),
        capitalBefore: parseFloat(capital.toFixed(4)),
      },
    });
    this.events.emitMtfTrade(trade);

    // Prezzo immediato appena il trade apre
    try {
      const ticker = await this.exchange.fetchTicker(trade.symbol);
      const price  = ticker.last ?? 0;
      if (price) {
        const isLong    = trade.direction === 'LONG';
        const priceDiff = isLong
          ? (price - trade.entry) / trade.entry
          : (trade.entry - price) / trade.entry;
        const unrealizedPnl    = trade.positionSize * priceDiff - trade.fees;
        const unrealizedPnlPct = (unrealizedPnl / trade.capitalBefore) * 100;
        this.events.emitMtfPositions([{
          id:               trade.id,
          currentPrice:     parseFloat(price.toPrecision(8)),
          unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(4)),
          unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
        }]);
      }
    } catch { /* ignora errori di prezzo immediato */ }
  }

  private async closeTrade(trade: any, closePrice: number, status: string) {
    const isLong    = trade.direction === 'LONG';
    const priceDiff = isLong
      ? (closePrice - trade.entry) / trade.entry
      : (trade.entry - closePrice) / trade.entry;
    const grossPnl    = trade.positionSize * priceDiff;
    const pnl         = grossPnl - trade.fees;
    const capitalAfter = trade.capitalBefore + pnl;

    const updated = await this.prisma.mtfSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status,
        closePrice:   parseFloat(closePrice.toFixed(8)),
        pnl:          parseFloat(pnl.toFixed(4)),
        capitalAfter: parseFloat(capitalAfter.toFixed(4)),
        closedAt:     new Date(),
      },
    });
    this.events.emitMtfTrade(updated);
  }

  // Controlla prezzi ogni 2s per tutti i TF
  @Cron('*/2 * * * * *')
  async checkOpenTrades() {
    const openTrades = await this.prisma.mtfSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (!openTrades.length) return;

    const symbols = [...new Set(openTrades.map((t) => t.symbol))];
    let tickers: Record<string, ccxt.Ticker>;
    try {
      tickers = await this.exchange.fetchTickers(symbols);
    } catch { return; }

    const positionUpdates: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[] = [];

    for (const trade of openTrades) {
      const ticker = tickers[trade.symbol];
      const price  = ticker?.last ?? 0;
      if (!price) continue;

      const isLong = trade.direction === 'LONG';
      const hitSL  = isLong ? price <= trade.stopLoss   : price >= trade.stopLoss;
      const hitTP1 = isLong ? price >= trade.takeProfit1 : price <= trade.takeProfit1;
      const hitTP2 = isLong ? price >= trade.takeProfit2 : price <= trade.takeProfit2;

      if (hitSL || hitTP1 || hitTP2) {
        let status: string;
        let closePrice: number;
        if (hitTP2)      { status = 'tp2'; closePrice = trade.takeProfit2; }
        else if (hitTP1) { status = 'tp1'; closePrice = trade.takeProfit1; }
        else             { status = 'sl';  closePrice = trade.stopLoss; }
        await this.closeTrade(trade, closePrice, status);
      } else {
        const priceDiff     = isLong
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

    if (positionUpdates.length) this.events.emitMtfPositions(positionUpdates);
  }

  // ─── API pubbliche ────────────────────────────────────────────────────────

  getRecentSignals(tf: string, limit = 50) {
    return (this.signals[tf] ?? []).slice(0, limit);
  }

  getStatus(tf: string): MtfStatus {
    const s = this.statusData[tf] ?? { candidates: 0, rawSignals: 0, emitted: 0 };
    return {
      tf,
      lastScanAt:   this.lastScanAt[tf],
      scannedPairs: this.validFuturesSymbols.size,
      candidates:   s.candidates,
      rawSignals:   s.rawSignals,
      emitted:      s.emitted,
      isScanning:   this.scanning[tf],
    };
  }

  getDebug(tf: string) {
    return { ...this.dbgData[tf], timestamp: new Date().toISOString() };
  }

  async getAnalytics(tf: string): Promise<MtfAnalytics> {
    const cfg    = await this.ensureConfig(tf);
    const closed = await this.prisma.mtfSimulatedTrade.findMany({
      where:   { tf, status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
      orderBy: { closedAt: 'asc' },
    });
    const opens = await this.prisma.mtfSimulatedTrade.count({
      where: { tf, status: 'open', openedAt: { gte: this.sessionStart } },
    });

    const totalNetPnl   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFeesPaid = closed.reduce((s, t) => s + (t.fees ?? 0), 0);
    const totalGrossPnl = totalNetPnl + totalFeesPaid;
    const currentCapital = cfg.startingCapital + totalNetPnl;

    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const avgWinEur  = wins.length   > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLossEur = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0) / losses.length : 0;

    const totalWins   = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    // Max drawdown + equity curve
    let peak = cfg.startingCapital;
    let maxDD = 0;
    let runCap = cfg.startingCapital;
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

    // By grade
    const byGrade: Record<string, { trades: number; wins: number; pnl: number; winRate: number }> = {};
    for (const t of closed) {
      if (!byGrade[t.grade]) byGrade[t.grade] = { trades: 0, wins: 0, pnl: 0, winRate: 0 };
      byGrade[t.grade].trades++;
      byGrade[t.grade].pnl += t.pnl ?? 0;
      if ((t.pnl ?? 0) > 0) byGrade[t.grade].wins++;
    }
    Object.keys(byGrade).forEach((g) => {
      byGrade[g].winRate = byGrade[g].trades > 0 ? (byGrade[g].wins / byGrade[g].trades) * 100 : 0;
      byGrade[g].pnl = parseFloat(byGrade[g].pnl.toFixed(4));
    });

    const sortedClosed = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    const rrActual = avgLossEur > 0 ? avgWinEur / avgLossEur : 0;

    return {
      tf,
      startingCapital: cfg.startingCapital,
      currentCapital:  parseFloat(currentCapital.toFixed(4)),
      totalPnl:        parseFloat(totalNetPnl.toFixed(4)),
      totalPnlPct:     parseFloat(((totalNetPnl / cfg.startingCapital) * 100).toFixed(2)),
      totalGrossPnl:   parseFloat(totalGrossPnl.toFixed(4)),
      totalFeesPaid:   parseFloat(totalFeesPaid.toFixed(4)),
      totalTrades:     closed.length,
      openTrades:      opens,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         parseFloat(winRate.toFixed(1)),
      avgWinEur:       parseFloat(avgWinEur.toFixed(4)),
      avgLossEur:      parseFloat(avgLossEur.toFixed(4)),
      rrActual:        parseFloat(rrActual.toFixed(2)),
      profitFactor:    parseFloat(Math.min(profitFactor, 999).toFixed(2)),
      maxDrawdownPct:  parseFloat(maxDD.toFixed(2)),
      bestTrade:       sortedClosed[0] ?? null,
      worstTrade:      sortedClosed[sortedClosed.length - 1] ?? null,
      byGrade,
      equityCurve,
      config: {
        startingCapital: cfg.startingCapital,
        marginPerTrade:  cfg.marginPerTrade,
        maxConcurrent:   cfg.maxConcurrent,
        autoEnter:       cfg.autoEnter,
      },
    };
  }

  async getOpenTrades(tf: string) {
    return this.prisma.mtfSimulatedTrade.findMany({
      where:   { tf, status: 'open', openedAt: { gte: this.sessionStart } },
      orderBy: { openedAt: 'desc' },
    });
  }

  async getClosedTrades(tf: string, limit = 100) {
    return this.prisma.mtfSimulatedTrade.findMany({
      where:   { tf, status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
      orderBy: { closedAt: 'desc' },
      take:    limit,
    });
  }

  async getSimConfig(tf: string) {
    return this.ensureConfig(tf);
  }

  async updateSimConfig(tf: string, data: Partial<{ startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean }>) {
    return this.prisma.mtfSimConfig.update({ where: { tf }, data });
  }

  async resetSim(tf: string) {
    await this.prisma.mtfSimulatedTrade.deleteMany({ where: { tf } });
    return this.prisma.mtfSimConfig.update({ where: { tf }, data: { startingCapital: 500 } });
  }

  async closeManual(id: string) {
    const trade = await this.prisma.mtfSimulatedTrade.findUnique({ where: { id } });
    if (!trade || trade.status !== 'open') return;
    const ticker = await this.exchange.fetchTicker(trade.symbol);
    await this.closeTrade(trade, ticker.last, 'manual');
  }
}
