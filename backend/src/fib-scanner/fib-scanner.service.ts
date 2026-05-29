import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

const SOURCE = 'FIB';
const TF     = '1m';
const FEE    = 0.0006;

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT',
  'DOGE/USDT:USDT', 'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT',
  'LINK/USDT:USDT', 'SUI/USDT:USDT',
];

// Livelli Fibonacci per retracement
const FIB_RATIOS = [0.236, 0.382, 0.500, 0.618, 0.786];
const FIB_NAMES  = ['23.6%', '38.2%', '50%', '61.8%', '78.6%'];

type Grade = 'A+' | 'A' | 'B';

interface Swing {
  direction: 'LONG' | 'SHORT';
  swingHigh:  number;
  swingLow:   number;
  range:      number;     // swingHigh - swingLow
  swingPct:   number;     // range / price * 100
  highIdx:    number;
  lowIdx:     number;
}

interface FibLevel {
  ratio:   number;
  name:    string;
  price:   number;
}

export interface FibSignal {
  id:                string;
  symbol:            string;
  direction:         'LONG' | 'SHORT';
  entry:             number;
  stopLoss:          number;
  takeProfit:        number;
  slPct:             number;
  tpPct:             number;
  suggestedLeverage: number;
  riskUsdt:          number;
  positionSize:      number;
  marginUsdt:        number;
  score:             number;
  grade:             Grade;
  // Fib data
  swingHigh:         number;
  swingLow:          number;
  swingRange:        number;
  fibLevel:          number;   // es. 0.618
  fibLevelName:      string;   // es. "61.8%"
  fibPrice:          number;   // prezzo esatto del livello
  // Flow
  vwap:              number;
  volumeRatio:       number;
  delta:             number;
  deltaRatio:        number;
  feeRate:           number;
  reasons:           string[];
  timestamp:         string;
}

@Injectable()
export class FibScannerService implements OnModuleInit {
  private readonly logger = new Logger(FibScannerService.name);
  private exchange: ccxt.mexc;
  private markets: Record<string, any> = {};

  private lastSignals: FibSignal[] = [];
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private isScanning = false;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private debug: Record<string, number> = {};

  constructor(
    private config: ConfigService,
    private events: EventsGateway,
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
    try {
      this.markets = await this.exchange.loadMarkets();
    } catch (e: any) {
      this.logger.warn(`[FIB] loadMarkets: ${e?.message}`);
    }
    await this.ensureConfig();
    this.logger.log(`[FIB] Fibonacci Retracement Scanner attivo — 1m · ${SYMBOLS.length} coppie`);
  }

  @Cron('2 * * * * *')
  async scan() {
    const cfg = await this.ensureConfig();
    if (!cfg.enabled) return;

    this.debug = {};
    this.isScanning = true;
    const signals: FibSignal[] = [];

    for (let i = 0; i < SYMBOLS.length; i += 3) {
      const batch = SYMBOLS.slice(i, i + 3);
      await Promise.allSettled(batch.map(async sym => {
        try {
          const sig = await this.scanOne(sym, cfg);
          if (sig) signals.push(sig);
        } catch (e: any) {
          this.bump('fetch_err');
        }
      }));
      if (i + 3 < SYMBOLS.length) await new Promise(r => setTimeout(r, 150));
    }

    signals.sort((a, b) => b.score - a.score);
    this.lastSignals    = signals;
    this.lastScanAt     = new Date().toISOString();
    this.lastError      = null;
    this.lastRawSignals = signals.length;
    this.lastEmitted    = signals.length;
    this.isScanning     = false;

    let slots = cfg.maxConcurrent - await this.openSimCount();

    for (const sig of signals) {
      this.events.emitFibSignal(sig);

      if (slots > 0 && cfg.autoEnter) {
        await this.enterSimTrade(sig, cfg);
        slots--;
      }
    }

    this.events.emitFibStatus(this.statusPayload());

    if (signals.length > 0 || Object.keys(this.debug).length > 0) {
      this.logger.log(`[FIB] signals=${signals.length} dbg=${JSON.stringify(this.debug)}`);
    }
  }

  // ── Core: analisi Fibonacci Retracement ──────────────────────────────────────
  private async scanOne(symbol: string, cfg: any): Promise<FibSignal | null> {
    // Fetch 80 candele: 60 per swing detection + 20 per VWAP
    const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, 80) as number[][];
    if (!ohlcv || ohlcv.length < 20) { this.bump('no_candle'); return null; }

    const last = ohlcv.length - 1;
    // Ultima candela chiusa (penultima della serie)
    const candle = ohlcv[last - 1];
    const [ts, open, high, low, close, vol] = candle;
    if (!close || !vol) { this.bump('no_close'); return null; }

    // VWAP sulle ultime 20 candele chiuse
    const vwapCandles = ohlcv.slice(last - 20, last);
    const vwap = this.calcVwap(vwapCandles);

    // Swing detection nelle ultime 60 candele chiuse
    const swingCandles = ohlcv.slice(last - 60, last);
    const swing = this.findSwing(swingCandles, cfg.swingPivotN ?? 3, cfg.minSwingPct ?? 0.25);
    if (!swing) { this.bump('no_swing'); return null; }

    const { direction, swingHigh, swingLow, range, swingPct } = swing;

    // Calcolo livelli Fibonacci per retracement
    const fibLevels: FibLevel[] = FIB_RATIOS.map((r, i) => ({
      ratio: r,
      name:  FIB_NAMES[i],
      price: direction === 'LONG'
        ? swingHigh - range * r   // ritracciamento dall'alto per LONG
        : swingLow  + range * r,  // ritracciamento dal basso per SHORT
    }));

    // Solo livelli validi per l'ingresso: 38.2%, 50%, 61.8% (escludiamo 23.6% troppo shallow, 78.6% troppo rischioso)
    const validLevels = fibLevels.filter(l => l.ratio >= 0.382 && l.ratio <= 0.618);

    // Trova il livello più vicino al close corrente
    let nearestLevel: FibLevel & { dist: number } | null = null;
    for (const lv of validLevels) {
      const dist = Math.abs(close - lv.price) / close * 100;
      if (!nearestLevel || dist < nearestLevel.dist) {
        nearestLevel = { ...lv, dist };
      }
    }
    if (!nearestLevel) { this.bump('no_level'); return null; }

    const proxPct = cfg.proxPct ?? 0.15;
    if (nearestLevel.dist > proxPct) { this.bump('not_near_fib'); return null; }

    // Conferma candela: deve essere nella direzione del trade
    // Per LONG: bullish reversal (close > open, preferibilmente con body significativo)
    // Per SHORT: bearish reversal (close < open)
    const isBullish = close > open;
    const isBearish = close < open;
    if (direction === 'LONG'  && !isBullish) { this.bump('no_reversal'); return null; }
    if (direction === 'SHORT' && !isBearish) { this.bump('no_reversal'); return null; }

    // Filtro VWAP: LONG solo sopra VWAP, SHORT solo sotto
    if (direction === 'LONG'  && close < vwap) { this.bump('vwap_filter'); return null; }
    if (direction === 'SHORT' && close > vwap) { this.bump('vwap_filter'); return null; }

    // Volume
    const avgVolCandles = ohlcv.slice(last - 15, last - 1);
    const avgVol = avgVolCandles.reduce((s, c) => s + c[5], 0) / avgVolCandles.length || 1;
    const volRatio = vol / avgVol;
    if (volRatio < (cfg.minVolumeRatio ?? 1.10)) { this.bump('vol_weak'); return null; }

    // Delta
    let buyVol = 0, sellVol = 0;
    try {
      const trades = await this.exchange.fetchTrades(symbol, ts, 500);
      for (const t of trades) {
        if (t.timestamp && t.timestamp >= ts && t.timestamp < ts + 60_000) {
          if (t.side === 'buy')  buyVol  += (t.amount ?? 0);
          else                   sellVol += (t.amount ?? 0);
        }
      }
      if (buyVol + sellVol === 0 && trades.length > 0) {
        const mid = (high + low) / 2;
        for (const t of trades) {
          const p = t.price ?? 0;
          if (!p) continue;
          if (p >= mid) buyVol  += (t.amount ?? 0);
          else          sellVol += (t.amount ?? 0);
        }
      }
    } catch {
      const bodyRatio = high > low ? Math.abs(close - open) / (high - low) : 0;
      if (close >= open) { buyVol = vol * bodyRatio; sellVol = vol * (1 - bodyRatio); }
      else               { sellVol = vol * bodyRatio; buyVol = vol * (1 - bodyRatio); }
    }

    const totalVol   = buyVol + sellVol || 1;
    const delta      = buyVol - sellVol;
    const deltaRatio = delta / totalVol;

    const minDelta = cfg.minDeltaRatio ?? 0.15;
    if (direction === 'LONG'  && deltaRatio < minDelta)  { this.bump('delta_weak'); return null; }
    if (direction === 'SHORT' && deltaRatio > -minDelta) { this.bump('delta_weak'); return null; }

    const entry = close;

    // SL = prossimo livello Fib più profondo (oltre il livello di entrata)
    // Per LONG: il livello Fib SOTTO il nearestLevel (più alto ratio = più basso prezzo)
    // Per SHORT: il livello Fib SOPRA il nearestLevel (più alto ratio = più alto prezzo)
    let slPrice: number;
    const currentRatioIdx = FIB_RATIOS.indexOf(nearestLevel.ratio);
    const slLevelIdx = currentRatioIdx + 1; // prossimo livello più profondo

    if (direction === 'LONG') {
      slPrice = slLevelIdx < fibLevels.length
        ? fibLevels[slLevelIdx].price * (1 - 0.001)  // sotto il livello successivo
        : swingLow * (1 - 0.002);                     // sotto lo swing low
    } else {
      slPrice = slLevelIdx < fibLevels.length
        ? fibLevels[slLevelIdx].price * (1 + 0.001)  // sopra il livello successivo
        : swingHigh * (1 + 0.002);                    // sopra lo swing high
    }

    const slPct = Math.abs(entry - slPrice) / entry * 100;
    if (slPct < (cfg.minSlPct ?? 0.08)) { this.bump('sl_small'); return null; }
    if (slPct > (cfg.maxSlPct ?? 2.00)) { this.bump('sl_big');   return null; }

    // TP = verso il target del retracement (swing origin)
    // Per LONG: verso swingHigh; Per SHORT: verso swingLow
    const tpRr     = cfg.tpRr ?? 2.0;
    const minTpDist = slPct * tpRr / 100 * entry;
    let tpPrice: number;

    if (direction === 'LONG') {
      const natural = swingHigh;  // target naturale = ritorno allo swing high
      tpPrice = natural > entry + minTpDist ? natural : entry + minTpDist;
    } else {
      const natural = swingLow;   // target naturale = ritorno allo swing low
      tpPrice = natural < entry - minTpDist ? natural : entry - minTpDist;
    }

    const tpPct = Math.abs(entry - tpPrice) / entry * 100;

    // Sizing
    const positionSize = cfg.riskUsdt / (slPct / 100);
    const maxLev       = Number(this.markets[symbol]?.limits?.leverage?.max ?? 125) || 125;
    const leverage     = Math.max(1, Math.min(Math.ceil(positionSize / 5), maxLev, 125));
    const margin       = positionSize / leverage;

    // Cooldown
    if (cfg.cooldownMinutes > 0) {
      const since = new Date(Date.now() - cfg.cooldownMinutes * 60_000);
      const recent = await this.prisma.fibSimulatedTrade.findFirst({
        where: { symbol, direction, openedAt: { gte: since } },
      });
      if (recent) { this.bump('cooldown'); return null; }
    }

    // Score
    // Livello Fibonacci (61.8% = golden ratio = massimo punteggio)
    const fibScore = nearestLevel.ratio === 0.618 ? 40
                   : nearestLevel.ratio === 0.500 ? 28
                   : 15; // 38.2%
    // Precisione al livello (quanto vicino siamo)
    const precisionScore = Math.max(0, Math.round((1 - nearestLevel.dist / proxPct) * 25));
    // Volume
    const volScore = Math.min(20, Math.round((volRatio - 1) / 1.5 * 20));
    // Swing size (più grande il swing, più affidabile il livello)
    const swingScore = Math.min(15, Math.round(swingPct / 2 * 15));

    const score = Math.round(fibScore + precisionScore + volScore + swingScore);
    if (score < cfg.minScore) { this.bump('score'); return null; }

    const grade: Grade = score >= 80 ? 'A+' : score >= 60 ? 'A' : 'B';
    this.bump('ok');

    const px = (p: number) => {
      try { return parseFloat(this.exchange.priceToPrecision(symbol, p)); } catch { return p; }
    };

    const reasons: string[] = [
      `Fib ${nearestLevel.name} @ ${px(nearestLevel.price)} (dist ${nearestLevel.dist.toFixed(3)}%)`,
      `Swing ${swingPct.toFixed(2)}% (H:${px(swingHigh)} L:${px(swingLow)})`,
      `Vol ${volRatio.toFixed(2)}x`,
      `Δ ${deltaRatio >= 0 ? '+' : ''}${(deltaRatio * 100).toFixed(1)}%`,
      `VWAP ${vwap.toFixed(4)}`,
      `SL ${slPct.toFixed(2)}%`,
    ];

    return {
      id:                `${SOURCE}_${symbol}_${ts}`,
      symbol,
      direction,
      entry:             px(entry),
      stopLoss:          px(slPrice),
      takeProfit:        px(tpPrice),
      slPct:             parseFloat(slPct.toFixed(4)),
      tpPct:             parseFloat(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt:          parseFloat((cfg.riskUsdt ?? 1).toFixed(2)),
      positionSize:      parseFloat(positionSize.toFixed(4)),
      marginUsdt:        parseFloat(margin.toFixed(4)),
      score,
      grade,
      swingHigh:         parseFloat(swingHigh.toFixed(6)),
      swingLow:          parseFloat(swingLow.toFixed(6)),
      swingRange:        parseFloat(swingPct.toFixed(4)),
      fibLevel:          nearestLevel.ratio,
      fibLevelName:      nearestLevel.name,
      fibPrice:          px(nearestLevel.price),
      vwap:              parseFloat(vwap.toFixed(6)),
      volumeRatio:       parseFloat(volRatio.toFixed(3)),
      delta:             parseFloat(delta.toFixed(4)),
      deltaRatio:        parseFloat(deltaRatio.toFixed(3)),
      feeRate:           FEE,
      reasons,
      timestamp:         new Date(ts + 60_000).toISOString(),
    };
  }

  // ── Swing detection (zigzag con pivot high/low) ───────────────────────────────
  private findSwing(candles: number[][], pivotN: number, minSwingPct: number): Swing | null {
    const pivotHighs: { idx: number; price: number }[] = [];
    const pivotLows:  { idx: number; price: number }[] = [];

    for (let i = pivotN; i < candles.length - pivotN; i++) {
      const h = candles[i][2];
      const l = candles[i][3];

      // Pivot high: high più alto dei N vicini su entrambi i lati
      let isHigh = true;
      for (let j = i - pivotN; j <= i + pivotN; j++) {
        if (j !== i && candles[j][2] >= h) { isHigh = false; break; }
      }
      if (isHigh) pivotHighs.push({ idx: i, price: h });

      // Pivot low: low più basso dei N vicini su entrambi i lati
      let isLow = true;
      for (let j = i - pivotN; j <= i + pivotN; j++) {
        if (j !== i && candles[j][3] <= l) { isLow = false; break; }
      }
      if (isLow) pivotLows.push({ idx: i, price: l });
    }

    if (!pivotHighs.length || !pivotLows.length) return null;

    // Pivot più recente di ciascun tipo
    const lastHigh = pivotHighs[pivotHighs.length - 1];
    const lastLow  = pivotLows[pivotLows.length - 1];

    const range = lastHigh.price - lastLow.price;
    if (range <= 0) return null;

    const mid       = (lastHigh.price + lastLow.price) / 2;
    const swingPct  = range / mid * 100;
    if (swingPct < minSwingPct) return null;

    if (lastHigh.idx > lastLow.idx) {
      // Low → High: mossa bullish → LONG retracement
      return {
        direction: 'LONG',
        swingHigh: lastHigh.price,
        swingLow:  lastLow.price,
        range,
        swingPct,
        highIdx:   lastHigh.idx,
        lowIdx:    lastLow.idx,
      };
    } else {
      // High → Low: mossa bearish → SHORT retracement
      return {
        direction: 'SHORT',
        swingHigh: lastHigh.price,
        swingLow:  lastLow.price,
        range,
        swingPct,
        highIdx:   lastHigh.idx,
        lowIdx:    lastLow.idx,
      };
    }
  }

  // ── VWAP ─────────────────────────────────────────────────────────────────────
  private calcVwap(candles: number[][]): number {
    let tpv = 0, vol = 0;
    for (const c of candles) {
      const tp = (c[2] + c[3] + c[4]) / 3;
      tpv += tp * c[5];
      vol += c[5];
    }
    return vol > 0 ? tpv / vol : 0;
  }

  // ── Trade simulati ────────────────────────────────────────────────────────────
  private async enterSimTrade(sig: FibSignal, cfg: any) {
    const already = await this.prisma.fibSimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open' },
    });
    if (already) return;

    const capital = await this.currentCapital(cfg);
    await this.prisma.fibSimulatedTrade.create({
      data: {
        id:           sig.id,
        symbol:       sig.symbol,
        direction:    sig.direction,
        entry:        sig.entry,
        stopLoss:     sig.stopLoss,
        takeProfit:   sig.takeProfit,
        slPct:        sig.slPct,
        tpPct:        sig.tpPct,
        leverage:     sig.suggestedLeverage,
        riskUsdt:     sig.riskUsdt,
        positionSize: sig.positionSize,
        marginUsdt:   sig.marginUsdt,
        score:        sig.score,
        grade:        sig.grade,
        swingHigh:    sig.swingHigh,
        swingLow:     sig.swingLow,
        swingRange:   sig.swingRange,
        fibLevel:     sig.fibLevel,
        fibLevelName: sig.fibLevelName,
        fibPrice:     sig.fibPrice,
        vwap:         sig.vwap,
        volumeRatio:  sig.volumeRatio,
        delta:        sig.delta,
        deltaRatio:   sig.deltaRatio,
        feeRate:      sig.feeRate,
        fees:         sig.positionSize * sig.feeRate,
        capitalBefore: capital,
        status:       'open',
      },
    });
  }

  @Cron('20 * * * * *')
  async checkSimTrades() {
    const open = await this.prisma.fibSimulatedTrade.findMany({ where: { status: 'open' } });
    if (!open.length) return;

    const tickers: Record<string, any> = {};
    await Promise.allSettled(
      [...new Set(open.map(t => t.symbol))].map(async s => {
        try { tickers[s] = await this.exchange.fetchTicker(s); } catch {}
      })
    );

    for (const trade of open) {
      const ticker = tickers[trade.symbol];
      if (!ticker) continue;
      const price = Number(ticker.last ?? 0);
      if (!price) continue;

      const isLong = trade.direction === 'LONG';
      if      (isLong  && price >= trade.takeProfit) await this.closeSimTrade(trade, trade.takeProfit, 'tp');
      else if (!isLong && price <= trade.takeProfit) await this.closeSimTrade(trade, trade.takeProfit, 'tp');
      else if (isLong  && price <= trade.stopLoss)   await this.closeSimTrade(trade, trade.stopLoss,   'sl');
      else if (!isLong && price >= trade.stopLoss)   await this.closeSimTrade(trade, trade.stopLoss,   'sl');
      else {
        const priceDiff = isLong
          ? (price - trade.entry) / trade.entry
          : (trade.entry - price) / trade.entry;
        this.events.emitFibPositions([{
          id: trade.id,
          currentPrice: price,
          unrealizedPnl:    parseFloat((trade.positionSize * priceDiff - (trade.fees ?? 0)).toFixed(4)),
          unrealizedPnlPct: parseFloat((priceDiff * 100).toFixed(2)),
        }]);
      }
    }
  }

  private async closeSimTrade(trade: any, closePrice: number, status: string) {
    const isLong    = trade.direction === 'LONG';
    const priceDiff = isLong
      ? (closePrice - trade.entry) / trade.entry
      : (trade.entry - closePrice) / trade.entry;
    const exitFee   = trade.positionSize * Number(trade.feeRate ?? FEE);
    const totalFees = (trade.fees ?? 0) + exitFee;
    const pnl       = trade.positionSize * priceDiff - totalFees;

    const updated = await this.prisma.fibSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status, closePrice,
        pnl:          parseFloat(pnl.toFixed(4)),
        fees:         parseFloat(totalFees.toFixed(6)),
        capitalAfter: parseFloat(((trade.capitalBefore ?? 0) + pnl).toFixed(4)),
        closedAt:     new Date(),
      },
    });
    this.events.emitFibTrade(updated);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  private bump(k: string) { this.debug[k] = (this.debug[k] ?? 0) + 1; }

  private async openSimCount() {
    return this.prisma.fibSimulatedTrade.count({ where: { status: 'open' } });
  }

  private async currentCapital(cfg: any): Promise<number> {
    const last = await this.prisma.fibSimulatedTrade.findFirst({
      where: { capitalAfter: { not: null } }, orderBy: { openedAt: 'desc' },
    });
    return last?.capitalAfter ?? cfg.startingCapital;
  }

  private async ensureConfig() {
    const c = await this.prisma.fibConfig.findUnique({ where: { id: 1 } });
    if (c) return c;
    return this.prisma.fibConfig.create({ data: { id: 1 } });
  }

  private statusPayload() {
    return {
      isScanning:     this.isScanning,
      lastScanAt:     this.lastScanAt,
      lastError:      this.lastError,
      lastRawSignals: this.lastRawSignals,
      lastEmitted:    this.lastEmitted,
      symbols:        SYMBOLS.length,
      debug:          this.debug,
    };
  }

  // ── API pubblica ──────────────────────────────────────────────────────────────
  async getAnalytics() {
    const cfg    = await this.ensureConfig();
    const trades = await this.prisma.fibSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const open   = trades.filter(t => t.status === 'open');
    const wins   = closed.filter(t => (t.pnl ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);

    return {
      config:           cfg,
      totalPnl:         parseFloat(totalPnl.toFixed(2)),
      winRate:          closed.length ? parseFloat((wins.length / closed.length * 100).toFixed(1)) : 0,
      closedTrades:     closed.length,
      openTrades:       open.length,
      avgWin:           wins.length   ? parseFloat((wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length).toFixed(2)) : 0,
      avgLoss:          losses.length ? parseFloat((losses.reduce((s, t) => s + (t.pnl ?? 0), 0) / losses.length).toFixed(2)) : 0,
      recentSignals:    this.lastSignals,
      scannerStatus:    this.statusPayload(),
      symbols:          SYMBOLS,
      openTradesList:   open,
      closedTradesList: closed.slice(0, 100),
    };
  }

  getSignals(limit = 100) { return this.lastSignals.slice(0, limit); }
  getStatus()             { return this.statusPayload(); }

  async getCandles(symbol: string, limit = 120) {
    try {
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, limit + 1) as number[][];
      return ohlcv.slice(0, -1).map(c => ({
        time:   Math.floor(c[0] / 1000),
        open:   c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));
    } catch {
      return [];
    }
  }

  async getTrades(limit = 200) {
    return this.prisma.fibSimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' }, take: limit,
    });
  }

  async updateConfig(data: any) {
    const allowed = [
      'startingCapital', 'riskUsdt', 'tpRr', 'leverage', 'maxConcurrent',
      'enabled', 'autoEnter', 'liveEnabled', 'minScore',
      'swingPivotN', 'minSwingPct', 'proxPct',
      'minVolumeRatio', 'minDeltaRatio', 'minSlPct', 'maxSlPct', 'cooldownMinutes',
    ];
    const patch: any = {};
    for (const k of allowed) { if (data[k] !== undefined) patch[k] = data[k]; }
    return this.prisma.fibConfig.update({ where: { id: 1 }, data: patch });
  }

  async resetSim() {
    await this.prisma.fibSimulatedTrade.deleteMany({});
  }
}
