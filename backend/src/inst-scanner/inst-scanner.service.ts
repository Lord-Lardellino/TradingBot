import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';

const TIMEFRAME       = '5m';
const CANDLES         = 100;          // ~8h di contesto
const MIN_VOLUME_24H  = 80_000;       // bassa soglia: più coppie, più segnali
const SIGNAL_COOLDOWN = 5 * 60_000;  // 5 min = 1 candela 5m → no duplicati
const BATCH_SIZE      = 50;           // batch grandi — meno roundtrip, scan più veloce
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 0.50;
const MAX_SL_PCT      = 3.5;
const MIN_SL_PCT      = 0.15;

const PT_MOMENTUM = 1;  // candela impulso: corpo forte, chiusura estrema, trend a favore

export interface InstSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  patternType: number;
  patternName: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  slPct: number;
  tpPct: number;
  suggestedLeverage: number;
  volumeRatio: number;
  rsi14: number;
  atrPct: number;
  score: number;
  grade: 'A+' | 'A' | 'B';
  reasons: string[];
  timestamp: string;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema9spark: number[];
  ema21spark: number[];
  ema50spark: number[];
}

@Injectable()
export class InstScannerService implements OnModuleInit {
  private readonly logger = new Logger(InstScannerService.name);
  private exchange: ccxt.mexc;
  private fastExchange: ccxt.mexc; // no rate limiter — solo per public OHLCV in batch
  private validSymbols = new Set<string>();
  private recentSignals: InstSignal[] = [];
  private isScanning = false;
  private lastScanAt: string | null = null;
  private scannedCount = 0;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private cooldowns = new Map<string, number>();
  private readonly sessionStart = new Date();
  private dbg: Record<string, number> = {};
  private tickerCache: Record<string, any> = {};

  @Interval(30000)
  async refreshTickerCache() {
    try { this.tickerCache = await this.exchange.fetchTickers([...this.validSymbols]); } catch {}
  }

  constructor(
    private config: ConfigService,
    private indicators: IndicatorsService,
    private events: EventsGateway,
    private prisma: PrismaService,
    private liveTrading: LiveTradingService,
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
    // Istanza veloce senza rate limiter per fetch OHLCV pubblici in parallelo
    this.fastExchange = new ccxt.mexc({
      enableRateLimit: false,
      options: { defaultType: 'swap' },
    });
    await this.loadMarkets();
    await this.initConfig();
    this.logger.log(`[INST5m] ${this.validSymbols.size} coppie · TF=5m · scan ogni 1min · 3 pattern istituzionali`);
  }

  @Cron('0 0 * * * *')
  async loadMarkets() {
    try {
      const markets = await this.exchange.loadMarkets(true);
      // Condividi i dati di mercato con fastExchange senza re-fetch
      this.fastExchange.markets         = this.exchange.markets;
      this.fastExchange.markets_by_id   = this.exchange.markets_by_id;
      this.fastExchange.currencies      = this.exchange.currencies;
      this.fastExchange.currencies_by_id = this.exchange.currencies_by_id;
      this.validSymbols = new Set(Object.keys(markets).filter(s => s.endsWith('/USDT:USDT')));
    } catch (err: any) { this.logger.error(`loadMarkets: ${err.message}`); }
  }

  // ── SCAN 2s prima della chiusura candela 5m — ordine nella finestra ±1s dal close
  @Cron('58 4,9,14,19,24,29,34,39,44,49,54,59 * * * *')
  async scan() {
    if (this.isScanning || this.validSymbols.size === 0) return;
    this.isScanning = true;
    try {
      const cfg = await this.getConfig();
      // tickers dalla cache (già pronti), openSymbols in parallelo con config
      const tickers = Object.keys(this.tickerCache).length > 0
        ? this.tickerCache
        : await this.exchange.fetchTickers([...this.validSymbols]);
      const btcBias    = 'neutral'; // non bloccante — bias rimosso dal path critico
      const openSymbols = await this.getOpenSymbolsSet();

      const candidates = Object.values(tickers)
        .filter(t => this.validSymbols.has(t.symbol) && (t.quoteVolume ?? 0) >= MIN_VOLUME_24H && !openSymbols.has(t.symbol))
        .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
        .slice(0, 300);
      this.scannedCount = candidates.length;
      this.dbg = {};
      this.logger.log(`[INST5m] BTC bias: ${btcBias} · scansiono ${candidates.length} pair`);

      const openCount = await this.prisma.instSimulatedTrade.count({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (openCount >= cfg.maxConcurrent) {
        this.isScanning = false;
        this._emitStatus(cfg, candidates.length, 0, 0);
        return;
      }

      // Fetch OHLCV in batch paralleli — molto più veloce del sequenziale
      const cycleSignals: InstSignal[] = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async ticker => {
            try {
              const raw = await this.fastExchange.fetchOHLCV(ticker.symbol, TIMEFRAME, undefined, CANDLES);
              try {
                return this.analyzePair(ticker.symbol, raw, cfg, btcBias);
              } catch {
                this.dbg['analyze_err'] = (this.dbg['analyze_err'] ?? 0) + 1;
                return null;
              }
            } catch {
              this.dbg['fetch_err'] = (this.dbg['fetch_err'] ?? 0) + 1;
              return null;
            }
          }),
        );
        results.forEach(sig => sig && cycleSignals.push(sig));
        await new Promise(r => setTimeout(r, 50)); // pausa minima tra batch
      }
      this.lastRawSignals = cycleSignals.length;
      this.logger.log(`[INST5m DBG] raw=${cycleSignals.length} ${JSON.stringify(this.dbg)}`);

      // Best LONG + best SHORT per ciclo
      const bestLong  = cycleSignals.filter(s => s.direction === 'LONG').sort((a, b) => b.score - a.score)[0];
      const bestShort = cycleSignals.filter(s => s.direction === 'SHORT').sort((a, b) => b.score - a.score)[0];
      const best = [bestLong, bestShort].filter(Boolean) as InstSignal[];

      const toProcess = best.filter(sig => {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        return Date.now() - last >= SIGNAL_COOLDOWN;
      });
      for (const sig of toProcess) this.cooldowns.set(sig.symbol, Date.now());

      let emitted = 0;
      for (const sig of toProcess) {
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 200) this.recentSignals.pop();
        this.events.emitInstSignal(sig);
        if (cfg.autoEnter) {
          await this.enterSimTrade(sig, cfg).catch(() => {});
        }
        if (cfg.liveEnabled) {
          await this.liveTrading.enterTrade({
            symbol: sig.symbol, direction: sig.direction, grade: sig.grade,
            entry: sig.entry, slPct: sig.slPct, tp1Pct: sig.tpPct,
            suggestedLeverage: sig.suggestedLeverage, score: sig.score,
            stopLossPrice: sig.stopLoss,
            takeProfitPrice: sig.takeProfit1,
          }).catch(err => this.logger.error(`[INST LIVE] ${err.message}`));
        }
        emitted++;
        this.logger.log(`[INST5m ✅] ${sig.direction} ${sig.symbol} ${sig.patternName} score=${sig.score} grade=${sig.grade}`);
      }
      this.lastEmitted = emitted;
      this._emitStatus(cfg, candidates.length, cycleSignals.length, emitted);
    } catch (err: any) { this.logger.error(`Inst scan: ${err.message}`); }
    finally { this.isScanning = false; }
  }

  // ── CHECK OPEN TRADES ogni 30s ──────────────────────────────────────────────
  @Cron('*/30 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.instSimulatedTrade.findMany({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (!open.length) return;
      const cfg = await this.getConfig();

      for (const t of open) {
        try {
          const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 3);
          if (!ohlcv.length) continue;
          const curr      = ohlcv.at(-1)![4] as number;
          const candleHigh = ohlcv.at(-1)![2] as number;
          const candleLow  = ohlcv.at(-1)![3] as number;
          const isLong = t.direction === 'LONG';

          this.events.emitInstPositions([{
            id: t.id,
            currentPrice: curr,
            unrealizedPnl: parseFloat(((curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize).toFixed(4)),
            unrealizedPnlPct: parseFloat(((curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100).toFixed(3)),
          }]);

          // Break-Even — usa high/low della candela per non perdere tocchi intracandle
          const tpDist   = Math.abs(t.takeProfit1 - t.entry);
          const bePrice  = isLong ? t.entry + tpDist * 0.5 : t.entry - tpDist * 0.5;
          const beActive = isLong ? t.stopLoss >= t.entry * 0.9999 : t.stopLoss <= t.entry * 1.0001;
          const beHit    = isLong ? candleHigh >= bePrice : candleLow <= bePrice;
          if (!beActive && beHit) {
            await this.prisma.instSimulatedTrade.update({ where: { id: t.id }, data: { stopLoss: t.entry } });
            this.logger.log(`[INST5m BE] ${t.symbol} BE attivato — SL spostato a entry ${t.entry}`);
          }

          const hitSL = isLong ? curr <= t.stopLoss    : curr >= t.stopLoss;
          const hitTP = isLong ? curr >= t.takeProfit1 : curr <= t.takeProfit1;
          if (!hitSL && !hitTP) continue;

          const status     = hitTP ? 'tp1' : 'sl';
          const closePrice = hitTP ? t.takeProfit1 : t.stopLoss;
          const pnlRaw     = (closePrice - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const exitFee    = t.positionSize * TAKER_FEE;
          const totalFees  = (t.fees ?? 0) + exitFee;
          const pnl        = pnlRaw - totalFees;
          const capitalAfter = t.capitalBefore + pnl;

          await this.prisma.instSimulatedTrade.update({
            where: { id: t.id },
            data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(totalFees.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
          });
          if (cfg.autoEnter) {
            await this.prisma.instSimConfig.update({ where: { id: 1 }, data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) } });
          }
          const updated = await this.prisma.instSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.emitInstTrade(updated);
          this.logger.log(`[INST5m CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err: any) { this.logger.error(`Inst checkOpen: ${err.message}`); }
  }

  // ── BTC 15m BIAS ────────────────────────────────────────────────────────────
  private async getBtcBias(): Promise<'bullish' | 'bearish' | 'neutral'> {
    try {
      const raw = await this.exchange.fetchOHLCV('BTC/USDT:USDT', '15m', undefined, 30);
      if (raw.length < 15) return 'neutral';
      const closes = raw.map(c => c[4] as number);
      const ema21  = this.indicators.emaArray(closes, 21);
      if (ema21.length < 10) return 'neutral';
      const slope = (ema21.at(-1)! - ema21.at(-10)!) / ema21.at(-10)! * 100;
      return slope > 0.15 ? 'bullish' : slope < -0.15 ? 'bearish' : 'neutral';
    } catch { return 'neutral'; }
  }

  // ── ANALISI PATTERN SU SINGOLA COPPIA — PRICE ACTION PURA ──────────────────
  private analyzePair(sym: string, raw: number[][], cfg: any, _btcBias: string): InstSignal | null {
    const n = raw.length;
    if (n < 30) { this.dbg['no_data'] = (this.dbg['no_data'] ?? 0) + 1; return null; }

    const o = raw.map(r => r[1] as number);
    const h = raw.map(r => r[2] as number);
    const l = raw.map(r => r[3] as number);
    const c = raw.map(r => r[4] as number);
    const v = raw.map(r => r[5] as number);

    // Indice dinamico: se siamo entro 8s dalla chiusura, usa n-1 (candela in formazione)
    const TF_MS = 5 * 60_000;
    const lastTs = raw[n-1][0] as number;
    const timeUntilClose = (lastTs + TF_MS) - Date.now();
    const ti = timeUntilClose <= 8_000 ? n - 1 : n - 2; // trigger index

    const entry = c[ti];
    if (!entry || entry <= 0) return null;

    const atr14  = this.indicators.atr(h, l, c, 14);
    if (atr14 <= 0) return null;
    const atrPct = atr14 / entry * 100;

    // Volume ratio (20 candele prima del trigger)
    const volWindow = v.slice(ti - 20, ti);
    const avgVol    = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
    const volR      = avgVol > 0 ? v[ti] / avgVol : 1;

    // Candela trigger
    const cO = o[ti], cH = h[ti], cL = l[ti], cC = c[ti];
    const body        = Math.abs(cC - cO);
    const candleRange = cH - cL || atr14 * 0.01;
    const closePos    = (cC - cL) / candleRange;

    // SMA 34 — media esatta, nessun problema di warmup
    const sma34     = c.slice(ti - 33, ti + 1).reduce((a, b) => a + b, 0) / 34;
    const sma34_3   = c.slice(ti - 36, ti - 2).reduce((a, b) => a + b, 0) / 34; // SMA 3 candele fa
    if (sma34 <= 0) { this.dbg['no_sma34'] = (this.dbg['no_sma34'] ?? 0) + 1; return null; }

    // Trend valido solo se SMA ha pendenza minima significativa (no SMA piatta)
    const smaSlope   = sma34 - sma34_3;
    const smaRising  = smaSlope >=  atr14 * 0.05;
    const smaFalling = smaSlope <= -atr14 * 0.05;
    const longTrend  = cL > sma34 && smaRising;   // candela interamente sopra SMA in salita
    const shortTrend = cH < sma34 && smaFalling;  // candela interamente sotto SMA in discesa

    // Wick sul lato debole
    const lowerWick = Math.min(cO, cC) - cL;
    const upperWick = cH - Math.max(cO, cC);
    const weakLong  = lowerWick <= atr14 * 0.15;
    const weakShort = upperWick <= atr14 * 0.15;

    // ── PATTERN: MOMENTUM CANDLE ────────────────────────────────────────────
    // Sellers/buyers in control: 2+ candele precedenti già nella direzione
    const prevBullish = [1,2,3].filter(i => c[ti-i] > o[ti-i]).length;
    const prevBearish = [1,2,3].filter(i => c[ti-i] < o[ti-i]).length;
    const trendMomentum = longTrend ? prevBullish >= 2 : prevBearish >= 2;

    const momLong  = longTrend  && trendMomentum && cC > cO && body >= atr14 * 0.7 && closePos >= 0.70 && volR >= 1.3 && weakLong;
    const momShort = shortTrend && trendMomentum && cC < cO && body >= atr14 * 0.7 && closePos <= 0.30 && volR >= 1.3 && weakShort;

    // Debug granulare
    if (longTrend || shortTrend)  this.dbg['trend_ok']  = (this.dbg['trend_ok']  ?? 0) + 1;
    if (trendMomentum)            this.dbg['mom_ok']    = (this.dbg['mom_ok']    ?? 0) + 1;
    const trendWick = (longTrend && weakLong) || (shortTrend && weakShort);
    if (trendWick)               this.dbg['wick_ok']  = (this.dbg['wick_ok']  ?? 0) + 1;
    if (longTrend || shortTrend) this.dbg[volR >= 1.1 ? 'vol_ok' : 'vol_low'] = (this.dbg[volR >= 1.1 ? 'vol_ok' : 'vol_low'] ?? 0) + 1;
    const trendBody = (longTrend && cC > cO && body >= atr14 * 1.2) || (shortTrend && cC < cO && body >= atr14 * 1.2);
    if (trendBody)               this.dbg['body_ok']  = (this.dbg['body_ok']  ?? 0) + 1;
    if (momLong || momShort)     this.dbg['raw_mom']  = (this.dbg['raw_mom']  ?? 0) + 1;

    let isLong: boolean;
    const patternType = PT_MOMENTUM;
    const patternName = 'MOMENTUM';

    if      (momLong)  { isLong = true;  }
    else if (momShort) { isLong = false; }
    else { this.dbg['no_pattern'] = (this.dbg['no_pattern'] ?? 0) + 1; return null; }

    // ── SL: apertura della candela trigger — se torna lì il pattern è fallito
    const slLevel = cO;

    const slPct = isLong
      ? (entry - slLevel) / entry * 100
      : (slLevel - entry) / entry * 100;

    // Body medio: min 1.5× ATR già nei pattern, max 3× ATR per escludere spike/news
    if (body > atr14 * 3.0) {
      this.dbg['too_big'] = (this.dbg['too_big'] ?? 0) + 1; return null;
    }

    if (slPct < MIN_SL_PCT || slPct > MAX_SL_PCT) {
      this.dbg['sl_range'] = (this.dbg['sl_range'] ?? 0) + 1; return null;
    }

    // ── SCORING ──────────────────────────────────────────────────────────────
    let score = 40;
    const reasons: string[] = ['MOMENTUM'];

    const bodyMult = body / atr14;
    if      (bodyMult >= 3.0) { score += 15; reasons.push(`Body×${bodyMult.toFixed(1)}`); }
    else if (bodyMult >= 2.0) { score += 10; reasons.push(`Body×${bodyMult.toFixed(1)}`); }
    else if (bodyMult >= 1.5) { score += 5; }

    if      (isLong  && closePos >= 0.90) { score += 10; reasons.push('StrongClose'); }
    else if (isLong  && closePos >= 0.75) { score += 5; }
    else if (!isLong && closePos <= 0.10) { score += 10; reasons.push('StrongClose'); }
    else if (!isLong && closePos <= 0.25) { score += 5; }

    if      (volR >= 2.5) { score += 15; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.8) { score += 10; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.3) { score += 5; }

    if (score < cfg.minScore) { this.dbg['score_low'] = (this.dbg['score_low'] ?? 0) + 1; return null; }

    const grade: 'A+' | 'A' | 'B' = score >= 80 ? 'A+' : score >= 62 ? 'A' : 'B';

    // ── BUILD SIGNAL ─────────────────────────────────────────────────────────
    const tpPct    = slPct * cfg.tpRr;
    const tp1      = isLong ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    const leverage = Math.min(20, Math.max(3, Math.round(1 / (slPct / 100) * 0.5)));
    const margin   = RISK_EUR / (slPct / 100);
    const posSize  = margin * leverage;
    const ticker   = sym.replace('/USDT:USDT', '');
    const sparkStart = Math.max(0, n - 60);
    const sparkline  = raw.slice(sparkStart).map(r => ({ t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number, c: r[4] as number }));

    this.dbg['PRE_SIG'] = (this.dbg['PRE_SIG'] ?? 0) + 1;

    return {
      id: `inst_${sym}_${Date.now()}`,
      symbol: sym,
      direction: isLong ? 'LONG' : 'SHORT',
      patternType, patternName,
      entry,
      stopLoss:    parseFloat(slLevel.toPrecision(6)),
      takeProfit1: parseFloat(tp1.toPrecision(6)),
      slPct:       parseFloat(slPct.toFixed(3)),
      tpPct:       parseFloat(tpPct.toFixed(3)),
      suggestedLeverage: leverage,
      volumeRatio: parseFloat(volR.toFixed(2)),
      rsi14:  0,
      atrPct: parseFloat(atrPct.toFixed(3)),
      score, grade, reasons,
      timestamp: new Date().toISOString(),
      mexcUrl: `https://futures.mexc.com/exchange/${ticker}_USDT`,
      sparkline, ema9spark: [], ema21spark: [], ema50spark: [],
    };
  }

  // ── ENTER SIM TRADE ─────────────────────────────────────────────────────────
  private async enterSimTrade(sig: InstSignal, cfg: any) {
    const already = await this.prisma.instSimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open' },
    });
    if (already) return;

    const capital = cfg.startingCapital;
    const margin  = RISK_EUR / (sig.slPct / 100);
    const pos     = margin * sig.suggestedLeverage;
    const fee     = pos * TAKER_FEE;

    const trade = await this.prisma.instSimulatedTrade.create({
      data: {
        id: sig.id,
        symbol: sig.symbol, direction: sig.direction,
        patternType: sig.patternType, patternName: sig.patternName,
        entry: sig.entry, stopLoss: sig.stopLoss, takeProfit1: sig.takeProfit1,
        leverage: sig.suggestedLeverage,
        riskEur: RISK_EUR,
        positionSize: parseFloat(pos.toFixed(4)),
        marginEur: parseFloat(margin.toFixed(4)),
        grade: sig.grade, score: sig.score,
        fees: parseFloat(fee.toFixed(6)),
        capitalBefore: parseFloat(capital.toFixed(4)),
      },
    });
    this.events.emitInstTrade(trade);
  }

  private async getOpenSymbolsSet(): Promise<Set<string>> {
    const open = await this.prisma.instSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
      select: { symbol: true },
    });
    return new Set(open.map(t => t.symbol));
  }

  private _emitStatus(cfg: any, candidates: number, rawSignals: number, emitted: number) {
    this.events.server.emit('inst:status', {
      lastScanAt: new Date().toISOString(),
      scannedPairs: this.scannedCount,
      candidates, rawSignals, emitted,
      isScanning: false,
      debug: { ...this.dbg },
      config: { minScore: cfg.minScore, atrSlMult: cfg.atrSlMult, tpRr: cfg.tpRr },
    });
  }

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  private async initConfig() {
    const exists = await this.prisma.instSimConfig.findUnique({ where: { id: 1 } });
    if (!exists) {
      await this.prisma.instSimConfig.create({
        data: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 40, atrSlMult: 0.5, tpRr: 3.0, liveEnabled: false },
      });
    }
  }

  async getConfig() {
    let cfg = await this.prisma.instSimConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.instSimConfig.create({
        data: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 3.0, liveEnabled: false },
      });
    }
    return cfg;
  }

  async updateConfig(data: any) {
    return this.prisma.instSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 3.0, liveEnabled: false, ...data },
      update: data,
    });
  }

  // ── ANALYTICS ───────────────────────────────────────────────────────────────
  async getAnalytics() {
    const cfg    = await this.getConfig();
    const trades = await this.prisma.instSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const tp1    = closed.filter(t => t.status === 'tp1');
    const sl     = closed.filter(t => t.status === 'sl');
    const totalPnl   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees  = trades.reduce((s, t) => s + (t.fees ?? 0), 0);
    const winRate    = tp1.length + sl.length > 0 ? tp1.length / (tp1.length + sl.length) * 100 : null;

    const byPattern: Record<string, { tp: number; sl: number }> = {};
    for (const t of closed) {
      if (!byPattern[t.patternName]) byPattern[t.patternName] = { tp: 0, sl: 0 };
      if (t.status === 'tp1') byPattern[t.patternName].tp++;
      if (t.status === 'sl')  byPattern[t.patternName].sl++;
    }

    return {
      totalTrades: trades.length,
      openTrades:  trades.filter(t => t.status === 'open').length,
      closedTrades: closed.length,
      tp1Count: tp1.length, slCount: sl.length,
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      totalFees: parseFloat(totalFees.toFixed(4)),
      winRate: winRate !== null ? parseFloat(winRate.toFixed(1)) : null,
      capital: cfg.startingCapital,
      byPattern,
      config: cfg,
      recentSignals: this.recentSignals.slice(0, 50),
      scannerStatus: {
        lastScanAt: this.lastScanAt,
        scannedPairs: this.scannedCount,
        lastRawSignals: this.lastRawSignals,
        lastEmitted: this.lastEmitted,
        isScanning: this.isScanning,
      },
    };
  }

  async getTrades(limit = 100) {
    return this.prisma.instSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' }, take: limit });
  }

  async resetSim() {
    await this.prisma.instSimulatedTrade.deleteMany({});
    await this.prisma.instSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    this.recentSignals = [];
  }
}
