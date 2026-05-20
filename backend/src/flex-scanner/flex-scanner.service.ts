import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ─── Interfacce ───────────────────────────────────────────────────────────────

export interface FlexSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  patternType: 3 | 4;      // 3=ERB standard (body≥35%), 4=ERB enhanced (+volume)
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  slPct: number;
  tp1Pct: number;
  tp2Pct: number;
  suggestedLeverage: number;
  volumeRatio: number;
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[];
  timestamp: string;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema34spark: number[];
}

// ─── Costanti ─────────────────────────────────────────────────────────────────
// Strategia: ERB Flex — EMA34 4-Candle Bounce, multi-pair 1m
// Differenze vs main scanner: body ≥35% (vs 40%), slope ≥0.06% (vs 0.08%)
// patternType 3 = standard, patternType 4 = enhanced (vol ≥1.5×)

const MIN_VOLUME_24H  = 3_000_000;
const TOP_CANDIDATES  = 100;
const CANDLES_1M      = 150;
const MAX_SL_PCT      = 1.80;
const SIGNAL_COOLDOWN = 300_000;    // 5 min cooldown per pair
const BODY_MIN        = 0.42;       // più stretto del main (0.40) — solo corpi solidi
const SLOPE_MIN       = 0.10;       // più stretto del main (0.08) — solo trend forti
const BOUNCE_MAX_PCT  = 0.22;       // wick entro 0.22% EMA34 — tocco preciso
const TP1_RR          = 2.0;
const TP2_RR          = 3.0;
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 0.50;
const MIN_SCORE       = 44;         // alto: solo A/A+
const MAX_PER_CYCLE   = 3;          // max 3 per ciclo per essere selettivi

@Injectable()
export class FlexScannerService implements OnModuleInit {
  private readonly logger = new Logger(FlexScannerService.name);
  private exchange: ccxt.mexc;
  private validFuturesSymbols = new Set<string>();
  private recentSignals: FlexSignal[] = [];
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
    this.logger.log(`FlexScanner (ERB): ${this.validFuturesSymbols.size} coppie futures USDT`);
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

  @Cron('20 */1 * * * *')   // ogni minuto, 20s dopo il main scanner
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

      const cycleSignals: FlexSignal[] = [];
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

        this.events.server.emit('flex:signal', sig);
        await this.enterSimTrade(sig).catch(() => {});
        emitted++;

        this.logger.log(
          `[FLEX ${sig.grade}] ${sig.direction} ${sig.symbol} pat${sig.patternType} | score ${sig.score} | SL ${sig.slPct.toFixed(2)}% TP1 ${sig.tp1Pct.toFixed(2)}%`,
        );
      }
      this.lastEmitted = emitted;
      this.lastScanAt  = new Date().toISOString();

      this.events.server.emit('flex:status', {
        lastScanAt:   this.lastScanAt,
        scannedPairs: this.scannedCount,
        candidates:   candidates.length,
        rawSignals:   this.lastRawSignals,
        emitted:      this.lastEmitted,
        isScanning:   false,
        debug:        { ...this.dbg },
      });
    } catch (err) {
      this.logger.error(`FlexScan: ${err.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ─── CHECK OPEN TRADES ────────────────────────────────────────────────────
  @Cron('*/10 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.flexSimulatedTrade.findMany({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (!open.length) return;

      const cfg = await this.getConfig();

      for (const t of open) {
        try {
          const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 3);
          if (!ohlcv.length) continue;
          const curr = ohlcv.at(-1)![4] as number;

          const isLong = t.direction === 'LONG';
          const unrealizedPnl    = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const unrealizedPnlPct = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100;

          this.events.server.emit('flex:positions', [{
            id: t.id, currentPrice: curr,
            unrealizedPnl: parseFloat(unrealizedPnl.toFixed(4)),
            unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
          }]);

          const hitSL  = isLong ? curr <= t.stopLoss   : curr >= t.stopLoss;
          const hitTP1 = isLong ? curr >= t.takeProfit1 : curr <= t.takeProfit1;
          const hitTP2 = isLong ? curr >= t.takeProfit2 : curr <= t.takeProfit2;

          if (!hitSL && !hitTP1 && !hitTP2) continue;

          const status    = hitTP2 ? 'tp2' : hitTP1 ? 'tp1' : 'sl';
          const closePrice = hitTP2 ? t.takeProfit2 : hitTP1 ? t.takeProfit1 : t.stopLoss;
          const pnlRaw     = (closePrice - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const fee        = (t.positionSize + Math.abs(pnlRaw)) * TAKER_FEE;
          const pnl        = pnlRaw - fee;
          const capitalAfter = t.capitalBefore + pnl;

          await this.prisma.flexSimulatedTrade.update({
            where: { id: t.id },
            data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(fee.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
          });

          if (cfg.autoEnter) {
            await this.prisma.flexSimConfig.update({
              where: { id: 1 },
              data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) },
            });
          }

          const updated = await this.prisma.flexSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.server.emit('flex:trade', updated);

          this.logger.log(`[FLEX CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err) {
      this.logger.error(`checkOpenTrades: ${err.message}`);
    }
  }

  // ─── ERB FLEX STRATEGY ────────────────────────────────────────────────────
  // EMA34 4-Candle Bounce — variante Flex (body ≥35%, slope ≥0.06%)
  // patternType 3 = standard, 4 = enhanced (volumeRatio ≥1.5)

  private async analyzePair(ticker: ccxt.Ticker): Promise<FlexSignal | null> {
    try {
      const sym  = ticker.symbol;
      const raw1m = await this.exchange.fetchOHLCV(sym, '1m', undefined, CANDLES_1M);
      if (raw1m.length < 30) {
        this.dbg['L0_no_data'] = (this.dbg['L0_no_data'] ?? 0) + 1; return null;
      }

      const o1 = raw1m.map((c) => c[1] as number);
      const h1 = raw1m.map((c) => c[2] as number);
      const l1 = raw1m.map((c) => c[3] as number);
      const c1 = raw1m.map((c) => c[4] as number);
      const v1 = raw1m.map((c) => c[5] as number);
      const n  = c1.length;

      // EMA34
      const ema34arr = this.indicators.emaArray(c1, 34);
      if (ema34arr.length < 10) return null;
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
      if (crossings >= 2) { this.dbg['F1_lateral'] = (this.dbg['F1_lateral'] ?? 0) + 1; return null; }

      // ─── FILTRO 2: TREND EMA34 ────────────────────────────────────────────
      const slopePct  = (ema_n2 - ema_n8) / ema_n8 * 100;
      const trendLong  = slopePct >  SLOPE_MIN;
      const trendShort = slopePct < -SLOPE_MIN;
      if (!trendLong && !trendShort) {
        this.dbg['F1_flat'] = (this.dbg['F1_flat'] ?? 0) + 1; return null;
      }
      const isLong   = trendLong;
      const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

      // ─── FILTRO EMA34 STABILITY ───────────────────────────────────────────
      {
        let emaReversals = 0, lastSign = 0;
        for (let j = n - 22; j <= n - 3; j++) {
          if (j < 1 || j >= ema34arr.length) continue;
          const slope = ema34arr[j] - ema34arr[j - 1];
          const sign  = slope > 0 ? 1 : slope < 0 ? -1 : 0;
          if (sign !== 0 && lastSign !== 0 && sign !== lastSign) emaReversals++;
          if (sign !== 0) lastSign = sign;
        }
        if (emaReversals >= 4) { this.dbg['F_ema_osc'] = (this.dbg['F_ema_osc'] ?? 0) + 1; return null; }
      }

      // ─── 4-CANDLE BOUNCE PATTERN ──────────────────────────────────────────
      const b1O = o1[n-5], b1C = c1[n-5], b1H = h1[n-5], b1L = l1[n-5];
      const b2O = o1[n-4], b2C = c1[n-4], b2H = h1[n-4], b2L = l1[n-4];
      const c1O = o1[n-3], c1C = c1[n-3], c1H = h1[n-3], c1L = l1[n-3];
      const c2O = o1[n-2], c2C = c1[n-2], c2H = h1[n-2], c2L = l1[n-2];

      const entry = c2C;

      if (isLong) {
        if (b1C >= b1O) { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (b2C >= b2O) { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (c1C <= c1O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
        if (c2C <= c2O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
      } else {
        if (b1C <= b1O) { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (b2C <= b2O) { this.dbg['F3_pat_bounce'] = (this.dbg['F3_pat_bounce'] ?? 0) + 1; return null; }
        if (c1C >= c1O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
        if (c2C >= c2O) { this.dbg['F3_pat_conf']   = (this.dbg['F3_pat_conf']   ?? 0) + 1; return null; }
      }

      // Corpi ≥35%
      const body = (o: number, c: number, h: number, l: number) => {
        const range = h - l; return range > 0 ? Math.abs(c - o) / range : 0;
      };
      const b1Body = body(b1O, b1C, b1H, b1L);
      const b2Body = body(b2O, b2C, b2H, b2L);
      const c1Body = body(c1O, c1C, c1H, c1L);
      const c2Body = body(c2O, c2C, c2H, c2L);
      if (b1Body < BODY_MIN || b2Body < BODY_MIN || c1Body < BODY_MIN || c2Body < BODY_MIN) {
        this.dbg['F3_body'] = (this.dbg['F3_body'] ?? 0) + 1; return null;
      }

      // ─── BOUNCE WICK VERSO EMA34 ──────────────────────────────────────────
      const bestBounceLow  = Math.min(b1L, b2L);
      const bestBounceHigh = Math.max(b1H, b2H);
      const bounceLowToEma  = (bestBounceLow  - ema_n4) / ema_n4 * 100;
      const bounceHighToEma = (ema_n4 - bestBounceHigh) / ema_n4 * 100;
      if (isLong  && bounceLowToEma  > BOUNCE_MAX_PCT) { this.dbg['F_bounce_touch'] = (this.dbg['F_bounce_touch'] ?? 0) + 1; return null; }
      if (!isLong && bounceHighToEma > BOUNCE_MAX_PCT) { this.dbg['F_bounce_touch'] = (this.dbg['F_bounce_touch'] ?? 0) + 1; return null; }

      // ─── SL / TP ──────────────────────────────────────────────────────────
      const dynSlLevel = isLong ? bestBounceLow : bestBounceHigh;
      const slPct      = Math.max(Math.abs(entry - dynSlLevel) / entry * 100, 0.05);
      if (slPct > MAX_SL_PCT) { this.dbg['SL_wide'] = (this.dbg['SL_wide'] ?? 0) + 1; return null; }
      const tp1Pct = slPct * TP1_RR;
      const tp2Pct = slPct * TP2_RR;

      // ─── VOLUME ───────────────────────────────────────────────────────────
      const refVols   = v1.slice(n - 22, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const volR      = refAvgVol > 0 ? v1[n - 2] / refAvgVol : 1;

      // ─── SCORING ──────────────────────────────────────────────────────────
      let score = 0;
      const reasons: string[] = [];

      const absSlope = Math.abs(slopePct);
      if      (absSlope > 0.15) { score += 20; reasons.push(`Trend forte ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.09) { score += 15; reasons.push(`Trend ${slopePct.toFixed(3)}%`); }
      else if (absSlope > 0.06) { score += 12; }
      else                      { score +=  8; }

      const bounceDepth = isLong ? -bounceLowToEma : -bounceHighToEma;
      if      (bounceDepth >  0.15) { score += 20; reasons.push(`Bounce ${bounceDepth.toFixed(2)}%`); }
      else if (bounceDepth >  0.05) { score += 15; reasons.push(`Bounce EMA34`); }
      else if (bounceDepth >= 0.0)  { score += 10; reasons.push(`Touch EMA34`); }
      else                          { score +=  5; }

      const avgBody = (b1Body + b2Body + c1Body + c2Body) / 4;
      if      (avgBody >= 0.70) { score += 15; reasons.push(`Corpi ${(avgBody * 100).toFixed(0)}%`); }
      else if (avgBody >= 0.55) { score += 11; reasons.push(`Corpi ${(avgBody * 100).toFixed(0)}%`); }
      else                      { score +=  5; }

      if      (volR >= 2.0) { score += 10; reasons.push(`Vol ×${volR.toFixed(1)}`); }
      else if (volR >= 1.5) { score +=  7; }
      else                  { score +=  3; }

      this.dbg['_max'] = Math.max(this.dbg['_max'] ?? 0, score);
      if (score < MIN_SCORE) { this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1; return null; }

      const grade: FlexSignal['grade'] = score >= 55 ? 'A+' : score >= 42 ? 'A' : score >= 32 ? 'B' : 'C';
      const patternType: 3 | 4 = volR >= 1.5 ? 4 : 3;
      const suggestedLeverage  = Math.min(Math.round(5 / slPct), 100);

      const stopLoss    = parseFloat(dynSlLevel.toPrecision(6));
      const takeProfit1 = parseFloat((entry * (isLong ? 1 + tp1Pct / 100 : 1 - tp1Pct / 100)).toPrecision(6));
      const takeProfit2 = parseFloat((entry * (isLong ? 1 + tp2Pct / 100 : 1 - tp2Pct / 100)).toPrecision(6));

      return {
        id:              `${sym}_${Date.now()}`,
        symbol:          sym,
        direction,
        patternType,
        entry,
        stopLoss,
        takeProfit1,
        takeProfit2,
        slPct:           parseFloat(slPct.toFixed(3)),
        tp1Pct:          parseFloat(tp1Pct.toFixed(3)),
        tp2Pct:          parseFloat(tp2Pct.toFixed(3)),
        suggestedLeverage,
        volumeRatio:     parseFloat(volR.toFixed(2)),
        score,
        grade,
        reasons,
        timestamp:       new Date().toISOString(),
        mexcUrl:         `https://futures.mexc.com/exchange/${sym.replace('/USDT:USDT', '_USDT')}`,
        sparkline:       raw1m.slice(-70).map((c) => ({
          t: c[0] as number, o: c[1] as number,
          h: c[2] as number, l: c[3] as number, c: c[4] as number,
        })),
        ema34spark: ema34arr.slice(-70),
      };
    } catch {
      this.dbg['L0_error'] = (this.dbg['L0_error'] ?? 0) + 1;
      return null;
    }
  }

  // ─── SIMULAZIONE ──────────────────────────────────────────────────────────

  private async enterSimTrade(sig: FlexSignal) {
    const cfg = await this.getConfig();
    if (!cfg.autoEnter) return;

    const openCount = await this.prisma.flexSimulatedTrade.count({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
    });
    if (openCount >= cfg.maxConcurrent) return;

    const positionSize    = entry => RISK_EUR * 100 / (sig.slPct);
    const marginEur       = positionSize(sig.entry) / sig.suggestedLeverage;

    const capitalBefore = cfg.startingCapital;
    const feeOpen       = positionSize(sig.entry) * TAKER_FEE;
    const riskEur       = RISK_EUR;
    const pSize         = RISK_EUR * 100 / sig.slPct;

    const id = `${sig.id}_flex`;
    const existing = await this.prisma.flexSimulatedTrade.findUnique({ where: { id } });
    if (existing) return;

    const trade = await this.prisma.flexSimulatedTrade.create({
      data: {
        id,
        symbol:       sig.symbol,
        direction:    sig.direction,
        entry:        sig.entry,
        stopLoss:     sig.stopLoss,
        takeProfit1:  sig.takeProfit1,
        takeProfit2:  sig.takeProfit2,
        leverage:     sig.suggestedLeverage,
        riskEur:      parseFloat(riskEur.toFixed(4)),
        positionSize: parseFloat(pSize.toFixed(4)),
        marginEur:    parseFloat((pSize / sig.suggestedLeverage).toFixed(4)),
        grade:        sig.grade,
        score:        sig.score,
        fees:         parseFloat(feeOpen.toFixed(4)),
        capitalBefore: parseFloat(capitalBefore.toFixed(4)),
        status:       'open',
      },
    });
    this.events.server.emit('flex:trade', trade);
  }

  private async initConfig() {
    await this.prisma.flexSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, marginPerTrade: 10, maxConcurrent: 3, autoEnter: true },
      update: {},
    });
  }

  private async getConfig() {
    return this.prisma.flexSimConfig.findFirstOrThrow({ where: { id: 1 } });
  }

  private async getOpenSymbolsSet(): Promise<Set<string>> {
    const open = await this.prisma.flexSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
      select: { symbol: true },
    });
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
    const all    = await this.prisma.flexSimulatedTrade.findMany({
      where:   { openedAt: { gte: this.sessionStart } },
      orderBy: { openedAt: 'desc' },
    });
    const closed = all.filter((t) => t.status !== 'open');
    const open   = all.filter((t) => t.status === 'open');

    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0).length;
    const totalPnl   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalPnlPct = cfg.startingCapital > 0 ? totalPnl / cfg.startingCapital * 100 : 0;
    const winRate     = closed.length > 0 ? wins / closed.length * 100 : 0;
    const avgWin      = wins > 0 ? closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / wins : 0;
    const avgLoss     = losses > 0 ? Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0)) / losses : 0;
    const grossWin    = closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0);
    const grossLoss   = Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0));

    let peak = cfg.startingCapital, dd = 0, maxDd = 0;
    for (const t of [...closed].reverse()) {
      const cap = t.capitalAfter ?? cfg.startingCapital;
      if (cap > peak) peak = cap;
      dd = (peak - cap) / peak * 100;
      if (dd > maxDd) maxDd = dd;
    }

    return {
      totalTrades:     all.length,
      openTrades:      open.length,
      wins, losses,
      winRate:         parseFloat(winRate.toFixed(1)),
      totalPnl:        parseFloat(totalPnl.toFixed(3)),
      totalPnlPct:     parseFloat(totalPnlPct.toFixed(2)),
      currentCapital:  cfg.startingCapital,
      avgWinEur:       parseFloat(avgWin.toFixed(3)),
      avgLossEur:      parseFloat(avgLoss.toFixed(3)),
      rrActual:        avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : 0,
      profitFactor:    grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
      maxDrawdownPct:  parseFloat(maxDd.toFixed(1)),
      config:          { startingCapital: cfg.startingCapital, marginPerTrade: cfg.marginPerTrade, maxConcurrent: cfg.maxConcurrent, autoEnter: cfg.autoEnter },
    };
  }

  async getOpenTrades() {
    return this.prisma.flexSimulatedTrade.findMany({
      where:   { status: 'open', openedAt: { gte: this.sessionStart } },
      orderBy: { openedAt: 'desc' },
    });
  }

  async getClosedTrades(limit = 100) {
    return this.prisma.flexSimulatedTrade.findMany({
      where:   { status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
      orderBy: { closedAt: 'desc' },
      take:    limit,
    });
  }

  async updateConfig(cfg: Partial<{ startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean }>) {
    await this.prisma.flexSimConfig.update({ where: { id: 1 }, data: cfg });
    return { ok: true };
  }

  async resetSim() {
    await this.prisma.flexSimulatedTrade.deleteMany();
    await this.prisma.flexSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    return { ok: true };
  }

  async closeManual(id: string) {
    const t = await this.prisma.flexSimulatedTrade.findUnique({ where: { id } });
    if (!t || t.status !== 'open') return { ok: false };
    const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 2).catch(() => []);
    const curr  = ohlcv.length ? (ohlcv.at(-1)![4] as number) : t.entry;
    const isLong = t.direction === 'LONG';
    const pnlRaw = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
    const fee    = (t.positionSize + Math.abs(pnlRaw)) * TAKER_FEE;
    const pnl    = pnlRaw - fee;
    const cfg    = await this.getConfig();
    const capitalAfter = cfg.startingCapital + pnl;
    await this.prisma.flexSimulatedTrade.update({
      where: { id },
      data: { status: 'manual', closePrice: curr, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(fee.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
    });
    return { ok: true };
  }
}
