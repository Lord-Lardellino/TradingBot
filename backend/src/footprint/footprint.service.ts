import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { LiveTradingService } from '../live/live-trading.service';
import { PrismaService } from '../prisma/prisma.service';

const SOURCE       = 'FOOTPRINT';
const TF           = '1m';
const VWAP_CANDLES = 240;
const FEE          = 0.0006;

const SYMBOLS = [
  'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT',
  'DOGE/USDT:USDT', 'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT',
  'LINK/USDT:USDT', 'SUI/USDT:USDT',
];

type Grade = 'A+' | 'A' | 'B';

interface FVG {
  type:     'bullish' | 'bearish';
  high:     number;   // top del gap
  low:      number;   // bottom del gap
  mid:      number;   // midpoint
  size:     number;   // gap size in %
  candleIdx: number;  // indice candela i (quella che crea il gap)
}

export interface FootprintSignal {
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
  // FVG data (mappati sui campi DB range*)
  fvgHigh:           number;   // => rangeHigh
  fvgLow:            number;   // => rangeLow
  fvgSize:           number;   // => rangeSize (%)
  volumeRatio:       number;
  // Flow data
  vwap:              number;
  delta:             number;
  deltaRatio:        number;
  feeRate:           number;
  reasons:           string[];
  timestamp:         string;
}

@Injectable()
export class FootprintService implements OnModuleInit {
  private readonly logger = new Logger(FootprintService.name);
  private exchange: ccxt.mexc;
  private markets: Record<string, any> = {};

  private lastSignals: FootprintSignal[] = [];
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private isScanning = false;
  private lastRawSignals = 0;
  private lastEmitted = 0;
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
    try {
      this.markets = await this.exchange.loadMarkets();
    } catch (e: any) {
      this.logger.warn(`[FOOTPRINT] loadMarkets: ${e?.message}`);
    }
    await this.ensureConfig();
    this.logger.log(`[FOOTPRINT] attivo — FVG Retest (1m) su ${SYMBOLS.length} coppie`);
  }

  @Cron('2 * * * * *')
  async scan() {
    const cfg = await this.ensureConfig();
    if (!cfg.enabled) return;

    this.debug = {};
    this.isScanning = true;
    const signals: FootprintSignal[] = [];

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
      this.events.emitFootprintSignal(sig);

      if (slots > 0 && cfg.autoEnter) {
        await this.enterSimTrade(sig, cfg);
        slots--;
      }

      if (cfg.liveEnabled) {
        await this.liveTrading.enterTrade({
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
        }).catch(err => this.logger.error(`[FOOTPRINT LIVE] ${sig.symbol}: ${err?.message}`));
      }
    }

    this.events.emitFootprintStatus(this.statusPayload());
    if (signals.length > 0 || Object.keys(this.debug).length > 0) {
      this.logger.log(`[FOOTPRINT] signals=${signals.length} dbg=${JSON.stringify(this.debug)}`);
    }
  }

  // ── Core: FVG Retest su un singolo simbolo ───────────────────────────────────
  private async scanOne(symbol: string, cfg: any): Promise<FootprintSignal | null> {
    // Fetch candele: VWAP_CANDLES + 35 per avere abbastanza storia FVG
    const totalCandles = VWAP_CANDLES + 35;
    const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, totalCandles) as number[][];
    if (!ohlcv || ohlcv.length < 10) { this.bump('no_candle'); return null; }

    const last = ohlcv.length - 1;

    // Candela corrente (last closed = penultima, l'ultima potrebbe essere in formazione)
    const breakoutCandle = ohlcv[last - 1];
    const [ts, open, high, low, close, vol] = breakoutCandle;
    if (!close || !vol) { this.bump('no_close'); return null; }

    // VWAP sulle ultime VWAP_CANDLES candele chiuse
    const vpCandles = ohlcv.slice(last - VWAP_CANDLES, last);
    const vwap = this.calcVwap(vpCandles);
    if (!vwap) { this.bump('no_vwap'); return null; }

    // FVG scan: nelle ultime 30 candele chiuse (escludendo la breakoutCandle)
    const fvgWindow = ohlcv.slice(last - 31, last - 1); // [i-2, i-1, i] → serviranno triadi
    const fvgs = this.findFVGs(fvgWindow, cfg.rangeLookback ?? 6);

    if (!fvgs.length) { this.bump('no_fvg'); return null; }

    // Volume medio delle ultime rangeLookback+10 candele (esclusa la breakout)
    const avgVolWindow = ohlcv.slice(last - (cfg.rangeLookback + 10), last - 1);
    const avgVol = avgVolWindow.reduce((s, c) => s + c[5], 0) / avgVolWindow.length || 1;
    const volRatio = vol / avgVol;

    if (volRatio < cfg.minVolumeRatio) { this.bump('vol_weak'); return null; }

    // Cerca FVG retestato dalla breakoutCandle
    // Bullish FVG: prezzo scende nel gap → setup LONG
    // Bearish FVG: prezzo sale nel gap → setup SHORT
    const entry = close;

    let targetFVG: FVG | null = null;
    let direction: 'LONG' | 'SHORT' | null = null;

    for (const fvg of fvgs) {
      // FVG bullish: il low della breakout candle entra nel gap → LONG retest
      if (fvg.type === 'bullish' && entry >= fvg.low && entry <= fvg.high) {
        // Filtro VWAP: price sopra VWAP per setup LONG
        if (entry > vwap) {
          targetFVG = fvg;
          direction = 'LONG';
          break;
        }
      }
      // FVG bearish: il high della breakout candle entra nel gap → SHORT retest
      if (fvg.type === 'bearish' && entry >= fvg.low && entry <= fvg.high) {
        // Filtro VWAP: price sotto VWAP per setup SHORT
        if (entry < vwap) {
          targetFVG = fvg;
          direction = 'SHORT';
          break;
        }
      }
    }

    if (!targetFVG || !direction) { this.bump('no_retest'); return null; }

    // Delta trades (ultimo minuto chiuso)
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

    // Conferma delta nella direzione del setup
    const deltaOk = direction === 'LONG'
      ? deltaRatio > cfg.minDeltaRatio
      : deltaRatio < -cfg.minDeltaRatio;

    if (!deltaOk) { this.bump('delta_weak'); return null; }

    // SL = bordo opposto del FVG + buffer 0.05%
    let slPrice: number;
    if (direction === 'LONG') {
      slPrice = targetFVG.low * (1 - 0.0005);
    } else {
      slPrice = targetFVG.high * (1 + 0.0005);
    }

    const slPct = Math.abs(entry - slPrice) / entry * 100;
    if (slPct < cfg.minSlPct) { this.bump('sl_small'); return null; }
    if (slPct > cfg.maxSlPct) { this.bump('sl_big');   return null; }

    // TP = entry ± fvgSize × tpRangeMultiplier
    const fvgSize = targetFVG.high - targetFVG.low;
    const tpDist  = fvgSize * (cfg.tpRangeMultiplier ?? 1.5);
    const tpPrice = direction === 'LONG'
      ? entry + tpDist
      : entry - tpDist;

    // Garantisce RR minimo 1:1
    const minTpPct = slPct;
    const actualTpPct = Math.abs(entry - tpPrice) / entry * 100;
    const tpFinal = actualTpPct >= minTpPct ? tpPrice
      : direction === 'LONG'
        ? entry * (1 + minTpPct / 100)
        : entry * (1 - minTpPct / 100);

    const tpPct = Math.abs(entry - tpFinal) / entry * 100;

    // Sizing
    const positionSize = cfg.riskUsdt / (slPct / 100);
    const maxLev       = Number(this.markets[symbol]?.limits?.leverage?.max ?? 125) || 125;
    const leverage     = Math.max(1, Math.min(Math.ceil(positionSize / 5), maxLev, 125));
    const margin       = positionSize / leverage;

    // Cooldown
    if (cfg.cooldownMinutes > 0) {
      const since = new Date(Date.now() - cfg.cooldownMinutes * 60_000);
      const recent = await this.prisma.footprintSimulatedTrade.findFirst({
        where: { symbol, direction, openedAt: { gte: since } },
      });
      if (recent) { this.bump('cooldown'); return null; }
    }

    // Score
    // Range tightness del FVG: gap piccolo = più preciso (max 30 pt)
    const fvgSizePct = targetFVG.size;
    const tightnessScore = Math.max(0, Math.min(30, (1 - fvgSizePct / 0.5) * 30));
    // Volume (max 30 pt)
    const volScore = Math.min(30, (volRatio - 1) / 1.5 * 30);
    // Delta (max 25 pt)
    const deltaScore = Math.min(25, Math.abs(deltaRatio) / 0.4 * 25);
    // VWAP distance: più lontano dal VWAP nella direzione corretta = migliore (max 15 pt)
    const vwapDistPct = Math.abs(entry - vwap) / vwap * 100;
    const vwapScore = Math.min(15, vwapDistPct / 0.3 * 15);

    const score = Math.round(tightnessScore + volScore + deltaScore + vwapScore);
    if (score < cfg.minScore) { this.bump('score'); return null; }

    const grade: Grade = score >= 80 ? 'A+' : score >= 60 ? 'A' : 'B';

    this.bump('ok');

    const px = (p: number) => {
      try { return parseFloat(this.exchange.priceToPrecision(symbol, p)); } catch { return p; }
    };

    const reasons: string[] = [
      `FVG ${targetFVG.type} ${px(targetFVG.low)}-${px(targetFVG.high)} (${targetFVG.size.toFixed(3)}%)`,
      `Δ ${deltaRatio >= 0 ? '+' : ''}${(deltaRatio * 100).toFixed(1)}%`,
      `Vol ${volRatio.toFixed(2)}x`,
      `VWAP ${vwap.toFixed(4)}`,
      `SL ${slPct.toFixed(2)}%`,
    ];

    return {
      id:                `${SOURCE}_${symbol}_${ts}`,
      symbol,
      direction,
      entry:             px(entry),
      stopLoss:          px(slPrice),
      takeProfit:        px(tpFinal),
      slPct:             parseFloat(slPct.toFixed(4)),
      tpPct:             parseFloat(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt:          parseFloat(cfg.riskUsdt.toFixed(2)),
      positionSize:      parseFloat(positionSize.toFixed(4)),
      marginUsdt:        parseFloat(margin.toFixed(4)),
      score,
      grade,
      fvgHigh:           parseFloat(targetFVG.high.toFixed(6)),
      fvgLow:            parseFloat(targetFVG.low.toFixed(6)),
      fvgSize:           parseFloat(targetFVG.size.toFixed(4)),
      volumeRatio:       parseFloat(volRatio.toFixed(3)),
      vwap:              parseFloat(vwap.toFixed(6)),
      delta:             parseFloat(delta.toFixed(4)),
      deltaRatio:        parseFloat(deltaRatio.toFixed(3)),
      feeRate:           FEE,
      reasons,
      timestamp:         new Date(ts + 60_000).toISOString(),
    };
  }

  // ── FVG detection ─────────────────────────────────────────────────────────────
  // Scansiona le ultime N candele per Fair Value Gaps non ancora riempiti.
  // Bullish FVG: high[i-2] < low[i] su move rialzista (gap tra c[i-2].high e c[i].low)
  // Bearish FVG: low[i-2] > high[i] su move ribassista (gap tra c[i-2].low e c[i].high)
  private findFVGs(candles: number[][], maxAge: number): FVG[] {
    const fvgs: FVG[] = [];
    // Analizza triadi: [i-2, i-1, i]
    for (let i = 2; i < candles.length; i++) {
      const c0 = candles[i - 2];
      const c1 = candles[i - 1];
      const c2 = candles[i];
      const [, , h0, l0] = c0;
      const [, , h1, l1] = c1; // candela impulso
      const [, , h2, l2] = c2;

      const mid1 = (h1 + l1) / 2;

      // Bullish FVG: c1 è un impulso rialzista che lascia gap tra high[c0] e low[c2]
      if (l2 > h0 && c1[4] > c1[1]) {
        const gapLow  = h0;
        const gapHigh = l2;
        const sizePct = (gapHigh - gapLow) / mid1 * 100;
        if (sizePct > 0.02 && sizePct < 2.0) {
          fvgs.push({
            type:      'bullish',
            high:      gapHigh,
            low:       gapLow,
            mid:       (gapHigh + gapLow) / 2,
            size:      sizePct,
            candleIdx: i,
          });
        }
      }

      // Bearish FVG: c1 è un impulso ribassista che lascia gap tra low[c0] e high[c2]
      if (h2 < l0 && c1[4] < c1[1]) {
        const gapLow  = h2;
        const gapHigh = l0;
        const sizePct = (gapHigh - gapLow) / mid1 * 100;
        if (sizePct > 0.02 && sizePct < 2.0) {
          fvgs.push({
            type:      'bearish',
            high:      gapHigh,
            low:       gapLow,
            mid:       (gapHigh + gapLow) / 2,
            size:      sizePct,
            candleIdx: i,
          });
        }
      }
    }

    // Ritorna solo FVG recenti (ultimi maxAge), più recenti prima
    return fvgs.slice(-maxAge).reverse();
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

  // ── Gestione trade simulati ───────────────────────────────────────────────────
  private async enterSimTrade(sig: FootprintSignal, cfg: any) {
    const already = await this.prisma.footprintSimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open' },
    });
    if (already) return;

    const capital = await this.currentCapital(cfg);
    await this.prisma.footprintSimulatedTrade.create({
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
        rangeHigh:    sig.fvgHigh,
        rangeLow:     sig.fvgLow,
        rangeSize:    sig.fvgSize,
        volumeRatio:  sig.volumeRatio,
        vwap:         sig.vwap,
        delta:        sig.delta,
        deltaRatio:   sig.deltaRatio,
        feeRate:      sig.feeRate,
        fees:         sig.positionSize * sig.feeRate,
        capitalBefore: capital,
        status:       'open',
      },
    });
  }

  @Cron('15 * * * * *')
  async checkSimTrades() {
    const open = await this.prisma.footprintSimulatedTrade.findMany({ where: { status: 'open' } });
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
        this.events.emitFootprintPositions([{
          id: trade.id,
          currentPrice: price,
          unrealizedPnl: parseFloat((trade.positionSize * priceDiff - (trade.fees ?? 0)).toFixed(4)),
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

    const updated = await this.prisma.footprintSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status, closePrice,
        pnl:         parseFloat(pnl.toFixed(4)),
        fees:        parseFloat(totalFees.toFixed(6)),
        capitalAfter: parseFloat(((trade.capitalBefore ?? 0) + pnl).toFixed(4)),
        closedAt:    new Date(),
      },
    });
    this.events.emitFootprintTrade(updated);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  private bump(k: string) { this.debug[k] = (this.debug[k] ?? 0) + 1; }

  private async openSimCount() {
    return this.prisma.footprintSimulatedTrade.count({ where: { status: 'open' } });
  }

  private async currentCapital(cfg: any): Promise<number> {
    const last = await this.prisma.footprintSimulatedTrade.findFirst({
      where: { capitalAfter: { not: null } }, orderBy: { openedAt: 'desc' },
    });
    return last?.capitalAfter ?? cfg.startingCapital;
  }

  private async ensureConfig() {
    const c = await this.prisma.footprintConfig.findUnique({ where: { id: 1 } });
    if (c) return c;
    return this.prisma.footprintConfig.create({ data: { id: 1 } });
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
    const trades = await this.prisma.footprintSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
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
        time:  Math.floor(c[0] / 1000),
        open:  c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));
    } catch {
      return [];
    }
  }

  async getTrades(limit = 200) {
    return this.prisma.footprintSimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' }, take: limit,
    });
  }

  async updateConfig(data: any) {
    const allowed = [
      'startingCapital', 'riskUsdt', 'tpRangeMultiplier', 'leverage', 'maxConcurrent',
      'enabled', 'autoEnter', 'liveEnabled', 'minScore',
      'rangeLookback', 'rangeThresholdPct', 'minRangePct',
      'minDeltaRatio', 'minVolumeRatio', 'minSlPct', 'maxSlPct', 'cooldownMinutes',
    ];
    const patch: any = {};
    for (const k of allowed) { if (data[k] !== undefined) patch[k] = data[k]; }
    return this.prisma.footprintConfig.update({ where: { id: 1 }, data: patch });
  }

  async resetSim() {
    await this.prisma.footprintSimulatedTrade.deleteMany({});
  }
}
