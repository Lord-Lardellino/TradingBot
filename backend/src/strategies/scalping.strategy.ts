import { Injectable } from '@nestjs/common';
import { IndicatorResult } from '../indicators/indicators.service';

export interface ScalpingConfig {
  rsiOversold: number;       // default 35
  rsiOverbought: number;     // default 65
  rsiMidLow: number;         // default 45
  rsiMidHigh: number;        // default 55
  volumeMinRatio: number;    // default 1.2
  stopLossPct: number;       // default 0.5
  takeProfitPct: number;     // default 1.0
}

export interface ScalpingSignal {
  type: 'BUY' | 'SELL' | 'CLOSE_LONG' | 'CLOSE_SHORT' | 'HOLD';
  reason: string;
  indicators: IndicatorResult;
  stopLoss?: number;
  takeProfit?: number;
}

@Injectable()
export class ScalpingStrategy {
  private defaultConfig: ScalpingConfig = {
    rsiOversold: 35,
    rsiOverbought: 65,
    rsiMidLow: 45,
    rsiMidHigh: 55,
    volumeMinRatio: 1.2,
    stopLossPct: 0.5,
    takeProfitPct: 1.0,
  };

  evaluate(
    indicators: IndicatorResult,
    hasOpenLong: boolean,
    hasOpenShort: boolean,
    config: Partial<ScalpingConfig> = {},
  ): ScalpingSignal {
    const cfg = { ...this.defaultConfig, ...config };
    const {
      rsi, ema9, ema21, prevEma9, prevEma21,
      macdHistogram, prevMacdHistogram,
      bbMiddle, close, volumeRatio,
    } = indicators;

    // ─── Close existing positions ──────────────────────────────────────────
    if (hasOpenLong) {
      const emaBearish = ema9 < ema21 && prevEma9 >= prevEma21;
      const rsiOverbought = rsi >= cfg.rsiOverbought;
      const histTurnsNeg = macdHistogram < 0 && prevMacdHistogram >= 0;

      if (emaBearish || rsiOverbought || histTurnsNeg) {
        return {
          type: 'CLOSE_LONG',
          reason: emaBearish
            ? 'EMA bearish crossover'
            : rsiOverbought
              ? `RSI overbought (${rsi.toFixed(1)})`
              : 'MACD histogram turned negative',
          indicators,
        };
      }
    }

    if (hasOpenShort) {
      const emaBullish = ema9 > ema21 && prevEma9 <= prevEma21;
      const rsiOversold = rsi <= cfg.rsiOversold;
      const histTurnsPos = macdHistogram > 0 && prevMacdHistogram <= 0;

      if (emaBullish || rsiOversold || histTurnsPos) {
        return {
          type: 'CLOSE_SHORT',
          reason: emaBullish
            ? 'EMA bullish crossover'
            : rsiOversold
              ? `RSI oversold (${rsi.toFixed(1)})`
              : 'MACD histogram turned positive',
          indicators,
        };
      }
    }

    if (hasOpenLong || hasOpenShort) {
      return { type: 'HOLD', reason: 'Position open, no exit condition', indicators };
    }

    // ─── New entry signals ─────────────────────────────────────────────────
    const emaBullishCross = ema9 > ema21 && prevEma9 <= prevEma21;
    const emaBearishCross = ema9 < ema21 && prevEma9 >= prevEma21;
    const macdBullish = macdHistogram > 0 && prevMacdHistogram <= 0;
    const macdBearish = macdHistogram < 0 && prevMacdHistogram >= 0;
    const rsiMomentumUp = rsi >= cfg.rsiMidLow && rsi <= cfg.rsiOverbought;
    const rsiMomentumDown = rsi <= cfg.rsiMidHigh && rsi >= cfg.rsiOversold;
    const volumeOk = volumeRatio >= cfg.volumeMinRatio;
    const aboveBBMiddle = close >= bbMiddle;
    const belowBBMiddle = close <= bbMiddle;

    // BUY: EMA9 crosses above EMA21, RSI in bullish zone, MACD confirms, volume OK
    if (emaBullishCross && macdBullish && rsiMomentumUp && volumeOk && aboveBBMiddle) {
      return {
        type: 'BUY',
        reason: `EMA9 cross ↑ EMA21 | RSI ${rsi.toFixed(1)} | MACD+ | Vol ×${volumeRatio.toFixed(2)}`,
        indicators,
        stopLoss: close * (1 - cfg.stopLossPct / 100),
        takeProfit: close * (1 + cfg.takeProfitPct / 100),
      };
    }

    // SELL: EMA9 crosses below EMA21, RSI in bearish zone, MACD confirms, volume OK
    if (emaBearishCross && macdBearish && rsiMomentumDown && volumeOk && belowBBMiddle) {
      return {
        type: 'SELL',
        reason: `EMA9 cross ↓ EMA21 | RSI ${rsi.toFixed(1)} | MACD- | Vol ×${volumeRatio.toFixed(2)}`,
        indicators,
        stopLoss: close * (1 + cfg.stopLossPct / 100),
        takeProfit: close * (1 - cfg.takeProfitPct / 100),
      };
    }

    return { type: 'HOLD', reason: 'No entry condition met', indicators };
  }
}
