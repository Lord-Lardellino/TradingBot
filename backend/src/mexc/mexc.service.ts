import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Ticker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  change: number;
  percentage: number;
  baseVolume: number;
  quoteVolume: number;
}

export interface OrderResult {
  id: string;
  symbol: string;
  side: string;
  amount: number;
  price: number;
  cost: number;
  status: string;
  timestamp: number;
}

@Injectable()
export class MexcService implements OnModuleInit {
  private readonly logger = new Logger(MexcService.name);
  private exchange: ccxt.mexc;
  private testMode: boolean;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.testMode = this.config.get('TEST_MODE', 'true') === 'true';
    const apiKey = this.config.get('MEXC_API_KEY', '');
    const secret = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
    this.logger.log(`MEXC exchange initialized (testMode=${this.testMode})`);
  }

  async getOHLCV(symbol: string, timeframe = '1m', limit = 100): Promise<OHLCV[]> {
    try {
      const raw = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
      return raw.map(([timestamp, open, high, low, close, volume]) => ({
        timestamp, open, high, low, close, volume,
      }));
    } catch (err) {
      this.logger.error(`getOHLCV(${symbol}) failed: ${err.message}`);
      return [];
    }
  }

  async getTicker(symbol: string): Promise<Ticker | null> {
    try {
      const t = await this.exchange.fetchTicker(symbol);
      return {
        symbol: t.symbol,
        last: t.last,
        bid: t.bid,
        ask: t.ask,
        change: t.change,
        percentage: t.percentage,
        baseVolume: t.baseVolume,
        quoteVolume: t.quoteVolume,
      };
    } catch (err) {
      this.logger.error(`getTicker(${symbol}) failed: ${err.message}`);
      return null;
    }
  }

  async getBalance(): Promise<Record<string, number>> {
    if (this.testMode) return { USDT: 1000, BTC: 0 };
    try {
      const balance = await this.exchange.fetchBalance();
      const result: Record<string, number> = {};
      Object.keys(balance.free).forEach((asset) => {
        if (balance.free[asset] > 0) result[asset] = balance.free[asset];
      });
      return result;
    } catch (err) {
      this.logger.error(`getBalance failed: ${err.message}`);
      return {};
    }
  }

  async placeMarketOrder(
    symbol: string,
    side: 'buy' | 'sell',
    amount: number,
  ): Promise<OrderResult | null> {
    if (this.testMode) {
      this.logger.log(`[PAPER] ${side.toUpperCase()} ${amount} ${symbol}`);
      return {
        id: `paper_${Date.now()}`,
        symbol,
        side,
        amount,
        price: 0,
        cost: 0,
        status: 'closed',
        timestamp: Date.now(),
      };
    }
    try {
      const order = await this.exchange.createMarketOrder(symbol, side, amount);
      return {
        id: order.id,
        symbol: order.symbol,
        side: order.side,
        amount: order.amount,
        price: order.average || order.price,
        cost: order.cost,
        status: order.status,
        timestamp: order.timestamp,
      };
    } catch (err) {
      this.logger.error(`placeOrder(${symbol} ${side}) failed: ${err.message}`);
      return null;
    }
  }

  async getMarkets(): Promise<string[]> {
    try {
      const markets = await this.exchange.loadMarkets();
      return Object.keys(markets)
        .filter((s) => s.endsWith('/USDT'))
        .sort();
    } catch (err) {
      this.logger.error(`getMarkets failed: ${err.message}`);
      return ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT'];
    }
  }
}
