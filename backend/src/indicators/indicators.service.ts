import { Injectable } from '@nestjs/common';
import { OHLCV } from '../mexc/mexc.service';

export interface IndicatorResult {
  rsi: number;
  ema9: number;
  ema21: number;
  prevEma9: number;
  prevEma21: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  prevMacdHistogram: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  bbBandwidth: number;
  volume: number;
  volumeRatio: number;
  close: number;
  prevClose: number;
}

@Injectable()
export class IndicatorsService {
  // ─── RSI (Wilder) ─────────────────────────────────────────────────────────

  rsi(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    const deltas = closes.slice(1).map((c, i) => c - closes[i]);
    const gains  = deltas.map((d) => Math.max(d, 0));
    const losses = deltas.map((d) => Math.max(-d, 0));
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < deltas.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  // Incremental RSI array — O(n), returns one value per bar starting at bar `period`
  rsiArray(closes: number[], period = 14): number[] {
    if (closes.length < period + 1) return closes.map(() => 50);
    const deltas = closes.slice(1).map((c, i) => c - closes[i]);
    const gains  = deltas.map((d) => Math.max(d, 0));
    const losses = deltas.map((d) => Math.max(-d, 0));
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    const result: number[] = [];
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    for (let i = period; i < deltas.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
    return result;
  }

  // ─── EMA ──────────────────────────────────────────────────────────────────

  emaArray(values: number[], period: number): number[] {
    if (values.length < period) return values.map(() => values[0]);
    const k = 2 / (period + 1);
    const result: number[] = [];
    const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result.push(seed);
    for (let i = period; i < values.length; i++) {
      result.push(values[i] * k + result[result.length - 1] * (1 - k));
    }
    return result;
  }

  ema(values: number[], period: number): number {
    return this.emaArray(values, period).at(-1)!;
  }

  // ─── SMA ──────────────────────────────────────────────────────────────────

  smaArray(values: number[], period: number): number[] {
    if (values.length < period) {
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      return values.map(() => avg);
    }
    const result: number[] = [];
    for (let i = period - 1; i < values.length; i++) {
      result.push(values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    }
    return result;
  }

  sma(values: number[], period: number): number {
    return this.smaArray(values, period).at(-1)!;
  }

  // ─── MACD (configurable — default standard, also supports 34/144/9) ───────

  macd(
    closes: number[],
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9,
  ): { macd: number; signal: number; histogram: number; prevHistogram: number } {
    const emaFastArr = this.emaArray(closes, fastPeriod);
    const emaSlowArr = this.emaArray(closes, slowPeriod);
    const offset = emaFastArr.length - emaSlowArr.length;
    const macdLine = emaSlowArr.map((slow, i) => emaFastArr[i + offset] - slow);
    const signalLine = this.emaArray(macdLine, signalPeriod);
    const sigOffset = macdLine.length - signalLine.length;
    const histograms = signalLine.map((sig, i) => macdLine[i + sigOffset] - sig);
    return {
      macd:          macdLine.at(-1)!,
      signal:        signalLine.at(-1)!,
      histogram:     histograms.at(-1)!,
      prevHistogram: histograms.at(-2) ?? 0,
    };
  }

  // ─── Bollinger Bands ──────────────────────────────────────────────────────

  bollingerBands(
    closes: number[],
    period = 20,
    stdDevMult = 2,
  ): { upper: number; middle: number; lower: number; bandwidth: number } {
    if (closes.length < period) {
      const p = closes.at(-1)!;
      return { upper: p, middle: p, lower: p, bandwidth: 0 };
    }
    const recent   = closes.slice(-period);
    const smaVal   = recent.reduce((a, b) => a + b, 0) / period;
    const variance = recent.reduce((sum, v) => sum + Math.pow(v - smaVal, 2), 0) / period;
    const std      = Math.sqrt(variance);
    const upper    = smaVal + stdDevMult * std;
    const lower    = smaVal - stdDevMult * std;
    return { upper, middle: smaVal, lower, bandwidth: smaVal > 0 ? (upper - lower) / smaVal : 0 };
  }

  // ─── Volume ───────────────────────────────────────────────────────────────

  volumeRatio(volumes: number[], period = 20): number {
    if (volumes.length < period + 1) return 1;
    const current = volumes.at(-1)!;
    const avg = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
    return avg > 0 ? current / avg : 1;
  }

  // ─── ATR (Wilder) ─────────────────────────────────────────────────────────

  atr(highs: number[], lows: number[], closes: number[], period = 14): number {
    if (highs.length < 2) return 0;
    const tr: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      tr.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i]  - closes[i - 1]),
      ));
    }
    if (tr.length < period) return tr.reduce((a, b) => a + b, 0) / tr.length;
    let atrVal = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
      atrVal = (atrVal * (period - 1) + tr[i]) / period;
    }
    return atrVal;
  }

  // ─── OBV slope ────────────────────────────────────────────────────────────
  // Positive = OBV rising over `lookback` bars (buying pressure), negative = selling

  obvSlope(closes: number[], volumes: number[], lookback = 5): number {
    if (closes.length < lookback + 1) return 0;
    const obv: number[] = [0];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1])      obv.push(obv.at(-1)! + volumes[i]);
      else if (closes[i] < closes[i - 1]) obv.push(obv.at(-1)! - volumes[i]);
      else                                 obv.push(obv.at(-1)!);
    }
    return obv.at(-1)! - obv.at(-1 - lookback)!;
  }

  // ─── VWAP (anchored to first candle in window) ────────────────────────────

  vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number {
    let cumTPV = 0;
    let cumVol  = 0;
    for (let i = 0; i < closes.length; i++) {
      const tp = (highs[i] + lows[i] + closes[i]) / 3;
      cumTPV += tp * volumes[i];
      cumVol  += volumes[i];
    }
    return cumVol > 0 ? cumTPV / cumVol : closes.at(-1)!;
  }

  // ─── Legacy computeAll (used by bot strategies) ──────────────────────────

  computeAll(ohlcv: OHLCV[]): IndicatorResult | null {
    if (ohlcv.length < 30) return null;
    const closes  = ohlcv.map((c) => c.close);
    const volumes = ohlcv.map((c) => c.volume);
    const ema9Arr  = this.emaArray(closes, 9);
    const ema21Arr = this.emaArray(closes, 21);
    const macdRes  = this.macd(closes);
    const bb       = this.bollingerBands(closes);
    return {
      rsi:              this.rsi(closes),
      ema9:             ema9Arr.at(-1)!,
      ema21:            ema21Arr.at(-1)!,
      prevEma9:         ema9Arr.at(-2) ?? ema9Arr.at(-1)!,
      prevEma21:        ema21Arr.at(-2) ?? ema21Arr.at(-1)!,
      macd:             macdRes.macd,
      macdSignal:       macdRes.signal,
      macdHistogram:    macdRes.histogram,
      prevMacdHistogram: macdRes.prevHistogram,
      bbUpper:          bb.upper,
      bbMiddle:         bb.middle,
      bbLower:          bb.lower,
      bbBandwidth:      bb.bandwidth,
      volume:           volumes.at(-1)!,
      volumeRatio:      this.volumeRatio(volumes),
      close:            closes.at(-1)!,
      prevClose:        closes.at(-2)!,
    };
  }
}
