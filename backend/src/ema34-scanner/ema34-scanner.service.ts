import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';

const SOURCE = 'EMA34';
const TF     = '1m';
const FEE    = 0.0006;
const EMA_PERIOD = 34;

type Grade = 'A+' | 'A' | 'B';

export interface Ema34Signal {
  id:                string;
  symbol:            string;
  direction:         'LONG' | 'SHORT';
  entry:             number;
  stopLoss:          number;
  takeProfit:        number;   // TP iniziale (RR base)
  slPct:             number;
  tpPct:             number;
  suggestedLeverage: number;
  riskUsdt:          number;
  positionSize:      number;
  marginUsdt:        number;
  score:             number;
  grade:             Grade;
  // EMA34 data
  ema34:             number;   // valore EMA34 al momento del segnale
  emaSlope:          number;   // slope% EMA34 (5 candles)
  crossAgo:          number;   // candele fa del cross
  // Flow
  volumeRatio:       number;
  deltaRatio:        number;
  feeRate:           number;
  reasons:           string[];
  timestamp:         string;
}

@Injectable()
export class Ema34ScannerService implements OnModuleInit {
  private readonly logger = new Logger(Ema34ScannerService.name);
  private exchange: ccxt.mexc;
  private markets: Record<string, any> = {};

  // Top 50 coppie per volume — aggiornate ogni ora
  private top50: string[] = [];
  private top50UpdatedAt = 0;

  private lastSignals: Ema34Signal[] = [];
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
    private liveTrading: LiveTradingService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      timeout: 8000,
      options: { defaultType: 'swap' },
    });
    try {
      this.markets = await this.exchange.loadMarkets();
    } catch (e: any) {
      this.logger.warn(`[EMA34] loadMarkets: ${e?.message}`);
    }
    const initCfg = await this.ensureConfig();
    const cfgPatch: any = {};
    if (initCfg.maxCrossAgo < 40) cfgPatch.maxCrossAgo = 50;
    if (initCfg.tpRr >= 2.9)      cfgPatch.tpRr        = 1.5;
    if (initCfg.minEmaSlope < 0.05)          cfgPatch.minEmaSlope = 0.05;
    if (initCfg.emaSlopeConsistencyN < 10)  cfgPatch.emaSlopeConsistencyN = 10;
    if (Object.keys(cfgPatch).length) {
      await this.prisma.ema34Config.update({ where: { id: 1 }, data: cfgPatch });
    }
    await this.refreshTop50();
    this.logger.log(`[EMA34] Scanner attivo - Cross + primo pullback + breakout - 1m - ${this.top50.length} coppie top volume`);
  }

  // ── Aggiorna top 50 ogni ora ──────────────────────────────────────────────
  @Cron('0 0 * * * *')
  async refreshTop50() {
    try {
      const tickers = await this.exchange.fetchTickers();
      const usdtPerp = Object.values(tickers)
        .filter((t: any) => t.symbol?.endsWith('/USDT:USDT') && t.quoteVolume > 0)
        .sort((a: any, b: any) => b.quoteVolume - a.quoteVolume)
        .slice(0, 50)
        .map((t: any) => t.symbol);
      if (usdtPerp.length >= 20) {
        this.top50 = usdtPerp;
        this.top50UpdatedAt = Date.now();
        this.logger.log(`[EMA34] Top 50 aggiornate: ${this.top50.slice(0, 5).join(', ')}...`);
      }
    } catch (e: any) {
      this.logger.warn(`[EMA34] refreshTop50 failed: ${e?.message}`);
      // Fallback se nessun dato
      if (!this.top50.length) {
        this.top50 = [
          'BTC/USDT:USDT', 'ETH/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT',
          'DOGE/USDT:USDT', 'BNB/USDT:USDT', 'ADA/USDT:USDT', 'AVAX/USDT:USDT',
          'LINK/USDT:USDT', 'SUI/USDT:USDT',
        ];
      }
    }
  }

  // ── Scan principale — cron a :30 per entrare vicino alla chiusura candela ──
  @Cron('30 * * * * *')
  async scan() {
    if (this.isScanning) return;

    const cfg = await this.ensureConfig();
    if (!cfg.enabled || !this.top50.length) return;

    this.debug = {};
    this.isScanning = true;
    const signals: Ema34Signal[] = [];

    try {
      // Conservative batching: this scanner runs together with other modules, so keep
      // the OHLCV burst small to avoid transient MEXC fetch errors.
      const batchSize = 2;
      const batchDelayMs = 280;
      for (let i = 0; i < this.top50.length; i += batchSize) {
        const batch = this.top50.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(async sym => {
          try {
            const sig = await this.scanOne(sym, cfg);
            if (sig) signals.push(sig);
          } catch {
            this.bump('fetch_err');
          }
        }));
        if (i + batchSize < this.top50.length) await new Promise(r => setTimeout(r, batchDelayMs));
      }

      signals.sort((a, b) => b.score - a.score);
      this.lastSignals    = signals;
      this.lastScanAt     = new Date().toISOString();
      this.lastError      = null;
      this.lastRawSignals = signals.length;
      this.lastEmitted    = signals.length;

      for (const sig of signals) {
        this.events.emitEma34Signal(sig);

        if (cfg.autoEnter) {
          await this.enterSimTrade(sig, cfg);
        }

        if (cfg.liveEnabled) {
          // Entra solo se siamo entro 60s dalla chiusura della candela 1m corrente
          const nextClose = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
          const secsToClose = (nextClose - Date.now()) / 1000;
          if (secsToClose <= 60) {
            this.logger.log(`[EMA34 LIVE] ${sig.symbol} ${sig.direction} → entro (${Math.round(secsToClose)}s alla chiusura)`);
            this.liveTrading.enterTrade({
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
            }).catch(err => this.logger.error(`[EMA34 LIVE] ${sig.symbol}: ${err?.message}`));
          } else {
            this.logger.warn(`[EMA34 LIVE] ${sig.symbol} skip — segnale stale (${Math.round(secsToClose)}s alla chiusura)`);
          }
        }
      }
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
      this.logger.warn(`[EMA34] scan failed: ${this.lastError}`);
    } finally {
      this.isScanning = false;
      this.events.emitEma34Status(this.statusPayload());

      if (signals.length > 0 || Object.keys(this.debug).length > 0) {
        this.logger.log(`[EMA34] signals=${signals.length} pairs=${this.top50.length} dbg=${JSON.stringify(this.debug)}`);
      }
    }
  }

  // ── Core: EMA34 retest su un simbolo ─────────────────────────────────────
  // Core V2: EMA34 cross -> first pullback -> breakout on the last closed 1m candle.
  // The filters here are intentionally strict against late entries and "monster" candles.
  private async scanOneV2(symbol: string, cfg: any): Promise<Ema34Signal | null> {
    const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, 180) as number[][];
    if (!ohlcv || ohlcv.length < 80) { this.bump('no_candle'); return null; }

    const candles = ohlcv.slice(0, -1);
    const triggerIndex = candles.length - 1;
    const trigger = candles[triggerIndex];
    const [ts, open, high, low, close, vol] = trigger;
    if (!close || !vol || high <= low) { this.bump('no_close'); return null; }

    const closes = candles.map(c => c[4]);
    const emaAll = this.calcEMA(closes, EMA_PERIOD);
    if (emaAll.length < 30) { this.bump('no_ema'); return null; }

    const emaOffset = closes.length - emaAll.length;
    const emaAt = (idx: number): number | null => {
      const j = idx - emaOffset;
      return j >= 0 && j < emaAll.length ? emaAll[j] : null;
    };

    const atrAt = (idx: number, period = 14): number => {
      if (idx < period) return 0;
      let sum = 0;
      let count = 0;
      for (let i = idx - period + 1; i <= idx; i++) {
        const c = candles[i];
        const p = candles[i - 1];
        if (!c || !p) continue;
        const tr = Math.max(c[2] - c[3], Math.abs(c[2] - p[4]), Math.abs(c[3] - p[4]));
        sum += tr;
        count++;
      }
      return count ? sum / count : 0;
    };

    const ema34Now = emaAt(triggerIndex);
    const ema34_5ago = emaAt(triggerIndex - 5);
    if (!ema34Now || !ema34_5ago) { this.bump('no_ema'); return null; }

    const emaSlope = (ema34Now - ema34_5ago) / ema34Now * 100;
    const minSlope = Number(cfg.minEmaSlope ?? 0.015);
    const triggerAtr = atrAt(triggerIndex) || close * 0.002;
    if (!triggerAtr) { this.bump('no_atr'); return null; }

    const range = high - low;
    const bodySize = Math.abs(close - open);
    const bodyRatio = range > 0 ? bodySize / range : 0;
    const bodyAtr = bodySize / triggerAtr;
    const rangeAtr = range / triggerAtr;
    const closePos = range > 0 ? (close - low) / range : 0.5;
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const upperWickRatio = range > 0 ? upperWick / range : 1;
    const lowerWickRatio = range > 0 ? lowerWick / range : 1;

    const minBody = Number(cfg.minBodyRatio ?? 0.45);
    if (bodyRatio < minBody) { this.bump('trigger_body_weak'); return null; }
    if (bodyAtr < 0.30) { this.bump('trigger_tiny'); return null; }
    if (rangeAtr > 2.35 || bodyAtr > 1.85) { this.bump('monster_candle'); return null; }

    const avgVolCandles = candles.slice(Math.max(0, triggerIndex - 15), triggerIndex);
    const avgVol = avgVolCandles.reduce((s, c) => s + c[5], 0) / Math.max(1, avgVolCandles.length);
    const volRatio = vol / (avgVol || 1);
    if (volRatio < 0.55) { this.bump('vol_dead'); return null; }

    const adxWindow = candles.slice(Math.max(0, triggerIndex - 28), triggerIndex + 1);
    const adx = this.calcADX(adxWindow, 14);

    const chopLookback = Math.min(30, triggerIndex - EMA_PERIOD);
    if (chopLookback >= 18) {
      let sideFlips = 0;
      let lastSide = 0;
      let grossMove = 0;
      let emaDistAtrSum = 0;
      for (let i = triggerIndex - chopLookback + 1; i <= triggerIndex; i++) {
        const e = emaAt(i);
        if (!e) continue;
        const side = closes[i] > e ? 1 : closes[i] < e ? -1 : 0;
        if (side !== 0 && lastSide !== 0 && side !== lastSide) sideFlips++;
        if (side !== 0) lastSide = side;
        grossMove += Math.abs(closes[i] - closes[i - 1]);
        emaDistAtrSum += Math.abs(closes[i] - e) / (atrAt(i) || triggerAtr);
      }
      const netMove = Math.abs(closes[triggerIndex] - closes[triggerIndex - chopLookback]);
      const efficiency = grossMove > 0 ? netMove / grossMove : 0;
      const avgEmaDistAtr = emaDistAtrSum / chopLookback;
      if (sideFlips > 5) { this.bump('ema_chop_flips'); return null; }
      if (sideFlips >= 4 && efficiency < 0.24) { this.bump('ema_chop_eff'); return null; }
      if (efficiency < 0.18 && avgEmaDistAtr < 0.45) { this.bump('ema_sideways'); return null; }
    }

    const maxCrossAgo = Math.max(12, Math.min(30, Number(cfg.maxCrossAgo ?? 20)));
    const maxDelayedCrossAgo = 5;
    const minPullbackBars = 1;
    const maxPullbackBars = 5;
    const maxCrossToPullback = 3;
    const start = Math.max(EMA_PERIOD + 2, triggerIndex - Math.min(maxCrossAgo, maxDelayedCrossAgo));
    const end = triggerIndex - minPullbackBars - 1;

    type Setup = {
      direction: 'LONG' | 'SHORT';
      mode: 'CROSS_REJECTION' | 'PULLBACK_BREAKOUT' | 'TREND_CONTINUATION';
      crossIndex: number;
      pullbackStart: number;
      pullbackEnd: number;
      breakoutLevel: number;
      swingStop: number;
      stopTouches: number;
      scoreBoost: number;
    };

    let best: Setup | null = null;

    const triggerShapeOk = (direction: 'LONG' | 'SHORT'): boolean => {
      const triggerIsDirectional = direction === 'LONG' ? close > open : close < open;
      if (!triggerIsDirectional) { this.bump('trigger_wrong_color'); return false; }

      const closeNearExtreme = direction === 'LONG' ? closePos >= 0.72 : closePos <= 0.28;
      const tpWickSmall = direction === 'LONG' ? upperWickRatio <= 0.22 : lowerWickRatio <= 0.22;
      const slWickNotHuge = direction === 'LONG' ? lowerWickRatio <= 0.33 : upperWickRatio <= 0.33;
      if (!closeNearExtreme || !tpWickSmall || !slWickNotHuge) {
        this.bump('trigger_wick');
        return false;
      }
      return true;
    };

    const isEmaTouch = (idx: number, direction: 'LONG' | 'SHORT'): boolean => {
      const e = emaAt(idx);
      const a = atrAt(idx) || triggerAtr;
      const c = candles[idx];
      if (!e || !c) return false;
      return direction === 'LONG'
        ? c[3] <= e + a * 0.55 && c[3] >= e - a * 0.10
        : c[2] >= e - a * 0.55 && c[2] <= e + a * 0.10;
    };

    const isStopAnchorCandle = (idx: number, direction: 'LONG' | 'SHORT'): boolean => {
      const e = emaAt(idx);
      const a = atrAt(idx) || triggerAtr;
      const c = candles[idx];
      if (!e || !c) return false;
      return direction === 'LONG'
        ? c[3] <= e + a * 0.70 && c[2] >= e - a * 0.18
        : c[2] >= e - a * 0.70 && c[3] <= e + a * 0.18;
    };

    const stopAnchorIndexes = (from: number, to: number, direction: 'LONG' | 'SHORT'): number[] => {
      const candidates: number[] = [];
      for (let i = Math.max(EMA_PERIOD, from); i <= Math.min(to, triggerIndex); i++) {
        if (isStopAnchorCandle(i, direction)) candidates.push(i);
      }
      if (!candidates.length) return [];

      const isSolidAnchor = (idx: number): boolean => {
        const c = candles[idx];
        const r = c[2] - c[3];
        if (r <= 0) return false;
        const b = Math.abs(c[4] - c[1]);
        return b / r >= 0.22 && b / triggerAtr >= 0.12;
      };

      const searchPool = candidates.filter(isSolidAnchor);
      const pool = searchPool.length ? searchPool : candidates;

      let anchor = pool[0];
      for (const i of pool) {
        if (direction === 'LONG' && candles[i][3] < candles[anchor][3]) anchor = i;
        if (direction === 'SHORT' && candles[i][2] > candles[anchor][2]) anchor = i;
      }

      const neighbors = [anchor + 1, anchor - 1]
        .filter(i => i >= from && i <= to && isStopAnchorCandle(i, direction));
      const pair = [anchor, ...(neighbors.length ? [neighbors[0]] : [])]
        .sort((a, b) => a - b);
      return [...new Set(pair)];
    };

    const prevEmaNow = emaAt(triggerIndex - 1);
    if (prevEmaNow) {
      const prevCloseNow = candles[triggerIndex - 1][4];
      const bullCrossNow = prevCloseNow <= prevEmaNow && close > ema34Now;
      const bearCrossNow = prevCloseNow >= prevEmaNow && close < ema34Now;

      if (bullCrossNow || bearCrossNow) {
        const direction: 'LONG' | 'SHORT' = bullCrossNow ? 'LONG' : 'SHORT';
        const slopeOk = direction === 'LONG' ? emaSlope >= minSlope : emaSlope <= -minSlope;
        if (!slopeOk) {
          this.bump('cross_vs_slope');
        } else if (triggerShapeOk(direction)) {
          const touchesEma = direction === 'LONG'
            ? low <= ema34Now + triggerAtr * 0.45 && low >= ema34Now - triggerAtr * 0.10
            : high >= ema34Now - triggerAtr * 0.45 && high <= ema34Now + triggerAtr * 0.10;
          if (!touchesEma) {
            this.bump('cross_no_retest');
          } else {
            const zoneStart = Math.max(EMA_PERIOD, triggerIndex - 3);
            let zoneHigh = -Infinity;
            let zoneLow = Infinity;
            for (let i = zoneStart; i <= triggerIndex; i++) {
              zoneHigh = Math.max(zoneHigh, candles[i][2]);
              zoneLow = Math.min(zoneLow, candles[i][3]);
            }

            const preZone = candles.slice(zoneStart, triggerIndex);
            const preZoneHigh = Math.max(...preZone.map(c => c[2]));
            const preZoneLow = Math.min(...preZone.map(c => c[3]));
            const zoneRangeAtr = (zoneHigh - zoneLow) / triggerAtr;
            const breakoutPad = triggerAtr * 0.02;
            const brokeLocal = direction === 'LONG'
              ? close > preZoneHigh + breakoutPad
              : close < preZoneLow - breakoutPad;
            const entryEmaAtr = Math.abs(close - ema34Now) / triggerAtr;
            const stopIndexes = stopAnchorIndexes(zoneStart, triggerIndex, direction);
            const lastTouchAgo = stopIndexes.length ? triggerIndex - stopIndexes[stopIndexes.length - 1] : Infinity;
            const stopHigh = zoneHigh;
            const stopLow = zoneLow;
            const touchBreakLevel = direction === 'LONG' ? preZoneHigh : preZoneLow;
            const brokeTouch = direction === 'LONG'
              ? close > touchBreakLevel + breakoutPad
              : close < touchBreakLevel - breakoutPad;
            const swingStop = direction === 'LONG' ? stopLow : stopHigh;
            const riskAtr = Math.abs(close - swingStop) / triggerAtr;

            if (zoneRangeAtr > 1.65) {
              this.bump('cross_zone_wide');
            } else if (!brokeLocal) {
              this.bump('cross_no_breakout');
            } else if (!stopIndexes.length) {
              this.bump('no_ema_touch_stop');
            } else if (lastTouchAgo > 1) {
              this.bump('touch_not_fresh');
            } else if (!brokeTouch) {
              this.bump('no_touch_breakout');
            } else if (entryEmaAtr > 1.45) {
              this.bump('cross_entry_far_ema');
            } else if (riskAtr < 0.35) {
              this.bump('risk_tiny');
            } else if (riskAtr > 1.75) {
              this.bump('risk_monster');
            } else {
              best = {
                direction,
                mode: 'CROSS_REJECTION',
                crossIndex: triggerIndex,
                pullbackStart: triggerIndex,
                pullbackEnd: triggerIndex,
                breakoutLevel: direction === 'LONG' ? preZoneHigh : preZoneLow,
                swingStop,
                stopTouches: stopIndexes.length,
                scoreBoost: 24,
              };
            }
          }
        }
      }
    }

    const continuationDirection: 'LONG' | 'SHORT' | null = close > open ? 'LONG' : close < open ? 'SHORT' : null;
    if (continuationDirection && triggerShapeOk(continuationDirection)) {
      const direction = continuationDirection;
      const continuationMinSlope = Math.max(minSlope * 2.2, 0.04);
      const slopeOk = direction === 'LONG'
        ? emaSlope >= continuationMinSlope
        : emaSlope <= -continuationMinSlope;

      if (!slopeOk) {
        this.bump('cont_slope');
      } else {
        const trendLookback = 18;
        let sideOk = 0;
        let sideBad = 0;
        let emaSteps = 0;
        for (let i = triggerIndex - trendLookback; i <= triggerIndex - 1; i++) {
          const e = emaAt(i);
          const prev = emaAt(i - 1);
          if (!e || !prev) continue;
          const correctSide = direction === 'LONG' ? candles[i][4] > e : candles[i][4] < e;
          if (correctSide) sideOk++; else sideBad++;
          if (direction === 'LONG' && e > prev) emaSteps++;
          if (direction === 'SHORT' && e < prev) emaSteps++;
        }

        if (sideOk < 14 || sideBad > 4) {
          this.bump('cont_side');
        } else if (emaSteps < 12) {
          this.bump('cont_ema_steps');
        } else {
          const pullbackStart = Math.max(EMA_PERIOD, triggerIndex - 6);
          const pullbackEnd = triggerIndex - 1;
          let pullbackHigh = -Infinity;
          let pullbackLow = Infinity;
          let wrongClose = 0;
          let counterBars = 0;

          for (let i = pullbackStart; i <= pullbackEnd; i++) {
            const c = candles[i];
            const e = emaAt(i);
            const a = atrAt(i) || triggerAtr;
            if (!e) continue;
            pullbackHigh = Math.max(pullbackHigh, c[2]);
            pullbackLow = Math.min(pullbackLow, c[3]);
            if (direction === 'LONG') {
              if (c[4] < e - a * 0.08) wrongClose++;
              if (c[4] < c[1]) counterBars++;
            } else {
              if (c[4] > e + a * 0.08) wrongClose++;
              if (c[4] > c[1]) counterBars++;
            }
          }

          const touchIndexes = stopAnchorIndexes(pullbackStart, pullbackEnd, direction);
          const lastTouchAgo = touchIndexes.length ? triggerIndex - touchIndexes[touchIndexes.length - 1] : Infinity;
          const pullbackBars = pullbackEnd - pullbackStart + 1;
          const pullbackRangeAtr = (pullbackHigh - pullbackLow) / triggerAtr;
          const breakoutPad = triggerAtr * 0.03;
          const breakoutLevel = direction === 'LONG' ? pullbackHigh : pullbackLow;
          const prevCloseBeforeBreakout = candles[triggerIndex - 1][4];
          const breaksNow = direction === 'LONG'
            ? close > breakoutLevel + breakoutPad && prevCloseBeforeBreakout <= breakoutLevel + breakoutPad
            : close < breakoutLevel - breakoutPad && prevCloseBeforeBreakout >= breakoutLevel - breakoutPad;
          const stopHigh = pullbackHigh;
          const stopLow = pullbackLow;
          const swingStop = direction === 'LONG' ? stopLow : stopHigh;
          const riskAtr = Math.abs(close - swingStop) / triggerAtr;
          const entryEmaAtr = Math.abs(close - ema34Now) / triggerAtr;

          if (!touchIndexes.length) {
            this.bump('cont_no_touch');
          } else if (lastTouchAgo > 2) {
            this.bump('cont_touch_old');
          } else if (wrongClose > 0) {
            this.bump('cont_crossed_ema');
          } else if (counterBars < 1) {
            this.bump('cont_no_pullback');
          } else if (pullbackRangeAtr > 1.55) {
            this.bump('cont_wide');
          } else if (!breaksNow) {
            this.bump('cont_no_break');
          } else if (entryEmaAtr > 1.60) {
            this.bump('cont_late');
          } else if (riskAtr < 0.35) {
            this.bump('risk_tiny');
          } else if (riskAtr > 1.75) {
            this.bump('risk_monster');
          } else {
            const setup: Setup = {
              direction,
              mode: 'TREND_CONTINUATION',
              crossIndex: triggerIndex - trendLookback,
              pullbackStart,
              pullbackEnd,
              breakoutLevel,
              swingStop,
              stopTouches: touchIndexes.length,
              scoreBoost: 22,
            };
            if (!best || setup.scoreBoost > best.scoreBoost) best = setup;
          }
        }
      }
    }

    for (let crossIndex = end; crossIndex >= start; crossIndex--) {
      const prevEma = emaAt(crossIndex - 1);
      const crossEma = emaAt(crossIndex);
      if (!prevEma || !crossEma) continue;

      const prevClose = candles[crossIndex - 1][4];
      const crossClose = candles[crossIndex][4];
      const bullCross = prevClose <= prevEma && crossClose > crossEma;
      const bearCross = prevClose >= prevEma && crossClose < crossEma;
      if (!bullCross && !bearCross) continue;

      const direction: 'LONG' | 'SHORT' = bullCross ? 'LONG' : 'SHORT';
      const crossAgoLocal = triggerIndex - crossIndex;
      if (crossAgoLocal > maxDelayedCrossAgo) { this.bump('late_after_cross'); continue; }
      if (direction === 'LONG' && emaSlope < minSlope) { this.bump('cross_vs_slope'); continue; }
      if (direction === 'SHORT' && emaSlope > -minSlope) { this.bump('cross_vs_slope'); continue; }

      if (!triggerShapeOk(direction)) continue;

      let pullbackStart = -1;
      const pullbackSearchEnd = Math.min(triggerIndex - 2, crossIndex + maxCrossToPullback);
      for (let i = crossIndex + 1; i <= pullbackSearchEnd; i++) {
        const e = emaAt(i);
        const a = atrAt(i) || triggerAtr;
        if (!e) continue;
        const c = candles[i];
        const oppositeColor = direction === 'LONG' ? c[4] < c[1] : c[4] > c[1];
        const retestZone = direction === 'LONG'
          ? c[3] <= e + a * 0.55 && c[3] >= e - a * 0.08
          : c[2] >= e - a * 0.55 && c[2] <= e + a * 0.08;
        if (oppositeColor || retestZone) {
          pullbackStart = i;
          break;
        }
      }
      if (pullbackStart < 0) { this.bump('no_pullback'); continue; }

      const pullbackEnd = triggerIndex - 1;
      const pullbackBars = triggerIndex - pullbackStart;
      if (pullbackBars < minPullbackBars || pullbackBars > maxPullbackBars) {
        this.bump('pullback_len');
        continue;
      }

      let invalidPullback = false;
      let pullbackHigh = -Infinity;
      let pullbackLow = Infinity;
      let againstBars = 0;
      for (let i = pullbackStart; i <= pullbackEnd; i++) {
        const c = candles[i];
        const e = emaAt(i);
        const a = atrAt(i) || triggerAtr;
        if (!e) { invalidPullback = true; break; }

        pullbackHigh = Math.max(pullbackHigh, c[2]);
        pullbackLow = Math.min(pullbackLow, c[3]);
        if (direction === 'LONG' && c[4] < c[1]) againstBars++;
        if (direction === 'SHORT' && c[4] > c[1]) againstBars++;

        const deepWrongSide = direction === 'LONG'
          ? c[4] < e - a * 0.35
          : c[4] > e + a * 0.35;
        const crossesEma = direction === 'LONG'
          ? c[3] < e - a * 0.08
          : c[2] > e + a * 0.08;
        if (crossesEma) { invalidPullback = true; this.bump('pullback_cross_ema'); break; }
        if (deepWrongSide) { invalidPullback = true; break; }
      }
      if (invalidPullback) { this.bump('pullback_broke_ema'); continue; }
      if (againstBars > Math.ceil(pullbackBars * 0.7)) { this.bump('pullback_too_heavy'); continue; }

      const pullbackRangeAtr = (pullbackHigh - pullbackLow) / triggerAtr;
      if (pullbackRangeAtr > 2.35) { this.bump('pullback_wide'); continue; }

      const microStart = Math.max(pullbackStart, triggerIndex - 6);
      let microHigh = -Infinity;
      let microLow = Infinity;
      for (let i = microStart; i <= pullbackEnd; i++) {
        const c = candles[i];
        microHigh = Math.max(microHigh, c[2]);
        microLow = Math.min(microLow, c[3]);
      }
      const microBars = triggerIndex - microStart;
      if (microBars < 2) { this.bump('micro_zone_short'); continue; }

      const microRangeAtr = (microHigh - microLow) / triggerAtr;
      if (microRangeAtr > 1.45) { this.bump('micro_zone_wide'); continue; }

      const breakoutLevel = direction === 'LONG' ? pullbackHigh : pullbackLow;
      const prevCloseBeforeBreakout = candles[triggerIndex - 1][4];
      const breakoutPad = triggerAtr * 0.03;
      const breaksNow = direction === 'LONG'
        ? close > breakoutLevel + breakoutPad && prevCloseBeforeBreakout <= breakoutLevel + breakoutPad
        : close < breakoutLevel - breakoutPad && prevCloseBeforeBreakout >= breakoutLevel - breakoutPad;
      if (!breaksNow) { this.bump('no_breakout'); continue; }

      const breakoutCloseAtr = Math.abs(close - breakoutLevel) / triggerAtr;
      if (breakoutCloseAtr > 1.35) { this.bump('late_breakout'); continue; }

      const entryEmaAtr = Math.abs(close - ema34Now) / triggerAtr;
      if (entryEmaAtr > 1.8) { this.bump('entry_far_ema'); continue; }

      const stopIndexes = stopAnchorIndexes(pullbackStart, pullbackEnd, direction);
      if (!stopIndexes.length) { this.bump('no_ema_touch_stop'); continue; }
      const lastTouchAgo = triggerIndex - stopIndexes[stopIndexes.length - 1];
      if (lastTouchAgo > maxPullbackBars) { this.bump('touch_not_fresh'); continue; }

      const stopHigh = pullbackHigh;
      const stopLow = pullbackLow;
      const touchBreakLevel = direction === 'LONG' ? stopHigh : stopLow;
      const brokeTouch = direction === 'LONG'
        ? close > touchBreakLevel + breakoutPad
        : close < touchBreakLevel - breakoutPad;
      if (!brokeTouch) { this.bump('no_touch_breakout'); continue; }

      const swingStop = direction === 'LONG' ? stopLow : stopHigh;
      const riskAtr = Math.abs(close - swingStop) / triggerAtr;
      if (riskAtr < 0.35) { this.bump('risk_tiny'); continue; }
      if (riskAtr > 1.75) { this.bump('risk_monster'); continue; }

      const pullbackQuality = pullbackBars <= 6 ? 8 : 4;
      const breakoutQuality = Math.max(0, 8 - breakoutCloseAtr * 3);
      const setup: Setup = {
        direction,
        mode: 'PULLBACK_BREAKOUT',
        crossIndex,
        pullbackStart,
        pullbackEnd,
        breakoutLevel,
        swingStop,
        stopTouches: stopIndexes.length,
        scoreBoost: pullbackQuality + breakoutQuality,
      };

      if (!best || setup.scoreBoost > best.scoreBoost) best = setup;
    }

    if (!best) return null;

    const direction = best.direction;
    const slPrice = best.swingStop;
    const slPct = Math.abs(close - slPrice) / close * 100;
    const minEffectiveSlPct = Math.max(Number(cfg.minSlPct ?? 0.05), 0.20);
    if (slPct < minEffectiveSlPct) { this.bump('sl_small'); return null; }
    if (slPct > Number(cfg.maxSlPct ?? 1.50)) { this.bump('sl_big'); return null; }

    const riskUsdt = Number(cfg.riskUsdt ?? 1);
    const feeRate = FEE;
    const slMove = slPct / 100;
    const roundTripFee = feeRate * 2;
    const netRiskMove = slMove + roundTripFee;
    const positionSize = riskUsdt / netRiskMove;
    const tpRr = Number(cfg.tpRr ?? 3.0);
    const tpMove = (tpRr * netRiskMove) + roundTripFee;
    const tpPrice = direction === 'LONG'
      ? close * (1 + tpMove)
      : close * (1 - tpMove);
    const tpPct = Math.abs(close - tpPrice) / close * 100;
    const maxLev = Number(this.markets[symbol]?.limits?.leverage?.max ?? 125) || 125;
    const leverage = Math.max(1, Math.min(Math.ceil(positionSize / 5), maxLev, 125));
    const margin = positionSize / leverage;

    if ((cfg.cooldownMinutes ?? 5) > 0) {
      const since = new Date(Date.now() - cfg.cooldownMinutes * 60_000);
      const recent = await this.prisma.ema34SimulatedTrade.findFirst({
        where: { symbol, direction, openedAt: { gte: since } },
      });
      if (recent) { this.bump('cooldown'); return null; }
    }

    let consistentSteps = 0;
    for (let i = triggerIndex - 4; i <= triggerIndex; i++) {
      const a = emaAt(i - 1);
      const b = emaAt(i);
      if (!a || !b) continue;
      if (direction === 'LONG' && b > a) consistentSteps++;
      if (direction === 'SHORT' && b < a) consistentSteps++;
    }
    if (consistentSteps < 3) { this.bump('slope_inconsistent'); return null; }

    const crossAgo = triggerIndex - best.crossIndex;
    const slopeScore = Math.min(18, Math.abs(emaSlope) / 0.08 * 18);
    const crossScore = Math.max(0, (maxCrossAgo - crossAgo) / maxCrossAgo * 10);
    const bodyScore = Math.min(18, bodyRatio / 0.75 * 18);
    const wickScore = direction === 'LONG'
      ? (upperWickRatio <= 0.12 ? 10 : 6)
      : (lowerWickRatio <= 0.12 ? 10 : 6);
    const breakoutScore = Math.min(18, Math.max(0, (1.35 - Math.abs(close - best.breakoutLevel) / triggerAtr) / 1.35 * 18));
    const pullbackScore = best.mode === 'CROSS_REJECTION'
      ? 16
      : best.mode === 'TREND_CONTINUATION'
        ? 16
      : best.pullbackEnd - best.pullbackStart <= 4 ? 14 : 10;
    const volScore = Math.min(7, Math.max(0, (volRatio - 0.8) / 1.2 * 7));
    const adxScore = adx >= 25 ? 5 : adx >= 18 ? 3 : 0;
    const score = Math.round(slopeScore + crossScore + bodyScore + wickScore + breakoutScore + pullbackScore + volScore + adxScore);
    if (score < Number(cfg.minScore ?? 45)) { this.bump('score'); return null; }

    const grade: Grade = score >= 80 ? 'A+' : score >= 60 ? 'A' : 'B';
    this.bump('ok');

    const px = (p: number) => {
      try { return parseFloat(this.exchange.priceToPrecision(symbol, p)); } catch { return p; }
    };

    const deltaRatio = direction === 'LONG' ? bodyRatio : -bodyRatio;
    const tpWickPct = direction === 'LONG' ? upperWickRatio * 100 : lowerWickRatio * 100;
    const riskAtr = Math.abs(close - slPrice) / triggerAtr;
    const reasons: string[] = [
      `Cross EMA34 ${direction} ${crossAgo} candele fa`,
      best.mode === 'CROSS_REJECTION'
        ? `Cross rejection con chiusura forte lato ${direction}`
        : best.mode === 'TREND_CONTINUATION'
          ? `Continuation trend EMA34 con pullback fresco`
        : `Primo pullback ${best.pullbackEnd - best.pullbackStart + 1} candele`,
      best.mode === 'CROSS_REJECTION'
        ? `Rottura micro-zona sul cross ${best.breakoutLevel.toFixed(6)}`
        : best.mode === 'TREND_CONTINUATION'
          ? `Break continuation ${direction === 'LONG' ? 'sopra' : 'sotto'} ${best.breakoutLevel.toFixed(6)}`
        : `Breakout ${direction === 'LONG' ? 'sopra' : 'sotto'} ${best.breakoutLevel.toFixed(6)}`,
      `EMA34=${ema34Now.toFixed(6)} slope ${emaSlope >= 0 ? '+' : ''}${emaSlope.toFixed(3)}%`,
      `Body ${(bodyRatio * 100).toFixed(0)}% wick TP ${tpWickPct.toFixed(0)}%`,
      `Risk ${riskAtr.toFixed(2)} ATR, SL ${best.stopTouches} touch EMA ${slPct.toFixed(2)}%`,
      `Vol ${volRatio.toFixed(2)}x, ADX ${adx.toFixed(1)}`,
    ];

    return {
      id: `${SOURCE}_${symbol}_${ts}`,
      symbol,
      direction,
      entry: px(close),
      stopLoss: px(slPrice),
      takeProfit: px(tpPrice),
      slPct: parseFloat(slPct.toFixed(4)),
      tpPct: parseFloat(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt: parseFloat(riskUsdt.toFixed(2)),
      positionSize: parseFloat(positionSize.toFixed(4)),
      marginUsdt: parseFloat(margin.toFixed(4)),
      score,
      grade,
      ema34: parseFloat(ema34Now.toFixed(6)),
      emaSlope: parseFloat(emaSlope.toFixed(4)),
      crossAgo,
      volumeRatio: parseFloat(volRatio.toFixed(3)),
      deltaRatio: parseFloat(deltaRatio.toFixed(3)),
      feeRate,
      reasons,
      timestamp: new Date(ts + 60_000).toISOString(),
    };
  }

  private async scanOne(symbol: string, cfg: any): Promise<Ema34Signal | null> {
    // CPB — Cross + Primo Pullback + Breakout su EMA34 1m
    // Sequenza: EMA cross → prezzo sfiorare/buca EMA → rientra → prima forte → ENTRY (seconda forte)
    const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, 120) as number[][];
    if (!ohlcv || ohlcv.length < 60) { this.bump('no_candle'); return null; }

    const last = ohlcv.length - 1;
    // Trigger = ultima candela chiusa = "seconda forte" = ENTRY
    const trigger = ohlcv[last - 1];
    const [ts, open, high, low, close, vol] = trigger;
    if (!close || !vol || high <= low) { this.bump('no_close'); return null; }

    // EMA34 su tutte le chiusure tranne la candle in formazione
    const closes = ohlcv.slice(0, last).map(c => c[4]);
    const emaAll = this.calcEMA(closes, EMA_PERIOD);
    if (emaAll.length < 20) { this.bump('no_ema'); return null; }

    // Helper: EMA al k-esimo passo prima del trigger (k=0 = trigger, k=1 = candle prima, ecc.)
    const emaAt = (k: number): number | null => {
      const j = emaAll.length - 1 - k;
      return j >= 0 ? emaAll[j] : null;
    };
    const candleAt = (k: number): number[] | null => {
      const idx = last - 1 - k;
      return idx >= 0 && idx < ohlcv.length ? ohlcv[idx] : null;
    };

    const ema34Now   = emaAt(0)!;
    const ema34_5ago = emaAt(5);
    if (!ema34_5ago) { this.bump('no_ema'); return null; }

    const emaSlope = (ema34Now - ema34_5ago) / ema34Now * 100;
    const minSlope = cfg.minEmaSlope ?? 0.015;
    if (Math.abs(emaSlope) < minSlope) { this.bump('ema_flat'); return null; }

    const isBullishSlope = emaSlope > 0;
    const isBearishSlope = emaSlope < 0;
    const direction: 'LONG' | 'SHORT' = isBullishSlope ? 'LONG' : 'SHORT';

    // ── Anti-chop: EMA34 deve muoversi nella stessa direzione per N step (max 2 eccezioni) ──
    const consistN = cfg.emaSlopeConsistencyN ?? 5;
    if (emaAll.length >= consistN + 1) {
      let violations = 0;
      for (let k = 1; k <= consistN; k++) {
        const prev = emaAt(k);
        const curr = emaAt(k - 1);
        if (!prev || !curr) { violations++; continue; }
        if (isBullishSlope && curr <= prev) violations++;
        if (isBearishSlope && curr >= prev) violations++;
      }
      if (violations > 2) { this.bump('slope_decelerating'); return null; }
    }

    // ── ADX ──
    const adxWindow = ohlcv.slice(Math.max(0, last - 22), last);
    const adx = this.calcADX(adxWindow, 14);
    if (adx < (cfg.minAdx ?? 20)) { this.bump('adx_weak'); return null; }

    // ── Trigger = seconda forte: corpo solido nella direzione del trend ──
    const range    = high - low;
    const bodySize = Math.abs(close - open);
    const bodyRatio = range > 0 ? bodySize / range : 0;
    const minBody   = cfg.minBodyRatio ?? 0.45;
    const isBullish = close > open;
    const isBearish = close < open;

    if (direction === 'LONG'  && (!isBullish || bodyRatio < minBody)) { this.bump('trigger_weak'); return null; }
    if (direction === 'SHORT' && (!isBearish || bodyRatio < minBody)) { this.bump('trigger_weak'); return null; }
    if (direction === 'LONG'  && close <= ema34Now) { this.bump('trigger_below_ema'); return null; }
    if (direction === 'SHORT' && close >= ema34Now) { this.bump('trigger_above_ema'); return null; }

    // Cross rimosso — direzione garantita da emaSlope + consistencyN
    const maxCrossAgo = cfg.maxCrossAgo ?? 50;
    const crossAgo = 0;

    // ── Rientro detection ─────────────────────────────────────────────────────
    // Pattern: ROSSA (corpo contro-direzione) → VERDE rientra (prima forte) → VERDE GRANDE (entry)
    //
    // CASO 1 — Sfiorare (wick tocca EMA, close resta sul lato corretto):
    //   Candle k:  wick tocca EMA  +  corpo CONTRO direzione (rossa per LONG)  → rientroK = k
    //
    // CASO 2 — Bucare e rientrare (close sbagliata + candle successiva torna):
    //   Candle k:   close < EMA (LONG)  +  corpo CONTRO direzione               → buco
    //   Candle k-1: close > EMA (LONG) → rientra                                → rientroK = k-1
    //
    // In entrambi i casi corpo E wick lato opposto (verso EMA) della rossa e della verde
    // (prima forte k=1) devono essere "quasi uguali".
    let rientroK    = -1;
    let bucoCandleK = -1;   // k della candela con corpo CONTRO direzione (la "rossa")
    let pullbackLow  = Infinity;
    let pullbackHigh = -Infinity;

    for (let k = 2; k <= 10; k++) {
      const c     = candleAt(k);
      const e     = emaAt(k);
      const cPrev = candleAt(k - 1);
      const ePrev = emaAt(k - 1);
      if (!c || !e) continue;

      pullbackLow  = Math.min(pullbackLow,  c[3]);
      pullbackHigh = Math.max(pullbackHigh, c[2]);

      // La candela deve avere corpo contro-direzione (rossa per LONG, verde per SHORT)
      const hasOppBody = direction === 'LONG' ? c[4] < c[1] : c[4] > c[1];
      if (!hasOppBody) continue;

      // CASO 1: sfiorare — wick tocca EMA, close rimane sul lato corretto
      const sfiorare = direction === 'LONG'
        ? c[3] <= e * 1.003 && c[4] >= e * 0.998
        : c[2] >= e * 0.997 && c[4] <= e * 1.002;
      if (sfiorare) { rientroK = k; bucoCandleK = k; break; }

      // CASO 2: bucare e rientrare — close sbagliata, candle successiva chiude sul lato corretto
      const buco    = direction === 'LONG' ? c[4] < e : c[4] > e;
      const rientra = cPrev && ePrev && (direction === 'LONG' ? cPrev[4] > ePrev : cPrev[4] < ePrev);
      if (buco && rientra) {
        pullbackLow  = Math.min(pullbackLow,  c[3]);
        pullbackHigh = Math.max(pullbackHigh, c[2]);
        rientroK = k - 1; bucoCandleK = k; break;
      }
    }

    if (rientroK < 0) { this.bump('no_rientro'); return null; }
    if (rientroK < 1) { this.bump('rientro_too_close'); return null; }

    // ── Prima forte: cerca tra k=1 e k=4 la candela nella direzione giusta più vicina al trigger ──
    let primaForte: number[] | null = null;
    let primaForteK = -1;
    for (let pk = 1; pk <= 4; pk++) {
      const c = candleAt(pk);
      const e = emaAt(pk);
      if (!c || !e) continue;
      const onSide  = direction === 'LONG' ? c[4] > e    : c[4] < e;
      const correct = direction === 'LONG' ? c[4] > c[1] : c[4] < c[1];
      const cRange  = c[2] - c[3];
      const cBody   = Math.abs(c[4] - c[1]);
      const cBodyR  = cRange > 0 ? cBody / cRange : 0;
      if (onSide && correct && cBodyR >= 0.35) {
        primaForte = c; primaForteK = pk; break;
      }
    }
    if (!primaForte) { this.bump('no_prima_forte'); return null; }
    const primaRange     = primaForte[2] - primaForte[3];
    const primaBody      = Math.abs(primaForte[4] - primaForte[1]);

    // ── ATR14 semplice per misurare distanze in termini di volatilità ──────────
    let atr14 = 0; let atrN = 0;
    for (let i = Math.max(1, last - 15); i <= last - 1; i++) {
      const h = ohlcv[i][2], lo = ohlcv[i][3], pc = ohlcv[i - 1][4];
      atr14 += Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc));
      atrN++;
    }
    atr14 = atrN > 0 ? atr14 / atrN : close * 0.002;

    // ── Pattern "quasi uguale": rossa e verde1 devono toccare lo stesso livello ──
    // LONG: rossa ha corpo verso il basso + low ≈ low della verde1 → doppio test supporto EMA
    // SHORT: verde ha corpo verso l'alto + high ≈ high della rossa → doppio test resistenza EMA
    const bucoC = candleAt(bucoCandleK);
    if (!bucoC) { this.bump('rientro_not_equal'); return null; }

    // Rossa deve essere "media": corpo visibile (non micro)
    const bucoRange = bucoC[2] - bucoC[3];
    const bucoBody  = Math.abs(bucoC[4] - bucoC[1]);
    const bucoBodyRatio = bucoRange > 0 ? bucoBody / bucoRange : 0;
    if (bucoBodyRatio < 0.30) { this.bump('rossa_too_small'); return null; }

    // Le tre candele (rossa, verde1, trigger) devono avere corpo simile — nessuna micro né gigante rispetto alle altre
    if (bodySize > 0 && primaBody > 0) {
      const bucoVsTrigger  = bucoBody  / bodySize;
      const primaVsTrigger = primaBody / bodySize;
      const bucoVsPrima    = bucoBody  / primaBody;
      if (bucoVsTrigger  < 0.35 || bucoVsTrigger  > 2.5) { this.bump('buco_size_mismatch');  return null; }
      if (primaVsTrigger < 0.35 || primaVsTrigger > 2.5) { this.bump('prima_size_mismatch'); return null; }
      if (bucoVsPrima    < 0.35 || bucoVsPrima    > 2.5) { this.bump('rientro_body_not_equal'); return null; }
    }

    // ── Zona EMA: entrambe le candele vicino all'EMA (stesso range, non stesso pixel) ──
    const bucoExtreme  = direction === 'LONG' ? bucoC[3]      : bucoC[2];
    const primaExtreme = direction === 'LONG' ? primaForte[3] : primaForte[2];
    const extremeDiff  = Math.abs(bucoExtreme - primaExtreme) / atr14;
    if (extremeDiff > 1.2) { this.bump('extreme_not_equal'); return null; }

    // Wick lato opposto quasi uguale (solo se entrambi hanno wick misurabile)
    const bucoOppWick = direction === 'LONG'
      ? Math.min(bucoC[1], bucoC[4]) - bucoC[3]
      : bucoC[2] - Math.max(bucoC[1], bucoC[4]);
    const primaOppWick = direction === 'LONG'
      ? Math.min(primaForte[1], primaForte[4]) - primaForte[3]
      : primaForte[2] - Math.max(primaForte[1], primaForte[4]);
    if (bucoOppWick > atr14 * 0.10 && primaOppWick > atr14 * 0.10) {
      const wickRatio = bucoOppWick / primaOppWick;
      if (wickRatio < 0.20 || wickRatio > 4.0) {
        this.bump('rientro_wick_not_equal'); return null;
      }
    }

    if (pullbackLow  === Infinity)  pullbackLow  = low;
    if (pullbackHigh === -Infinity) pullbackHigh = high;

    // ── Volume ──
    const avgVolCandles = ohlcv.slice(Math.max(0, last - 16), last - 1);
    const avgVol = avgVolCandles.reduce((s, c) => s + c[5], 0) / Math.max(1, avgVolCandles.length) || 1;
    const volRatio = vol / avgVol;
    if (volRatio < (cfg.minVolumeRatio ?? 1.0)) { this.bump('vol_weak'); return null; }

    // ── SL = punto di revert: HIGH/LOW della candela trigger ──────────────────
    // Se il prezzo torna oltre il HIGH (SHORT) o LOW (LONG) del trigger, la candela è ribaltata
    const slPrice = direction === 'LONG'
      ? low  * (1 - 0.0003)
      : high * (1 + 0.0003);

    const slPct = Math.abs(close - slPrice) / close * 100;
    if (slPct < (cfg.minSlPct ?? 0.05)) { this.bump('sl_small'); return null; }
    if (slPct > (cfg.maxSlPct ?? 1.50)) { this.bump('sl_big');   return null; }

    // ── TP ──
    const tpRr = cfg.tpRr ?? 2.0;
    const tpPrice = direction === 'LONG'
      ? close * (1 + ((tpRr * ((slPct / 100) + FEE * 2)) + FEE * 2))
      : close * (1 - ((tpRr * ((slPct / 100) + FEE * 2)) + FEE * 2));
    const tpPct = Math.abs(close - tpPrice) / close * 100;

    // ── Sizing ──
    const riskUsdt    = Number(cfg.riskUsdt ?? 1);
    const netRiskMove = (slPct / 100) + FEE * 2;
    const positionSize = riskUsdt / netRiskMove;
    const maxLev       = Number(this.markets[symbol]?.limits?.leverage?.max ?? 125) || 125;
    const leverage     = Math.max(1, Math.min(Math.ceil(positionSize / 5), maxLev, 125));
    const margin       = positionSize / leverage;

    // ── Cooldown ──
    if ((cfg.cooldownMinutes ?? 5) > 0) {
      const since = new Date(Date.now() - cfg.cooldownMinutes * 60_000);
      const recent = await this.prisma.ema34SimulatedTrade.findFirst({
        where: { symbol, direction, openedAt: { gte: since } },
      });
      if (recent) { this.bump('cooldown'); return null; }
    }

    // ── Score ──
    const slopeScore  = Math.min(35, Math.abs(emaSlope) / 0.15 * 35);
    const crossScore  = Math.max(0, Math.round((maxCrossAgo - crossAgo) / maxCrossAgo * 20));
    const bodyScore   = Math.min(25, bodyRatio / 0.8 * 25);
    const volScore    = Math.min(10, Math.max(0, (volRatio - 1) / 1.5 * 10));
    const adxScore    = adx >= 25 ? 5 : adx >= 20 ? 2 : 0;
    const rientroScore = rientroK <= 3 ? 8 : 4;

    const score = Math.round(slopeScore + crossScore + bodyScore + volScore + adxScore + rientroScore);
    if (score < (cfg.minScore ?? 45)) { this.bump('score'); return null; }

    const grade: Grade = score >= 80 ? 'A+' : score >= 60 ? 'A' : 'B';
    this.bump('ok');

    const px = (p: number) => {
      try { return parseFloat(this.exchange.priceToPrecision(symbol, p)); } catch { return p; }
    };

    const deltaEstimate = isBullish ? bodyRatio * 2 - 1 : -(bodyRatio * 2 - 1);
    const reasons: string[] = [
      `EMA34=${ema34Now.toFixed(4)} slope ${emaSlope >= 0 ? '+' : ''}${emaSlope.toFixed(3)}%`,
      `Cross ${direction} ${crossAgo}c fa`,
      `Rientro ${rientroK}c fa — ${direction === 'LONG' ? `pullbackLow ${pullbackLow.toFixed(4)}` : `pullbackHigh ${pullbackHigh.toFixed(4)}`}`,
      `Body ${(bodyRatio * 100).toFixed(0)}% · ADX ${adx.toFixed(1)}`,
      `Vol ${volRatio.toFixed(2)}x`,
      `SL ${slPct.toFixed(2)}%`,
    ];

    return {
      id:                `${SOURCE}_${symbol}_${ts}`,
      symbol,
      direction,
      entry:             px(close),
      stopLoss:          px(slPrice),
      takeProfit:        px(tpPrice),
      slPct:             parseFloat(slPct.toFixed(4)),
      tpPct:             parseFloat(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt:          parseFloat(riskUsdt.toFixed(2)),
      positionSize:      parseFloat(positionSize.toFixed(4)),
      marginUsdt:        parseFloat(margin.toFixed(4)),
      score,
      grade,
      ema34:             parseFloat(ema34Now.toFixed(6)),
      emaSlope:          parseFloat(emaSlope.toFixed(4)),
      crossAgo,
      volumeRatio:       parseFloat(volRatio.toFixed(3)),
      deltaRatio:        parseFloat(deltaEstimate.toFixed(3)),
      feeRate:           FEE,
      reasons,
      timestamp:         new Date(ts + 60_000).toISOString(),
    };
  }

  // ── EMA calculation ───────────────────────────────────────────────────────
  private calcEMA(closes: number[], period: number): number[] {
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];

    // SMA per i primi 'period' valori
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    result.push(sum / period);

    // EMA per il resto
    for (let i = period; i < closes.length; i++) {
      result.push(closes[i] * k + result[result.length - 1] * (1 - k));
    }
    return result;
  }

  // ── ADX (Average Directional Index) — misura la FORZA del trend ─────────
  // ADX < 20 = ranging/chop (evita), ADX > 25 = trend, ADX > 40 = trend forte
  private calcADX(candles: number[][], period = 14): number {
    if (candles.length < period + 2) return 0;

    const trs: number[] = [];
    const plusDMs: number[] = [];
    const minusDMs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const [, , h, l] = candles[i];
      const [, , ph, pl, pc] = candles[i - 1];
      const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      const upMove   = h - ph;
      const downMove = pl - l;
      const plusDM   = (upMove > downMove && upMove > 0) ? upMove : 0;
      const minusDM  = (downMove > upMove && downMove > 0) ? downMove : 0;
      trs.push(tr);
      plusDMs.push(plusDM);
      minusDMs.push(minusDM);
    }

    // Wilder smoothing (RMA)
    const smooth = (arr: number[]) => {
      let val = arr.slice(0, period).reduce((a, b) => a + b, 0);
      for (let i = period; i < arr.length; i++) val = val - val / period + arr[i];
      return val;
    };

    const aTR    = smooth(trs);
    const sPlusDM  = smooth(plusDMs);
    const sMinusDM = smooth(minusDMs);

    if (!aTR) return 0;
    const plusDI  = (sPlusDM  / aTR) * 100;
    const minusDI = (sMinusDM / aTR) * 100;
    const diSum   = plusDI + minusDI;
    if (!diSum) return 0;
    const dx = Math.abs(plusDI - minusDI) / diSum * 100;

    // ADX = media del DX (semplificazione: usiamo il valore corrente come proxy)
    return parseFloat(dx.toFixed(1));
  }

  // ── Trade simulati con trailing server-side ───────────────────────────────
  private async enterSimTrade(sig: Ema34Signal, cfg: any) {
    const already = await this.prisma.ema34SimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open' },
    });
    if (already) return;

    const capital = await this.currentCapital(cfg);
    await this.prisma.ema34SimulatedTrade.create({
      data: {
        id:             sig.id,
        symbol:         sig.symbol,
        direction:      sig.direction,
        entry:          sig.entry,
        stopLoss:       sig.stopLoss,
        takeProfit:     sig.takeProfit,
        slPct:          sig.slPct,
        tpPct:          sig.tpPct,
        leverage:       sig.suggestedLeverage,
        riskUsdt:       sig.riskUsdt,
        positionSize:   sig.positionSize,
        marginUsdt:     sig.marginUsdt,
        score:          sig.score,
        grade:          sig.grade,
        ema34:          sig.ema34,
        emaSlope:       sig.emaSlope,
        crossAgo:       sig.crossAgo,
        volumeRatio:    sig.volumeRatio,
        deltaRatio:     sig.deltaRatio,
        feeRate:        sig.feeRate,
        fees:           sig.positionSize * sig.feeRate,
        trailingSlPrice: sig.stopLoss,   // parte dall'SL originale
        capitalBefore:  capital,
        status:         'open',
      },
    });
  }

  // Controlla trade ogni secondo — 1 sola fetchTickers() per tutti i simboli aperti
  @Cron('* * * * * *')
  async checkSimTrades() {
    const open = await this.prisma.ema34SimulatedTrade.findMany({ where: { status: 'open' } });
    if (!open.length) return;

    const symbols = [...new Set(open.map(t => t.symbol))];
    let tickers: Record<string, any> = {};
    try {
      const result = await this.exchange.fetchTickers(symbols);
      tickers = result as Record<string, any>;
    } catch { return; }

    for (const trade of open) {
      const ticker = tickers[trade.symbol];
      if (!ticker) continue;
      const last = Number(ticker.last ?? 0);
      if (!last) continue;

      const isLong   = trade.direction === 'LONG';
      const slPrice  = Number(trade.stopLoss);
      const tpPrice  = trade.takeProfit;
      const entry    = trade.entry;
      const slPct    = Number(trade.slPct);
      const posSize  = trade.positionSize;

      // SL check: bid per LONG (si esce vendendo al bid), ask per SHORT (si esce comprando all'ask)
      // Usa il prezzo peggiore per non perdere i wick
      const bid = Number(ticker.bid ?? last);
      const ask = Number(ticker.ask ?? last);
      const slCheckPrice = isLong ? bid : ask;
      const tpCheckPrice = isLong ? ask : bid;

      const slHit = isLong ? slCheckPrice <= slPrice : slCheckPrice >= slPrice;
      const tpHit = isLong ? tpCheckPrice >= tpPrice : tpCheckPrice <= tpPrice;
      const price  = last;

      if (slHit) {
        await this.closeSimTrade(trade, slPrice, 'sl');
        continue;
      }
      if (tpHit) {
        await this.closeSimTrade(trade, tpPrice, 'tp');
        continue;
      }

      // Emit posizione corrente (SL/TP fissi, no trailing)
      const priceDiff = isLong
        ? (price - entry) / entry * 100
        : (entry - price) / entry * 100;
      const currentR = slPct > 0 ? priceDiff / slPct : 0;

      this.events.emitEma34Positions([{
        id:               trade.id,
        currentPrice:     price,
        currentR:         parseFloat(currentR.toFixed(2)),
        trailingSl:       parseFloat(slPrice.toFixed(8)),
        unrealizedPnl:    parseFloat((posSize * (priceDiff / 100) - (trade.fees ?? 0)).toFixed(4)),
        unrealizedPnlPct: parseFloat((priceDiff).toFixed(2)),
      }]);
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

    const updated = await this.prisma.ema34SimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status, closePrice,
        pnl:          parseFloat(pnl.toFixed(4)),
        fees:         parseFloat(totalFees.toFixed(6)),
        capitalAfter: parseFloat(((trade.capitalBefore ?? 0) + pnl).toFixed(4)),
        closedAt:     new Date(),
      },
    });
    this.events.emitEma34Trade(updated);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private bump(k: string) { this.debug[k] = (this.debug[k] ?? 0) + 1; }

  private async openSimCount() {
    return this.prisma.ema34SimulatedTrade.count({ where: { status: 'open' } });
  }

  private async currentCapital(cfg: any): Promise<number> {
    const last = await this.prisma.ema34SimulatedTrade.findFirst({
      where: { capitalAfter: { not: null } }, orderBy: { openedAt: 'desc' },
    });
    return last?.capitalAfter ?? cfg.startingCapital;
  }

  private async ensureConfig() {
    const c = await this.prisma.ema34Config.findUnique({ where: { id: 1 } });
    if (c) return c;
    return this.prisma.ema34Config.create({ data: { id: 1 } });
  }

  private statusPayload() {
    return {
      isScanning:     this.isScanning,
      lastScanAt:     this.lastScanAt,
      lastError:      this.lastError,
      lastRawSignals: this.lastRawSignals,
      lastEmitted:    this.lastEmitted,
      symbols:        this.top50.length,
      top50Sample:    this.top50.slice(0, 6).map(s => s.replace('/USDT:USDT', '')),
      debug:          this.debug,
    };
  }

  // ── API pubblica ──────────────────────────────────────────────────────────
  async getAnalytics() {
    const cfg    = await this.ensureConfig();
    const trades = await this.prisma.ema34SimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
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
      top50:            this.top50,
      openTradesList:   open,
      closedTradesList: closed.slice(0, 100),
    };
  }

  getSignals(limit = 100) { return this.lastSignals.slice(0, limit); }
  getStatus()             { return this.statusPayload(); }

  async getCandles(symbol: string, limit = 120, from?: number, live = false) {
    try {
      const since = Number.isFinite(from) && from && from > 0 ? from : undefined;
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, since, limit + 1) as number[][];
      // Calcola EMA34 e ritorna anche i valori per il grafico
      const candles = live ? ohlcv : ohlcv.slice(0, -1);
      const closes  = candles.map(c => c[4]);
      const emaVals = this.calcEMA(closes, EMA_PERIOD);
      const offset  = closes.length - emaVals.length;  // primi 'offset' candles non hanno EMA
      return candles.map((c, i) => ({
        time:  Math.floor(c[0] / 1000),
        open:  c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
        ema34: i >= offset ? parseFloat(emaVals[i - offset].toFixed(8)) : null,
      }));
    } catch {
      return [];
    }
  }

  async getTrades(limit = 200) {
    return this.prisma.ema34SimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' }, take: limit,
    });
  }

  async updateConfig(data: any) {
    const allowed = [
      'startingCapital', 'riskUsdt', 'tpRr', 'leverage', 'maxConcurrent',
      'enabled', 'autoEnter', 'minScore',
      'minEmaSlope', 'emaSlopeConsistencyN', 'minAdx', 'minCrossAgo', 'maxCrossAgo', 'proxPct', 'minBodyRatio',
      'minVolumeRatio', 'minSlPct', 'maxSlPct', 'cooldownMinutes', 'liveEnabled',
    ];
    const patch: any = {};
    for (const k of allowed) { if (data[k] !== undefined) patch[k] = data[k]; }
    return this.prisma.ema34Config.update({ where: { id: 1 }, data: patch });
  }

  async resetSim() {
    await this.prisma.ema34SimulatedTrade.deleteMany({});
  }
}
