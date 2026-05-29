import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { LiveTradingService } from '../live/live-trading.service';
import { PrismaService } from '../prisma/prisma.service';

const SOURCE        = 'ENGULFING';
const TIMEFRAME     = '5m';
const CANDLES       = 10;   // need prior trend candles + engulfing + confirm
const SCAN_BATCH    = 10;
const BATCH_DELAY   = 50;
const FETCH_RETRIES = 2;

type Grade = 'A+' | 'A' | 'B';

export interface EngulfingSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  slPct: number;
  tpPct: number;
  suggestedLeverage: number;
  riskUsdt: number;
  positionSize: number;
  marginUsdt: number;
  engulfRatio: number;
  volumeRatio: number;
  feeRate: number;
  score: number;
  grade: Grade;
  reasons: string[];
  timestamp: string;
}

@Injectable()
export class EngulfingService implements OnModuleInit {
  private readonly logger = new Logger(EngulfingService.name);
  private exchange: ccxt.mexc;
  private markets: Record<string, any> = {};
  private feeBySymbol = new Map<string, number>();
  private lastSignals: EngulfingSignal[] = [];
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private scannedPairs = 0;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private isScanning = false;
  private debug: Record<string, number> = {};

  constructor(
    private config: ConfigService,
    private events: EventsGateway,
    private liveTrading: LiveTradingService,
    private prisma: PrismaService,
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
    await this.loadMarkets();
    await this.loadContractFees();
    await this.ensureConfig();
    this.logger.log('[ENGULFING] attivo — Bullish/Bearish Engulfing su 100 USDT futures');
  }

  @Cron('30 0 * * * *')
  async loadContractFees() {
    try {
      const res  = await fetch('https://contract.mexc.com/api/v1/contract/detail');
      const json = await res.json();
      if (!json?.success || !Array.isArray(json.data)) throw new Error('contract/detail invalid');
      const fees = new Map<string, number>();
      for (const row of json.data) {
        const sym = String(row.symbol ?? '');
        if (!sym.endsWith('_USDT')) continue;
        const symbol = sym.replace('_USDT', '/USDT:USDT');
        fees.set(symbol, Math.max(Number(row.takerFeeRate ?? 0), 0.0006));
      }
      this.feeBySymbol = fees;
    } catch (err: any) {
      this.logger.warn(`[ENGULFING] fee table err: ${err?.message}`);
    }
  }

  private async loadMarkets() {
    try {
      this.markets = await this.exchange.loadMarkets();
    } catch (e: any) {
      this.logger.warn(`[ENGULFING] loadMarkets: ${e?.message}`);
    }
  }

  private feeRate(symbol: string): number {
    return this.feeBySymbol.has(symbol) ? Number(this.feeBySymbol.get(symbol)) : 0.0006;
  }

  private bump(key: string) { this.debug[key] = (this.debug[key] ?? 0) + 1; }

  // ── Main scan ──────────────────────────────────────────────────────────────
  @Cron('30 4,9,14,19,24,29,34,39,44,49,54,59 * * * *')
  async scan() {
    const cfg = await this.ensureConfig();
    if (!cfg.enabled) return;

    this.debug = {};
    this.isScanning = true;
    const symbols = this.topSymbols(cfg.topPairs);
    this.scannedPairs = 0;
    const signals: EngulfingSignal[] = [];

    for (let i = 0; i < symbols.length; i += SCAN_BATCH) {
      const batch = symbols.slice(i, i + SCAN_BATCH);
      const results = await Promise.allSettled(batch.map(sym => this.scanOne(sym, cfg)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) signals.push(r.value);
      }
      this.scannedPairs += batch.length;
      if (i + SCAN_BATCH < symbols.length) await this.delay(BATCH_DELAY);
    }

    signals.sort((a, b) => b.score - a.score || a.feeRate - b.feeRate);
    const top = signals.slice(0, cfg.maxSignalsPerScan);
    this.lastSignals    = top;
    this.lastScanAt     = new Date().toISOString();
    this.lastError      = null;
    this.lastRawSignals = signals.length;
    this.lastEmitted    = top.length;
    this.isScanning     = false;

    let slots = cfg.maxConcurrent - await this.openSimCount();

    for (const sig of top) {
      this.events.emitEngulfingSignal(sig);

      if (slots > 0 && cfg.autoEnter) {
        await this.enterSimTrade(sig, cfg);
        slots--;
      }

      if (cfg.liveEnabled) {
        const doEnter = () => this.liveTrading.enterTrade({
          symbol:             sig.symbol,
          direction:          sig.direction,
          grade:              sig.grade,
          entry:              sig.entry,
          slPct:              sig.slPct,
          tp1Pct:             sig.tpPct,
          suggestedLeverage:  sig.suggestedLeverage,
          score:              sig.score,
          stopLossPrice:      sig.stopLoss,
          takeProfitPrice:    sig.takeProfit,
          riskUsdt:           sig.riskUsdt,
          feeRate:            sig.feeRate,
          source:             SOURCE,
          sourceMaxConcurrent: cfg.maxConcurrent,
          bypassGlobalConfig: true,
        }).catch(err => this.logger.error(`[ENGULFING LIVE] ${sig.symbol}: ${err?.message}`));

        // entra solo se siamo ancora entro 60s dalla prossima chiusura candela
        const nextCandleClose = Math.ceil((Date.now() + 1) / (5 * 60_000)) * 5 * 60_000;
        const secsToClose = (nextCandleClose - Date.now()) / 1000;
        if (secsToClose > 60) {
          this.logger.warn(`[ENGULFING LIVE] ${sig.symbol} skip — segnale stale (${Math.round(secsToClose)}s alla prossima chiusura)`);
        } else {
          this.logger.log(`[ENGULFING LIVE] ${sig.symbol} → entro subito (${Math.round(secsToClose)}s alla chiusura candela)`);
          doEnter();
        }
      }
    }

    this.events.emitEngulfingStatus(this.statusPayload());
    this.logger.log(`[ENGULFING] scanned=${this.scannedPairs} signals=${top.length} dbg=${JSON.stringify(this.debug)}`);
  }

  // ── Scan single symbol ─────────────────────────────────────────────────────
  // Pattern: [trend2][trend1][engulfed][ENGULFING][CONFIRM] ← entry a chiusura confirm
  private async scanOne(symbol: string, cfg: any): Promise<EngulfingSignal | null> {
    const candles = await this.fetchOHLCV(symbol);
    if (!candles || candles.length < 7) { this.bump('no_candles'); return null; }

    const ticker = await this.fetchTicker(symbol);
    if (!ticker) { this.bump('no_ticker'); return null; }

    // Cooldown
    if (cfg.cooldownMinutes > 0) {
      const since = new Date(Date.now() - cfg.cooldownMinutes * 60_000);
      const recent = await this.prisma.engulfingSimulatedTrade.findFirst({
        where: { symbol, openedAt: { gte: since } },
      });
      if (recent) { this.bump('cooldown'); return null; }
    }

    // Spread / volume 24h
    const spread = this.spreadPct(ticker);
    if (spread > cfg.maxSpreadPct) { this.bump('spread'); return null; }
    const vol24h = Number(ticker.quoteVolume ?? ticker.info?.volume24 ?? 0);
    if (vol24h < cfg.minVolume24h) { this.bump('vol24h'); return null; }

    // Candle references (tutte chiuse tranne last che è in formazione)
    const last    = candles.length - 1;
    const confirm  = candles[last - 1];   // candela di conferma (ultima chiusa)
    const engulf   = candles[last - 2];   // candela engulfing
    const engulfed = candles[last - 3];   // candela inglobata
    const trend1   = candles[last - 4];   // trend precedente 1
    const trend2   = candles[last - 5];   // trend precedente 2
    if (!confirm || !engulf || !engulfed || !trend1 || !trend2) { this.bump('no_candles'); return null; }

    const [, eO, eH, eL, eC] = engulf;
    const [, edO, edH, edL, edC] = engulfed;
    const [, cO, cH, cL, cC] = confirm;
    const [, t1O,,,t1C] = trend1;
    const [, t2O,,,t2C] = trend2;

    // ── Direzione engulfing ──────────────────────────────────────────────────
    const isBullish = eC > eO && edC < edO;
    const isBearish = eC < eO && edC > edO;
    if (!isBullish && !isBearish) { this.bump('no_pattern'); return null; }
    const direction: 'LONG' | 'SHORT' = isBullish ? 'LONG' : 'SHORT';

    // ── Engulf geometrico: l'engulfing deve contenere la engulfed ───────────
    if (eH < edH || eL > edL) { this.bump('no_engulf'); return null; }

    // ── Engulf ratio: corpo engulfing / range engulfed — cap 1.0–1.75 ───────
    const engulfBody  = Math.abs(eC - eO);
    const engulfedRange = edH - edL;
    if (engulfedRange <= 0) { this.bump('prev_flat'); return null; }
    const engulfRatio = engulfBody / engulfedRange;
    if (engulfRatio < cfg.minEngulfRatio) { this.bump('engulf_weak'); return null; }
    if (engulfRatio > 1.75) { this.bump('engulf_monster'); return null; }

    // ── Body ratio candela engulfing (no doji) ───────────────────────────────
    const engulfRange = eH - eL;
    const bodyRatio   = engulfRange > 0 ? engulfBody / engulfRange : 0;
    if (bodyRatio < cfg.minBodyRatio) { this.bump('body_weak'); return null; }

    // ── Trend precedente: almeno 2 candele nella direzione opposta ───────────
    const trendOk = isBullish
      ? (t1C < t1O && t2C < t2O)   // 2 rosse prima del bullish engulfing
      : (t1C > t1O && t2C > t2O);  // 2 verdi prima del bearish engulfing
    if (!trendOk) { this.bump('no_prior_trend'); return null; }

    // ── Candele precedenti più piccole del corpo dell'engulfing ─────────────
    const t1Body = Math.abs(t1C - t1O);
    const t2Body = Math.abs(t2C - t2O);
    if (t1Body >= engulfBody || t2Body >= engulfBody) { this.bump('engulf_not_dominant'); return null; }

    // ── Candela di conferma: stessa direzione, corpo visibile ────────────────
    const confirmBullish = cC > cO;
    const confirmBearish = cC < cO;
    if (isBullish && !confirmBullish) { this.bump('no_confirm'); return null; }
    if (isBearish && !confirmBearish) { this.bump('no_confirm'); return null; }

    const confirmRange = cH - cL;
    const confirmBodyRatio = confirmRange > 0 ? Math.abs(cC - cO) / confirmRange : 0;
    if (confirmBodyRatio < 0.35) { this.bump('confirm_weak'); return null; }

    // Confirm non deve violare il range dell'engulfing (non sfonda SL)
    if (isBullish && cL < eL) { this.bump('confirm_breaks_sl'); return null; }
    if (isBearish && cH > eH) { this.bump('confirm_breaks_sl'); return null; }

    // ── Volume (sull'engulfing, la candela forte) ────────────────────────────
    const avgVol  = candles.slice(Math.max(0, last - 22), last - 2).reduce((s: number, c: number[]) => s + c[5], 0) / 20;
    const volRatio = avgVol > 0 ? engulf[5] / avgVol : 1;
    if (volRatio < cfg.minVolumeRatio) { this.bump('vol_weak'); return null; }

    // ── SL sul low/high dell'engulfing (non della confirm) ───────────────────
    const entry   = cC;                              // entry = chiusura candela confirm
    const slPrice = isBullish ? eL : eH;             // SL = estremo candela engulfing
    const slPct   = Math.abs(entry - slPrice) / entry * 100;
    if (slPct < cfg.minSlPct) { this.bump('sl_small'); return null; }
    if (slPct > cfg.maxSlPct) { this.bump('sl_big');   return null; }

    const fee          = this.feeRate(symbol);
    const positionSize = cfg.riskUsdt / (slPct / 100);
    const tpPct        = slPct * cfg.tpRr;
    const tpPrice      = isBullish ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    const maxLev       = Number(this.markets[symbol]?.limits?.leverage?.max ?? 125) || 125;
    const leverage     = Math.max(1, Math.min(Math.ceil(positionSize / 10), maxLev, 125));
    const margin       = positionSize / leverage;

    // Score
    const score = this.calcScore({ engulfRatio, bodyRatio, volRatio, slPct });
    if (score < cfg.minScore) { this.bump('score'); return null; }
    const grade: Grade = score >= 88 ? 'A+' : score >= 72 ? 'A' : 'B';

    this.bump('ok');
    return {
      id:                `${SOURCE}_${symbol}_${confirm[0]}`,
      symbol,
      direction,
      entry:             this.px(entry, symbol),
      stopLoss:          this.px(slPrice, symbol),
      takeProfit:        this.px(tpPrice, symbol),
      slPct:             Number(slPct.toFixed(4)),
      tpPct:             Number(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt:          Number(cfg.riskUsdt.toFixed(2)),
      positionSize:      Number(positionSize.toFixed(4)),
      marginUsdt:        Number(margin.toFixed(4)),
      engulfRatio:       Number(engulfRatio.toFixed(3)),
      volumeRatio:       Number(volRatio.toFixed(2)),
      feeRate:           fee,
      score,
      grade,
      reasons: [
        `engulf x${engulfRatio.toFixed(2)} + confirm ${isBullish ? '🟢' : '🔴'}`,
        `prior trend: 2 candele ${isBullish ? 'bearish' : 'bullish'}`,
        `vol x${volRatio.toFixed(1)} · body ${(bodyRatio*100).toFixed(0)}%`,
        `SL su engulfing ${slPct.toFixed(2)}%`,
      ],
      timestamp: new Date(confirm[0]).toISOString(),
    };
  }

  // ── Score ──────────────────────────────────────────────────────────────────
  private calcScore(p: { engulfRatio: number; bodyRatio: number; volRatio: number; slPct: number }): number {
    // engulfRatio: higher = stronger engulf (max useful ~3)
    const engulfS = Math.min(p.engulfRatio / 3, 1) * 35;
    // bodyRatio: 0.5–1.0 range
    const bodyS   = Math.min(Math.max((p.bodyRatio - 0.5) / 0.5, 0), 1) * 25;
    // volumeRatio: 1.2–3.0 range
    const volS    = Math.min(Math.max((p.volRatio - 1.2) / 1.8, 0), 1) * 25;
    // slPct: 0.3–1.0% is ideal
    const slNorm  = p.slPct >= 0.3 && p.slPct <= 1.0 ? 1 : Math.max(0, 1 - Math.abs(p.slPct - 0.65) / 0.65);
    const slS     = slNorm * 15;
    return Math.round(engulfS + bodyS + volS + slS);
  }

  // ── Simulation ─────────────────────────────────────────────────────────────
  private async enterSimTrade(sig: EngulfingSignal, cfg: any) {
    const already = await this.prisma.engulfingSimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open' },
    });
    if (already) return;

    const capital = await this.currentCapital(cfg);
    await this.prisma.engulfingSimulatedTrade.create({
      data: {
        id:            sig.id,
        symbol:        sig.symbol,
        direction:     sig.direction,
        entry:         sig.entry,
        stopLoss:      sig.stopLoss,
        takeProfit:    sig.takeProfit,
        slPct:         sig.slPct,
        tpPct:         sig.tpPct,
        leverage:      sig.suggestedLeverage,
        riskEur:       sig.riskUsdt,
        positionSize:  sig.positionSize,
        marginEur:     sig.marginUsdt,
        score:         sig.score,
        grade:         sig.grade,
        engulfRatio:   sig.engulfRatio,
        volumeRatio:   sig.volumeRatio,
        feeRate:       sig.feeRate,
        fees:          sig.positionSize * sig.feeRate,
        capitalBefore: capital,
        status:        'open',
      },
    });
  }

  @Cron('*/5 * * * * *')
  async checkSimTrades() {
    const open = await this.prisma.engulfingSimulatedTrade.findMany({ where: { status: 'open' } });
    if (!open.length) return;

    const symbols = [...new Set(open.map(t => t.symbol))];
    let tickers: Record<string, any> = {};
    try { tickers = await this.exchange.fetchTickers(symbols) as any; } catch { return; }

    const positions: any[] = [];

    for (const trade of open) {
      const ticker = tickers[trade.symbol];
      if (!ticker) continue;
      const last = Number(ticker.last ?? ticker.close ?? 0);
      if (!last) continue;

      const isLong = trade.direction === 'LONG';
      const bid = Number(ticker.bid ?? last);
      const ask = Number(ticker.ask ?? last);
      const slCheck = isLong ? bid : ask;
      const tpCheck = isLong ? ask : bid;

      if (isLong  && tpCheck >= trade.takeProfit) { await this.closeSimTrade(trade, trade.takeProfit, 'tp'); continue; }
      if (!isLong && tpCheck <= trade.takeProfit) { await this.closeSimTrade(trade, trade.takeProfit, 'tp'); continue; }
      if (isLong  && slCheck <= trade.stopLoss)   { await this.closeSimTrade(trade, trade.stopLoss,   'sl'); continue; }
      if (!isLong && slCheck >= trade.stopLoss)   { await this.closeSimTrade(trade, trade.stopLoss,   'sl'); continue; }

      // Emetti posizione live con PnL non realizzato
      const priceDiff = isLong ? (last - trade.entry) / trade.entry : (trade.entry - last) / trade.entry;
      const unrealizedPnl = trade.positionSize * priceDiff - (trade.fees ?? 0);
      const slPct = Number(trade.slPct ?? 0);
      positions.push({
        id:                trade.id,
        currentPrice:      last,
        unrealizedPnl:     parseFloat(unrealizedPnl.toFixed(4)),
        unrealizedPnlPct:  parseFloat((priceDiff * 100).toFixed(2)),
        currentR:          slPct > 0 ? parseFloat((priceDiff * 100 / slPct).toFixed(2)) : 0,
      });
    }

    if (positions.length) this.events.emitEngulfingPositions(positions);
  }

  private async closeSimTrade(trade: any, closePrice: number, status: string) {
    const isLong    = trade.direction === 'LONG';
    const priceDiff = isLong ? (closePrice - trade.entry) / trade.entry : (trade.entry - closePrice) / trade.entry;
    const fee       = Number(trade.feeRate ?? 0.0006);
    const exitFee   = trade.positionSize * fee;
    const totalFees = (trade.fees ?? 0) + exitFee;
    const pnl       = trade.positionSize * priceDiff - totalFees;
    const capital   = await this.currentCapital(await this.ensureConfig());

    const updated = await this.prisma.engulfingSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status, closePrice, pnl: parseFloat(pnl.toFixed(4)),
        fees: parseFloat(totalFees.toFixed(6)),
        closedAt: new Date(),
        capitalAfter: parseFloat((capital + pnl).toFixed(4)),
      },
    });
    this.events.emitEngulfingTrade(updated);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private topSymbols(n: number): string[] {
    return Object.keys(this.markets)
      .filter(s => s.endsWith('/USDT:USDT') && this.markets[s]?.active)
      .slice(0, n);
  }

  private async fetchOHLCV(symbol: string): Promise<number[][] | null> {
    for (let i = 0; i < FETCH_RETRIES; i++) {
      try {
        return await this.exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, CANDLES) as number[][];
      } catch (e: any) {
        if (i === FETCH_RETRIES - 1) { this.bump('fetch_err'); return null; }
        await this.delay(300 * (i + 1));
      }
    }
    return null;
  }

  private async fetchTicker(symbol: string): Promise<any> {
    try { return await this.exchange.fetchTicker(symbol); } catch { return null; }
  }

  private spreadPct(ticker: any): number {
    const bid = Number(ticker.bid ?? 0), ask = Number(ticker.ask ?? 0);
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : Number(ticker.last ?? 1);
    return bid > 0 && ask > 0 && mid > 0 ? (ask - bid) / mid * 100 : 0;
  }

  private px(price: number, symbol: string): number {
    try { return parseFloat(this.exchange.priceToPrecision(symbol, price)); } catch { return price; }
  }

  private delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  private async openSimCount(): Promise<number> {
    return this.prisma.engulfingSimulatedTrade.count({ where: { status: 'open' } });
  }

  private async currentCapital(cfg: any): Promise<number> {
    const last = await this.prisma.engulfingSimulatedTrade.findFirst({
      where: { capitalAfter: { not: null } }, orderBy: { openedAt: 'desc' },
    });
    return last?.capitalAfter ?? cfg.startingCapital;
  }

  private async ensureConfig() {
    const c = await this.prisma.engulfingConfig.findUnique({ where: { id: 1 } });
    if (c) return c;
    return this.prisma.engulfingConfig.create({ data: { id: 1 } });
  }

  private statusPayload() {
    return {
      isScanning:     this.isScanning,
      scannedPairs:   this.scannedPairs,
      lastScanAt:     this.lastScanAt,
      lastError:      this.lastError,
      lastRawSignals: this.lastRawSignals,
      lastEmitted:    this.lastEmitted,
      debug:          this.debug,
    };
  }

  // ── Analytics ──────────────────────────────────────────────────────────────
  async getAnalytics() {
    const cfg    = await this.ensureConfig();
    const trades = await this.prisma.engulfingSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const open   = trades.filter(t => t.status === 'open');
    const wins   = closed.filter(t => (t.pnl ?? 0) > 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);

    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    return {
      config:          cfg,
      totalPnl:        parseFloat(totalPnl.toFixed(2)),
      winRate:         closed.length ? parseFloat((wins.length / closed.length * 100).toFixed(1)) : 0,
      closedTrades:    closed.length,
      openTrades:      open.length,
      totalTrades:     closed.length,
      avgWin:          wins.length ? parseFloat((wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length).toFixed(2)) : 0,
      avgLoss:         losses.length ? parseFloat((losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length).toFixed(2)) : 0,
      recentSignals:   this.lastSignals,
      scannerStatus:   this.statusPayload(),
      openTradesList:  open,
      closedTradesList: closed.slice(0, 50),
    };
  }

  async updateConfig(data: any) {
    const allowed = [
      'startingCapital', 'riskUsdt', 'tpRr', 'leverage', 'maxConcurrent',
      'maxSignalsPerScan', 'enabled', 'autoEnter', 'liveEnabled', 'minScore',
      'topPairs', 'minEngulfRatio', 'minBodyRatio', 'minVolumeRatio',
      'minSlPct', 'maxSlPct', 'maxSpreadPct', 'minVolume24h', 'cooldownMinutes',
    ];
    const patch: any = {};
    for (const key of allowed) { if (data[key] !== undefined) patch[key] = data[key]; }
    return this.prisma.engulfingConfig.update({ where: { id: 1 }, data: patch });
  }

  getSignals(limit = 100) { return this.lastSignals.slice(0, limit); }

  getStatus() { return this.statusPayload(); }

  async getTrades(limit = 200) {
    return this.prisma.engulfingSimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' }, take: limit,
    });
  }

  async getCandles(symbol: string, limit = 120) {
    try {
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, limit + 1) as number[][];
      return ohlcv.slice(0, -1).map(c => ({
        time: Math.floor(c[0] / 1000),
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));
    } catch { return []; }
  }

  async resetSim() {
    await this.prisma.engulfingSimulatedTrade.deleteMany({});
    await this.prisma.engulfingConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
  }
}
