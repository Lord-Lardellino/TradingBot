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
const MIN_TRIGGER_VOL_R = 0.08;       // non bloccante: la strategia e' price action su EMA34
const SIGNAL_COOLDOWN = 5 * 60_000;  // 5 min = 1 candela 5m → no duplicati
const SCAN_PAIR_LIMIT = 100;
const BATCH_SIZE      = 5;            // batch piccoli — meno connessioni parallele, meno fetch_err
const BATCH_DELAY_MS  = 100;
const CANDLE_MS       = 5 * 60_000;
const CLOSE_CONFIRM_DELAY_MS = 250;
const MAX_CLOSE_CONFIRM_LAG_MS = 3_000;
const FETCH_RETRIES   = 3;
const FETCH_RETRY_DELAY_MS = 250;
const EMA_PERIOD = 34;
const EMA_SLOPE_LOOKBACK = 5;
const MIN_EMA_SLOPE_ATR = 0.05;
const STRONG_EMA_SLOPE_ATR = 0.12;
const MIN_TRIGGER_BODY_ATR = 0.55;
const MAX_TRIGGER_BODY_ATR = 2.20;
const MIN_BODY_RANGE_RATIO = 0.70;
const MAX_CLOSE_WICK_RANGE = 0.045;
const MAX_CLOSE_WICK_ATR = 0.030;
const MAX_OPPOSITE_WICK_RANGE = 0.08;
const MAX_OPPOSITE_WICK_ATR = 0.055;
const LONG_CLOSE_POS_MIN = 0.92;
const SHORT_CLOSE_POS_MAX = 0.08;
const EMA_TOUCH_ATR = 0.55;
const MIN_EMA_DISTANCE_ATR = 0.10;
const MAX_EMA_DISTANCE_ATR = 2.60;
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 2.0;
const MAX_FEE_TO_RISK = 0.55;

const PT_EMA34_IMPULSE = 1;
const MAX_IMPULSE_BODY_ATR = MAX_TRIGGER_BODY_ATR;      // legacy method only, not used by scanner
const MAX_IMPULSE_SMA_DIST_ATR = MAX_EMA_DISTANCE_ATR; // legacy method only, not used by scanner
const PT_MOMENTUM = PT_EMA34_IMPULSE;                  // legacy method only, not used by scanner
const PT_IMPULSE_BREAK = PT_EMA34_IMPULSE;             // legacy method only, not used by scanner

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
  triggerTs: number;
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
  private lastScanPairList: string[] = [];
  private trendCandidates: { sym: string; dir: string; reason: string }[] = [];
  private nearMisses:      { sym: string; dir: string; reason: string }[] = [];
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
    // Istanza separata per OHLCV pubblici in batch.
    this.fastExchange = new ccxt.mexc({
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await this.loadMarkets();
    await this.initConfig();
    this.logger.log(`[INST5m] ${this.validSymbols.size} coppie · TF=5m · EMA34_IMPULSE only`);
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

  // ── SCAN 4s prima della chiusura candela 5m — ordine nella finestra ±1s dal close
  @Cron('25 4,9,14,19,24,29,34,39,44,49,54,59 * * * *')
  async scan() {
    if (this.isScanning || this.validSymbols.size === 0) return;
    this.isScanning = true;
    try {
      const scanStartedAt = Date.now();
      const targetCloseAt = Math.floor(scanStartedAt / CANDLE_MS) * CANDLE_MS + CANDLE_MS + CLOSE_CONFIRM_DELAY_MS;
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
        .slice(0, SCAN_PAIR_LIMIT);
      this.scannedCount = candidates.length;
      this.dbg = {};
      this.trendCandidates = [];
      this.nearMisses = [];
      this.lastScanPairList = candidates.map(t => t.symbol.replace('/USDT:USDT', ''));
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
              const raw = await this.fetchOHLCVWithRetry(ticker.symbol, TIMEFRAME, CANDLES, 'fetch_err');
              if (!raw) return null;
              try {
                return this.analyzePair(ticker.symbol, raw, cfg, btcBias, 'forming');
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
        await this.sleep(BATCH_DELAY_MS);
      }
      this.lastRawSignals = cycleSignals.length;
      this.logger.log(`[INST5m DBG] raw=${cycleSignals.length} ${JSON.stringify(this.dbg)}`);

      const preSelected = cycleSignals.sort((a, b) => b.score - a.score).filter(sig => {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        return Date.now() - last >= SIGNAL_COOLDOWN;
      });
      this.dbg['preselected'] = preSelected.length;

      if (preSelected.length) {
        const waitToClose = targetCloseAt - Date.now();
        if (waitToClose > 0) {
          await this.sleep(waitToClose);
        }
        const closeLag = Date.now() - targetCloseAt;
        if (closeLag > MAX_CLOSE_CONFIRM_LAG_MS) {
          this.dbg['late_confirm_skip'] = preSelected.length;
          this.logger.warn(`[INST5m SKIP] conferma in ritardo ${closeLag}ms su ${preSelected.length} segnali`);
          this.lastEmitted = 0;
          this._emitStatus(cfg, candidates.length, cycleSignals.length, 0);
          return;
        }
      }

      const toProcess: InstSignal[] = [];
      for (let i = 0; i < preSelected.length; i += BATCH_SIZE) {
        const batch = preSelected.slice(i, i + BATCH_SIZE);
        const confirmedBatch = await Promise.all(
          batch.map(async pre => {
            const raw = await this.fetchOHLCVWithRetry(pre.symbol, TIMEFRAME, CANDLES, 'confirm_fetch_err');
            if (!raw) return null;
            try {
              const confirmed = this.analyzePair(pre.symbol, raw, cfg, btcBias, 'closed', pre.triggerTs);
              if (confirmed && confirmed.direction === pre.direction) {
                this.dbg['confirm_ok'] = (this.dbg['confirm_ok'] ?? 0) + 1;
                return confirmed;
              }
              this.dbg['confirm_fail'] = (this.dbg['confirm_fail'] ?? 0) + 1;
              return null;
            } catch {
              this.dbg['confirm_analyze_err'] = (this.dbg['confirm_analyze_err'] ?? 0) + 1;
              return null;
            }
          }),
        );
        confirmedBatch.forEach(sig => sig && toProcess.push(sig));
        if (i + BATCH_SIZE < preSelected.length) await this.sleep(25);
      }
      if (preSelected.length) {
        this.logger.log(`[INST5m CONFIRM] pre=${preSelected.length} ok=${toProcess.length} lag=${Date.now() - targetCloseAt}ms`);
      }
      for (const sig of toProcess) this.cooldowns.set(sig.symbol, Date.now());

      let emitted = 0;
      const liveSlots = Math.max(0, cfg.maxConcurrent - openCount);
      const liveEntries: Promise<void>[] = [];
      for (const sig of toProcess) {
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 200) this.recentSignals.pop();
        this.events.emitInstSignal(sig);
        if (cfg.liveEnabled && liveEntries.length < liveSlots) {
          liveEntries.push(this.liveTrading.enterTrade({
            symbol: sig.symbol, direction: sig.direction, grade: sig.grade,
            entry: sig.entry, slPct: sig.slPct, tp1Pct: sig.tpPct,
            suggestedLeverage: sig.suggestedLeverage, score: sig.score,
            stopLossPrice: sig.stopLoss,
            takeProfitPrice: sig.takeProfit1,
          }).catch(err => this.logger.error(`[INST LIVE] ${err.message}`)));
        }
        if (cfg.autoEnter) {
          await this.enterSimTrade(sig, cfg).catch(() => {});
        }
        emitted++;
        this.logger.log(`[INST5m ✅] ${sig.direction} ${sig.symbol} ${sig.patternName} score=${sig.score} grade=${sig.grade}`);
      }
      if (liveEntries.length) {
        this.dbg['live_queued'] = liveEntries.length;
        await Promise.all(liveEntries);
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

          const hitSL = isLong ? candleLow <= t.stopLoss    : candleHigh >= t.stopLoss;
          const hitTP = isLong ? candleHigh >= t.takeProfit1 : candleLow <= t.takeProfit1;
          if (!hitSL && !hitTP) continue;

          const isBreakEvenStop = hitSL && !hitTP && Math.abs(t.stopLoss - t.entry) / t.entry <= 0.00001;
          const status     = hitTP ? 'tp1' : isBreakEvenStop ? 'be' : 'sl';
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

  // Single strategy: EMA34 impulse at trigger-candle close.
  private analyzePair(
    sym: string,
    raw: number[][],
    cfg: any,
    _btcBias: string,
    triggerMode: 'forming' | 'closed' = 'forming',
    expectedTriggerTs?: number,
  ): InstSignal | null {
    const n = raw.length;
    if (n < EMA_PERIOD + EMA_SLOPE_LOOKBACK + 25) {
      this.dbg['no_data'] = (this.dbg['no_data'] ?? 0) + 1;
      return null;
    }

    const o = raw.map(r => r[1] as number);
    const h = raw.map(r => r[2] as number);
    const l = raw.map(r => r[3] as number);
    const c = raw.map(r => r[4] as number);
    const v = raw.map(r => r[5] as number);

    let ti = n - 1;
    if (triggerMode === 'closed') {
      if (expectedTriggerTs) {
        const idx = raw.findIndex(r => Number(r[0]) === expectedTriggerTs);
        if (idx < 0) {
          this.dbg['confirm_missing_trigger'] = (this.dbg['confirm_missing_trigger'] ?? 0) + 1;
          return null;
        }
        if (Date.now() < expectedTriggerTs + CANDLE_MS) {
          this.dbg['confirm_not_closed'] = (this.dbg['confirm_not_closed'] ?? 0) + 1;
          return null;
        }
        ti = idx;
        this.dbg['closed_trigger_ts'] = (this.dbg['closed_trigger_ts'] ?? 0) + 1;
      } else {
        const lastTs = raw[n - 1][0] as number;
        const lastClosed = Date.now() >= lastTs + CANDLE_MS;
        ti = lastClosed ? n - 1 : n - 2;
        this.dbg[lastClosed ? 'closed_n1' : 'closed_n2'] = (this.dbg[lastClosed ? 'closed_n1' : 'closed_n2'] ?? 0) + 1;
      }
    }
    if (ti < EMA_PERIOD + EMA_SLOPE_LOOKBACK + 20) {
      this.dbg['no_history'] = (this.dbg['no_history'] ?? 0) + 1;
      return null;
    }

    const cO = o[ti], cH = h[ti], cL = l[ti], entry = c[ti];
    if (!Number.isFinite(entry) || entry <= 0) return null;

    const hHist = h.slice(0, ti + 1);
    const lHist = l.slice(0, ti + 1);
    const cHist = c.slice(0, ti + 1);
    const atr14 = this.indicators.atr(hHist, lHist, cHist, 14);
    if (!Number.isFinite(atr14) || atr14 <= 0) return null;
    const atrPct = atr14 / entry * 100;

    const ema34arr = this.indicators.emaArray(cHist, EMA_PERIOD);
    const emaOffset = EMA_PERIOD - 1;
    const emaAt = (idx: number) => ema34arr[idx - emaOffset] ?? NaN;
    const ema34 = emaAt(ti);
    const emaPrev = emaAt(ti - EMA_SLOPE_LOOKBACK);
    if (!Number.isFinite(ema34) || !Number.isFinite(emaPrev)) {
      this.dbg['no_ema34'] = (this.dbg['no_ema34'] ?? 0) + 1;
      return null;
    }

    const emaSlopeAtr = (ema34 - emaPrev) / atr14;
    const emaRising = emaSlopeAtr >= MIN_EMA_SLOPE_ATR;
    const emaFalling = emaSlopeAtr <= -MIN_EMA_SLOPE_ATR;

    const body = Math.abs(entry - cO);
    const candleRange = cH - cL;
    if (candleRange <= 0) return null;
    const bodyAtr = body / atr14;
    const bodyRange = body / candleRange;
    const closePos = (entry - cL) / candleRange;

    const upperWick = cH - Math.max(cO, entry);
    const lowerWick = Math.min(cO, entry) - cL;
    const maxCloseWick = Math.min(candleRange * MAX_CLOSE_WICK_RANGE, atr14 * MAX_CLOSE_WICK_ATR);
    const bodyOk = bodyAtr >= MIN_TRIGGER_BODY_ATR && bodyAtr <= MAX_TRIGGER_BODY_ATR && bodyRange >= MIN_BODY_RANGE_RATIO;

    const longCloseClean = closePos >= LONG_CLOSE_POS_MIN && upperWick <= maxCloseWick;
    const shortCloseClean = closePos <= SHORT_CLOSE_POS_MAX && lowerWick <= maxCloseWick;
    const maxOppositeWick = Math.min(candleRange * MAX_OPPOSITE_WICK_RANGE, atr14 * MAX_OPPOSITE_WICK_ATR);
    const longOppositeWickOk = lowerWick <= maxOppositeWick;
    const shortOppositeWickOk = upperWick <= maxOppositeWick;

    const longSide = entry > ema34;
    const shortSide = entry < ema34;
    const emaDistLong = (entry - ema34) / atr14;
    const emaDistShort = (ema34 - entry) / atr14;
    const longDistOk = emaDistLong >= MIN_EMA_DISTANCE_ATR && emaDistLong <= MAX_EMA_DISTANCE_ATR;
    const shortDistOk = emaDistShort >= MIN_EMA_DISTANCE_ATR && emaDistShort <= MAX_EMA_DISTANCE_ATR;

    const prevEma = emaAt(ti - 1);
    const crossLong = Number.isFinite(prevEma) && c[ti - 1] <= prevEma && entry > ema34;
    const crossShort = Number.isFinite(prevEma) && c[ti - 1] >= prevEma && entry < ema34;

    let recentTouchLong = false;
    let recentTouchShort = false;
    for (let i = 1; i <= 8; i++) {
      const idx = ti - i;
      const e = emaAt(idx);
      if (!Number.isFinite(e)) continue;
      if (l[idx] <= e + atr14 * EMA_TOUCH_ATR && c[idx] >= e - atr14 * 0.80) recentTouchLong = true;
      if (h[idx] >= e - atr14 * EMA_TOUCH_ATR && c[idx] <= e + atr14 * 0.80) recentTouchShort = true;
    }

    const recentHigh = Math.max(...h.slice(Math.max(0, ti - 5), ti));
    const recentLow = Math.min(...l.slice(Math.max(0, ti - 5), ti));
    const breaksRecentHigh = entry > recentHigh;
    const breaksRecentLow = entry < recentLow;
    const prevEmaDistance = Number.isFinite(prevEma) ? Math.abs((c[ti - 1] - prevEma) / atr14) : Infinity;
    const contextLong = recentTouchLong || crossLong || (breaksRecentHigh && prevEmaDistance <= 1.0);
    const contextShort = recentTouchShort || crossShort || (breaksRecentLow && prevEmaDistance <= 1.0);

    const volumeWindow = v.slice(ti - 20, ti);
    const avgVol = volumeWindow.reduce((a, b) => a + b, 0) / volumeWindow.length;
    const volR = avgVol > 0 ? v[ti] / avgVol : 1;

    const longSignal =
      longSide && emaRising && contextLong && longDistOk &&
      entry > cO && bodyOk && longCloseClean && longOppositeWickOk;
    const shortSignal =
      shortSide && emaFalling && contextShort && shortDistOk &&
      entry < cO && bodyOk && shortCloseClean && shortOppositeWickOk;

    if (emaRising || emaFalling) this.dbg['ema_slope_ok'] = (this.dbg['ema_slope_ok'] ?? 0) + 1;
    if (longSide || shortSide) this.dbg['ema_side_ok'] = (this.dbg['ema_side_ok'] ?? 0) + 1;
    if (bodyOk) this.dbg['body_ok'] = (this.dbg['body_ok'] ?? 0) + 1;
    if (longCloseClean || shortCloseClean) this.dbg['wick_ok'] = (this.dbg['wick_ok'] ?? 0) + 1;
    if (contextLong || contextShort) this.dbg['ema_context_ok'] = (this.dbg['ema_context_ok'] ?? 0) + 1;
    if (longDistOk || shortDistOk) this.dbg['dist_ok'] = (this.dbg['dist_ok'] ?? 0) + 1;

    const candidateLong = longSide && emaRising && entry > cO;
    const candidateShort = shortSide && emaFalling && entry < cO;
    if (candidateLong || candidateShort) {
      const dir = candidateLong ? 'L' : 'S';
      const contextOk = candidateLong ? contextLong : contextShort;
      const distOk = candidateLong ? longDistOk : shortDistOk;
      const cleanClose = candidateLong ? longCloseClean : shortCloseClean;
      const oppositeOk = candidateLong ? longOppositeWickOk : shortOppositeWickOk;
      if (!contextOk) this.trendCandidates.push({ sym, dir, reason: 'no_ema_context' });
      else if (!distOk) this.trendCandidates.push({ sym, dir, reason: `dist_${(candidateLong ? emaDistLong : emaDistShort).toFixed(2)}ATR` });
      else if (!bodyOk) this.trendCandidates.push({ sym, dir, reason: `body_${bodyAtr.toFixed(2)}ATR_range_${bodyRange.toFixed(2)}` });
      else if (!cleanClose) this.trendCandidates.push({ sym, dir, reason: 'close_wick' });
      else if (!oppositeOk) this.trendCandidates.push({ sym, dir, reason: 'opposite_wick' });
    }

    if (!longSignal && !shortSignal) {
      this.dbg['no_pattern'] = (this.dbg['no_pattern'] ?? 0) + 1;
      return null;
    }

    this.dbg['raw_ema34_impulse'] = (this.dbg['raw_ema34_impulse'] ?? 0) + 1;
    const isLong = longSignal;
    const direction = isLong ? 'LONG' : 'SHORT';
    const dir = isLong ? 'L' : 'S';
    const nearMiss = (reason: string) => { this.nearMisses.push({ sym, dir, reason }); };

    const slLevel = cO;
    const slPct = isLong
      ? (entry - slLevel) / entry * 100
      : (slLevel - entry) / entry * 100;
    if (slPct <= 0) return null;

    const estimatedRoundTripFee = (RISK_EUR / (slPct / 100)) * TAKER_FEE * 2;
    if (estimatedRoundTripFee > RISK_EUR * MAX_FEE_TO_RISK) {
      this.dbg['fee_too_high'] = (this.dbg['fee_too_high'] ?? 0) + 1;
      nearMiss(`fee_${estimatedRoundTripFee.toFixed(2)}`);
      return null;
    }

    let score = 45;
    const reasons: string[] = ['EMA34_IMPULSE'];
    const absSlope = Math.abs(emaSlopeAtr);
    if (absSlope >= STRONG_EMA_SLOPE_ATR) { score += 16; reasons.push(`EMA34Slope_${absSlope.toFixed(2)}ATR`); }
    else { score += 10; reasons.push(`EMA34Slope_${absSlope.toFixed(2)}ATR`); }

    if (bodyAtr >= 0.80 && bodyAtr <= 1.60) { score += 14; reasons.push(`Body_${bodyAtr.toFixed(2)}ATR`); }
    else { score += 8; reasons.push(`Body_${bodyAtr.toFixed(2)}ATR`); }

    score += 14;
    reasons.push('NoCloseWick');

    if (crossLong || crossShort) { score += 8; reasons.push('CrossEMA34'); }
    else { score += 6; reasons.push('PullbackEMA34'); }

    const dist = isLong ? emaDistLong : emaDistShort;
    if (dist >= 0.35 && dist <= 1.80) { score += 5; reasons.push(`Dist_${dist.toFixed(2)}ATR`); }
    else { score += 2; reasons.push(`Dist_${dist.toFixed(2)}ATR`); }

    const closeWick = isLong ? upperWick : lowerWick;
    if (closeWick <= maxCloseWick * 0.5) score += 4;
    if (volR >= 1.8) { score += 5; reasons.push(`Vol_${volR.toFixed(1)}`); }
    else if (volR >= 1.3) { score += 3; reasons.push(`Vol_${volR.toFixed(1)}`); }

    if (score < cfg.minScore) {
      this.dbg['score_low'] = (this.dbg['score_low'] ?? 0) + 1;
      nearMiss(`score_${score}<${cfg.minScore}`);
      return null;
    }

    const grade: 'A+' | 'A' | 'B' = score >= 82 ? 'A+' : score >= 70 ? 'A' : 'B';
    const tpPct = slPct * cfg.tpRr;
    const tp1 = isLong ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    const leverage = Math.min(15, Math.max(3, Math.round(1 / (slPct / 100) * 0.35)));
    const ticker = sym.replace('/USDT:USDT', '');
    const sparkStart = Math.max(0, ti - 59);
    const sparkline = raw.slice(sparkStart, ti + 1).map(r => ({ t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number, c: r[4] as number }));
    const emaSpark = ema34arr.slice(Math.max(0, ema34arr.length - sparkline.length));

    this.dbg['PRE_SIG'] = (this.dbg['PRE_SIG'] ?? 0) + 1;

    return {
      id: `inst_${sym}_${raw[ti][0]}`,
      symbol: sym,
      direction,
      patternType: PT_EMA34_IMPULSE,
      patternName: 'EMA34_IMPULSE',
      entry,
      stopLoss: parseFloat(slLevel.toPrecision(8)),
      takeProfit1: parseFloat(tp1.toPrecision(8)),
      slPct: parseFloat(slPct.toFixed(3)),
      tpPct: parseFloat(tpPct.toFixed(3)),
      suggestedLeverage: leverage,
      volumeRatio: parseFloat(volR.toFixed(2)),
      rsi14: 0,
      atrPct: parseFloat(atrPct.toFixed(3)),
      score, grade, reasons,
      timestamp: new Date().toISOString(),
      triggerTs: raw[ti][0] as number,
      mexcUrl: `https://futures.mexc.com/exchange/${ticker}_USDT`,
      sparkline, ema9spark: [], ema21spark: [], ema50spark: emaSpark,
    };
  }

  // ── ANALISI PATTERN SU SINGOLA COPPIA — PRICE ACTION PURA ──────────────────
  private analyzePairLegacyDisabled(sym: string, raw: number[][], cfg: any, _btcBias: string, triggerMode: 'forming' | 'closed' = 'forming'): any {
    const n = raw.length;
    if (n < 30) { this.dbg['no_data'] = (this.dbg['no_data'] ?? 0) + 1; return null; }

    const o = raw.map(r => r[1] as number);
    const h = raw.map(r => r[2] as number);
    const l = raw.map(r => r[3] as number);
    const c = raw.map(r => r[4] as number);
    const v = raw.map(r => r[5] as number);

    // In conferma MEXC a volte non ha ancora pubblicato la nuova candela.
    // Usa l'ultima candela se risulta già chiusa, altrimenti la penultima.
    const lastTs = raw[n - 1][0] as number;
    const lastClosed = Date.now() >= lastTs + CANDLE_MS;
    const ti = triggerMode === 'closed'
      ? (lastClosed ? n - 1 : n - 2)
      : n - 1;
    if (triggerMode === 'closed') {
      this.dbg[lastClosed ? 'closed_n1' : 'closed_n2'] = (this.dbg[lastClosed ? 'closed_n1' : 'closed_n2'] ?? 0) + 1;
    }
    if (ti < 38) { this.dbg['no_history'] = (this.dbg['no_history'] ?? 0) + 1; return null; }

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
    const sma34_5   = c.slice(ti - 38, ti - 4).reduce((a, b) => a + b, 0) / 34; // SMA 5 candele fa
    if (sma34 <= 0) { this.dbg['no_sma34'] = (this.dbg['no_sma34'] ?? 0) + 1; return null; }

    const smaSlope   = sma34 - sma34_5;
    const smaRising  = smaSlope >=  atr14 * 0.03;
    const smaFalling = smaSlope <= -atr14 * 0.03;
    // LONG: cattura bounce (cL > sma34) e cross dal basso (cC > sma34, cL <= sma34)
    // SHORT: solo candele interamente sotto SMA (cH < sma34) — evita falsi segnali sopra SMA
    const isCrossLong  = cC > sma34 && cL <= sma34;
    const isCrossShort = cC < sma34 && cH >= sma34;
    const longTrend  = cC > sma34 && (smaRising || isCrossLong);
    const shortTrend = cC < sma34 && (smaFalling || isCrossShort);

    // Wick sul lato debole
    const lowerWick = Math.min(cO, cC) - cL;
    const upperWick = cH - Math.max(cO, cC);
    const maxWeakWick = Math.min(atr14 * 0.05, candleRange * 0.15);
    const weakLong  = lowerWick <= maxWeakWick;
    const weakShort = upperWick <= maxWeakWick;

    // ── PATTERN: MOMENTUM CANDLE ────────────────────────────────────────────
    const prevBullish = [1,2,3].filter(i => c[ti-i] > o[ti-i]).length;
    const prevBearish = [1,2,3].filter(i => c[ti-i] < o[ti-i]).length;
    // LONG cross: basta 1 bullish precedente; LONG bounce: 2+
    // SHORT: basta 1 bearish — catchare la prima candela dopo il bounce/cross
    // Pullback recente alla SMA (LONG: max 1.5×ATR sopra; SHORT: max 1.0×ATR sotto — più stretto)
    const hadPullbackLong  = [1,2,3,4,5].some(i => l[ti-i] <= sma34 + atr14 * 1.5);
    const hadPullbackShort = [1,2,3,4,5].some(i => h[ti-i] >= sma34 - atr14 * 1.0);

    const smaDistLong  = (cC - sma34) / atr14;
    const smaDistShort = (sma34 - cC) / atr14;
    const volumeOk = volR >= MIN_TRIGGER_VOL_R;
    const triggerLong  = cC > cO && body >= atr14 * 0.45 && closePos >= 0.65 && weakLong;
    const triggerShort = cC < cO && body >= atr14 * 0.45 && closePos <= 0.35 && weakShort;
    const trendMomentum = longTrend
      ? triggerLong  && (isCrossLong  || hadPullbackLong  || prevBullish >= 1)
      : triggerShort && (isCrossShort || hadPullbackShort || prevBearish >= 1);

    const cleanLong  = volumeOk && longTrend  && triggerLong  && body <= atr14 * MAX_IMPULSE_BODY_ATR && smaDistLong  <= MAX_IMPULSE_SMA_DIST_ATR;
    const cleanShort = volumeOk && shortTrend && triggerShort && body <= atr14 * MAX_IMPULSE_BODY_ATR && smaDistShort <= MAX_IMPULSE_SMA_DIST_ATR;
    const momLong  = cleanLong  && trendMomentum && hadPullbackLong  && body <= atr14 * 1.2;
    const momShort = cleanShort && trendMomentum && hadPullbackShort && body <= atr14 * 1.2;
    const impulseLong  = cleanLong  && trendMomentum && body >= atr14 * 0.9 && closePos >= 0.85;
    const impulseShort = cleanShort && trendMomentum && body >= atr14 * 0.9 && closePos <= 0.15;
    const cleanPushLong  = cleanLong  && body >= atr14 * 0.6;
    const cleanPushShort = cleanShort && body >= atr14 * 0.6;

    // Debug granulare
    if (longTrend || shortTrend)  this.dbg['trend_ok']  = (this.dbg['trend_ok']  ?? 0) + 1;
    if (trendMomentum)            this.dbg['mom_ok']    = (this.dbg['mom_ok']    ?? 0) + 1;
    const trendWick = (longTrend && weakLong) || (shortTrend && weakShort);
    if (trendWick)               this.dbg['wick_ok']  = (this.dbg['wick_ok']  ?? 0) + 1;
    if (longTrend || shortTrend) this.dbg[volumeOk ? 'vol_ok' : 'vol_low'] = (this.dbg[volumeOk ? 'vol_ok' : 'vol_low'] ?? 0) + 1;
    const trendBody = (longTrend && cC > cO && body >= atr14 * 1.2) || (shortTrend && cC < cO && body >= atr14 * 1.2);
    if (trendBody)               this.dbg['body_ok']  = (this.dbg['body_ok']  ?? 0) + 1;
    if (momLong || momShort)     this.dbg['raw_mom']  = (this.dbg['raw_mom']  ?? 0) + 1;
    if (impulseLong || impulseShort) this.dbg['raw_impulse'] = (this.dbg['raw_impulse'] ?? 0) + 1;
    if (cleanPushLong || cleanPushShort) this.dbg['raw_clean_push'] = (this.dbg['raw_clean_push'] ?? 0) + 1;

    // Trend candidates: track perché ogni coppia con trend fallisce
    if (longTrend || shortTrend) {
      const dir = longTrend ? 'L' : 'S';
      if (!trendMomentum)                                      this.trendCandidates.push({ sym, dir, reason: 'no_mom' });
      else if (longTrend && !hadPullbackLong && !impulseLong && !cleanPushLong)  this.trendCandidates.push({ sym, dir, reason: `no_pullback (×${smaDistLong.toFixed(1)}ATR)` });
      else if (shortTrend && !hadPullbackShort && !impulseShort && !cleanPushShort) this.trendCandidates.push({ sym, dir, reason: `no_pullback (×${smaDistShort.toFixed(1)}ATR)` });
      else if (!trendWick)                                     this.trendCandidates.push({ sym, dir, reason: 'wick_fail' });
      else if (body < atr14*0.5)                               this.trendCandidates.push({ sym, dir, reason: `body_small ×${(body/atr14).toFixed(1)}` });
      else if (longTrend && !triggerLong)                      this.trendCandidates.push({ sym, dir, reason: 'bad_trigger_wick_close' });
      else if (shortTrend && !triggerShort)                    this.trendCandidates.push({ sym, dir, reason: 'bad_trigger_wick_close' });
      else if (!volumeOk)                                      this.trendCandidates.push({ sym, dir, reason: `vol_low ×${volR.toFixed(1)}` });
      else if (!(momLong || momShort || impulseLong || impulseShort || cleanPushLong || cleanPushShort)) this.trendCandidates.push({ sym, dir, reason: 'close_pos' });
    }

    let isLong: boolean;
    let patternType: number;
    let patternName: string;

    if      (impulseLong)  { isLong = true;  patternType = PT_IMPULSE_BREAK; patternName = 'IMPULSE_BREAK'; }
    else if (impulseShort) { isLong = false; patternType = PT_IMPULSE_BREAK; patternName = 'IMPULSE_BREAK'; }
    else if (cleanPushLong)  { isLong = true;  patternType = PT_IMPULSE_BREAK; patternName = 'CLEAN_PUSH'; }
    else if (cleanPushShort) { isLong = false; patternType = PT_IMPULSE_BREAK; patternName = 'CLEAN_PUSH'; }
    else if (momLong)      { isLong = true;  patternType = PT_MOMENTUM;      patternName = 'MOMENTUM'; }
    else if (momShort)     { isLong = false; patternType = PT_MOMENTUM;      patternName = 'MOMENTUM'; }
    else { this.dbg['no_pattern'] = (this.dbg['no_pattern'] ?? 0) + 1; return null; }

    const _dir = isLong ? 'L' : 'S';
    const _nm  = (reason: string) => { this.nearMisses.push({ sym, dir: _dir, reason }); };

    // ── SL: apertura della candela trigger — se torna lì il pattern è fallito
    const slLevel = cO;

    const slPct = isLong
      ? (entry - slLevel) / entry * 100
      : (slLevel - entry) / entry * 100;

    if (body > atr14 * MAX_IMPULSE_BODY_ATR) {
      this.dbg['too_big'] = (this.dbg['too_big'] ?? 0) + 1; _nm('body_too_big'); return null;
    }

    if (slPct <= 0) return null;

    const estimatedRoundTripFee = (RISK_EUR / (slPct / 100)) * TAKER_FEE * 2;
    if (estimatedRoundTripFee > RISK_EUR * MAX_FEE_TO_RISK) {
      this.dbg['fee_too_high'] = (this.dbg['fee_too_high'] ?? 0) + 1;
      _nm(`fee_${estimatedRoundTripFee.toFixed(2)}`);
      return null;
    }

    // ── SCORING ──────────────────────────────────────────────────────────────
    // Range body effettivo: 0.5–1.2×ATR (imposto dai filtri sopra)
    // Sweet spot pre-breakout: 0.6–0.9×ATR — corpo non troppo piccolo, non già esploso
    let score = patternName === 'MOMENTUM' ? 40 : 42;
    const reasons: string[] = [patternName];

    const bodyMult = body / atr14;
    if (patternName !== 'MOMENTUM') {
      if      (bodyMult >= 1.05 && bodyMult <= 1.35) { score += 20; reasons.push(`ImpulseBody×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >= 0.90 && bodyMult <  1.05) { score += 14; reasons.push(`Body×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >  1.35 && bodyMult <= 1.80) { score +=  8; reasons.push(`ExtendedBody×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >  1.80 && bodyMult <= MAX_IMPULSE_BODY_ATR) { score +=  4; reasons.push(`WideImpulse×${bodyMult.toFixed(2)}`); }
    } else {
      if      (bodyMult >= 0.85 && bodyMult <= 1.05) { score += 20; reasons.push(`Body×${bodyMult.toFixed(2)} sweet`); }
      else if (bodyMult >= 0.65 && bodyMult <  0.85) { score += 12; reasons.push(`Body×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >= 1.05 && bodyMult <= 1.20) { score +=  5; }
    }
    // bodyMult < 0.65 o prossimo al min: 0 punti — setup debole

    if      (isLong  && closePos >= 0.90) { score += 15; reasons.push('StrongClose'); }
    else if (isLong  && closePos >= 0.80) { score += 10; reasons.push('GoodClose'); }
    else if (isLong  && closePos >= 0.65) { score +=  5; }
    else if (!isLong && closePos <= 0.10) { score += 15; reasons.push('StrongClose'); }
    else if (!isLong && closePos <= 0.20) { score += 10; reasons.push('GoodClose'); }
    else if (!isLong && closePos <= 0.35) { score +=  5; }

    if      (volR >= 2.5) { score += patternName === 'IMPULSE_BREAK' ? 18 : 15; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.8) { score += patternName === 'IMPULSE_BREAK' ? 12 : 10; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.3) { score += patternName === 'IMPULSE_BREAK' ?  7 :  5; }

    // Bonus cross SMA (setup più pulito)
    if (isCrossLong) { score += 5; reasons.push('CrossSMA'); }
    if (isCrossShort) { score += 5; reasons.push('CrossSMA'); }

    if (score < cfg.minScore) { this.dbg['score_low'] = (this.dbg['score_low'] ?? 0) + 1; _nm(`score_${score}<${cfg.minScore}`); return null; }

    // Score range reale: 40–95 — soglie ricalibrate
    const grade: 'A+' | 'A' | 'B' = score >= 75 ? 'A+' : score >= 60 ? 'A' : 'B';

    // ── BUILD SIGNAL ─────────────────────────────────────────────────────────
    const tpPct    = slPct * cfg.tpRr;
    const tp1      = isLong ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    const leverage = Math.min(20, Math.max(3, Math.round(1 / (slPct / 100) * 0.5)));
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
    const pos     = RISK_EUR / (sig.slPct / 100); // posizione: sempre RISK_EUR / slPct
    const margin  = pos / sig.suggestedLeverage;
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

  private async fetchOHLCVWithRetry(symbol: string, timeframe: string, limit: number, failKey: string): Promise<number[][] | null> {
    let lastErr: any = null;
    for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
      try {
        return await this.fastExchange.fetchOHLCV(symbol, timeframe, undefined, limit) as number[][];
      } catch (err: any) {
        lastErr = err;
        if (attempt < FETCH_RETRIES) {
          this.dbg[`${failKey}_retry`] = (this.dbg[`${failKey}_retry`] ?? 0) + 1;
          await this.sleep(FETCH_RETRY_DELAY_MS * attempt);
        }
      }
    }
    this.dbg[failKey] = (this.dbg[failKey] ?? 0) + 1;
    this.logger.warn(`[INST5m FETCH] ${symbol} ${failKey}: ${lastErr?.message?.slice(0, 120) ?? 'unknown'}`);
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      trendCandidates: this.trendCandidates.slice(0, 30),
      nearMisses: this.nearMisses.slice(0, 20),
      lastScanPairs: this.lastScanPairList,
      config: { minScore: cfg.minScore, atrSlMult: cfg.atrSlMult, tpRr: cfg.tpRr },
    });
  }

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  private async initConfig() {
    const exists = await this.prisma.instSimConfig.findUnique({ where: { id: 1 } });
    if (!exists) {
      await this.prisma.instSimConfig.create({
        data: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 40, atrSlMult: 0.5, tpRr: 2.0, liveEnabled: false },
      });
    }
  }

  async getConfig() {
    let cfg = await this.prisma.instSimConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.instSimConfig.create({
        data: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 2.0, liveEnabled: false },
      });
    }
    return cfg;
  }

  async updateConfig(data: any) {
    return this.prisma.instSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 2.0, liveEnabled: false, ...data },
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
    const be     = closed.filter(t => t.status === 'be');
    const totalPnl   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees  = trades.reduce((s, t) => s + (t.fees ?? 0), 0);
    const winRate    = tp1.length + sl.length > 0 ? tp1.length / (tp1.length + sl.length) * 100 : null;

    const byPattern: Record<string, { tp: number; sl: number; be: number }> = {};
    for (const t of closed) {
      if (!byPattern[t.patternName]) byPattern[t.patternName] = { tp: 0, sl: 0, be: 0 };
      if (t.status === 'tp1') byPattern[t.patternName].tp++;
      if (t.status === 'sl')  byPattern[t.patternName].sl++;
      if (t.status === 'be')  byPattern[t.patternName].be++;
    }

    return {
      totalTrades: trades.length,
      openTrades:  trades.filter(t => t.status === 'open').length,
      closedTrades: closed.length,
      tp1Count: tp1.length, slCount: sl.length, beCount: be.length,
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
      debug: { ...this.dbg },
      lastScanPairs: this.lastScanPairList,
      trendCandidates: this.trendCandidates.slice(0, 30),
      nearMisses: this.nearMisses.slice(0, 20),
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
