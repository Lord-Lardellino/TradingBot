import { Injectable } from '@nestjs/common';
import { OHLCV } from '../mexc/mexc.service';
import { IndicatorsService } from '../indicators/indicators.service';

export interface PumpConfig {
  volumeRatioThreshold: number;   // default 3.0 — volume spike multiplier
  priceChangePct: number;         // default 2.0 — min % price change in window
  lookbackCandles: number;        // default 5  — price change window
  rsiThreshold: number;           // default 60 — RSI must be above this for pump
  stopLossPct: number;            // default 1.5
  takeProfitPct: number;          // default 3.0
}

export interface PumpSignal {
  type: 'PUMP' | 'DUMP' | 'NEUTRAL';
  confidence: number;             // 0–1
  reason: string;
  volumeRatio: number;
  priceChangePct: number;
  rsi: number;
  stopLoss?: number;
  takeProfit?: number;
  price: number;
}

@Injectable()
export class PumpStrategy {
  private defaultConfig: PumpConfig = {
    volumeRatioThreshold: 3.0,
    priceChangePct: 2.0,
    lookbackCandles: 5,
    rsiThreshold: 60,
    stopLossPct: 1.5,
    takeProfitPct: 3.0,
  };

  constructor(private indicators: IndicatorsService) {}

  evaluate(ohlcv: OHLCV[], config: Partial<PumpConfig> = {}): PumpSignal {
    const cfg = { ...this.defaultConfig, ...config };
    const closes = ohlcv.map((c) => c.close);
    const volumes = ohlcv.map((c) => c.volume);

    const currentPrice = closes[closes.length - 1];
    const lookbackPrice = closes[closes.length - 1 - cfg.lookbackCandles] ?? closes[0];
    const priceChangePct = ((currentPrice - lookbackPrice) / lookbackPrice) * 100;

    const currentVolume = volumes[volumes.length - 1];
    const avgVolume =
      volumes.slice(-cfg.lookbackCandles * 4, -1).reduce((a, b) => a + b, 0) /
      Math.max(cfg.lookbackCandles * 4 - 1, 1);
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 1;

    const rsi = this.indicators.rsi(closes, 14);

    const volumeSpiked = volumeRatio >= cfg.volumeRatioThreshold;
    const pumpCondition =
      volumeSpiked && priceChangePct >= cfg.priceChangePct && rsi >= cfg.rsiThreshold;
    const dumpCondition =
      volumeSpiked && priceChangePct <= -cfg.priceChangePct && rsi <= 100 - cfg.rsiThreshold;

    // Confidence: proportional to how much the conditions exceeded thresholds
    const volScore = Math.min((volumeRatio - cfg.volumeRatioThreshold) / cfg.volumeRatioThreshold + 0.5, 1);
    const priceScore = Math.min(Math.abs(priceChangePct) / (cfg.priceChangePct * 2), 1);
    const confidence = (volScore + priceScore) / 2;

    if (pumpCondition) {
      return {
        type: 'PUMP',
        confidence,
        reason: `Volume ×${volumeRatio.toFixed(2)} | Price +${priceChangePct.toFixed(2)}% | RSI ${rsi.toFixed(1)}`,
        volumeRatio,
        priceChangePct,
        rsi,
        price: currentPrice,
        stopLoss: currentPrice * (1 - cfg.stopLossPct / 100),
        takeProfit: currentPrice * (1 + cfg.takeProfitPct / 100),
      };
    }

    if (dumpCondition) {
      return {
        type: 'DUMP',
        confidence,
        reason: `Volume ×${volumeRatio.toFixed(2)} | Price ${priceChangePct.toFixed(2)}% | RSI ${rsi.toFixed(1)}`,
        volumeRatio,
        priceChangePct,
        rsi,
        price: currentPrice,
        stopLoss: currentPrice * (1 + cfg.stopLossPct / 100),
        takeProfit: currentPrice * (1 - cfg.takeProfitPct / 100),
      };
    }

    return {
      type: 'NEUTRAL',
      confidence: 0,
      reason: volumeSpiked
        ? `Volume spike ×${volumeRatio.toFixed(2)} but price change only ${priceChangePct.toFixed(2)}%`
        : 'Normal market conditions',
      volumeRatio,
      priceChangePct,
      rsi,
      price: currentPrice,
    };
  }
}
