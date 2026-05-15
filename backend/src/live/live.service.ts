import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';

export interface LiveAccount {
  connected: boolean;
  error?: string;
  totalBalance: number;
  availableBalance: number;
  usedMargin: number;
  unrealizedPnl: number;
  equity: number;
  marginRatio: number;
  currency: string;
}

export interface LivePosition {
  symbol: string;
  side: 'long' | 'short';
  contracts: number;
  notional: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  collateral: number;
  initialMarginPct: number;
}

export interface LiveOrder {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: string;
  amount: number;
  price: number;
  filled: number;
  remaining: number;
  status: string;
  timestamp: number;
  reduceOnly: boolean;
}

@Injectable()
export class LiveService implements OnModuleInit {
  private readonly logger = new Logger(LiveService.name);
  private exchange: ccxt.mexc;

  constructor(
    private config: ConfigService,
    private events: EventsGateway,
  ) {}

  onModuleInit() {
    this.exchange = new ccxt.mexc({
      apiKey:          this.config.get<string>('MEXC_API_KEY', ''),
      secret:          this.config.get<string>('MEXC_API_SECRET', ''),
      enableRateLimit: true,
      options:         { defaultType: 'swap' },
    });
  }

  // ─── Push real-time ogni 10s a tutti i client connessi ───────────────────

  @Cron('*/10 * * * * *')
  async pushLiveUpdate() {
    if (!this.hasCredentials) return;
    try {
      const [account, positions] = await Promise.all([
        this.getAccount(),
        this.getPositions(),
      ]);
      this.events.emitLiveUpdate({ account, positions });
    } catch (err) {
      this.logger.warn(`pushLiveUpdate: ${err.message}`);
    }
  }

  private get hasCredentials(): boolean {
    return !!(this.exchange.apiKey && this.exchange.secret &&
              this.exchange.apiKey.length > 5 && this.exchange.secret.length > 5);
  }

  // Returns the raw MEXC API response so we can debug the exact field structure
  async getRawBalance(): Promise<any> {
    try {
      const res     = await (this.exchange as any).contractPrivateGetAccountAssets();
      const balance = await this.exchange.fetchBalance();
      return {
        contractAssets: res,
        ccxtBalance: {
          USDT: (balance['USDT'] ?? balance['usdt'] ?? null),
          info: balance.info,
        },
      };
    } catch (e: any) {
      return { error: e?.message };
    }
  }

  private parseRaw(res: any): { equity: number; available: number; cash: number; posMargin: number; frozen: number; unrealPnl: number } | null {
    // MEXC may return data as array [{currency,equity,...}] or object {currency,equity,...}
    const data = res?.data;
    let raw: any = null;
    if (Array.isArray(data) && data.length > 0) {
      raw = data[0];
    } else if (data && typeof data === 'object' && !Array.isArray(data)) {
      // might be keyed by currency: { USDT: {...} } or direct object
      raw = data['USDT'] ?? data;
    }
    if (!raw) return null;
    const equity    = Number(raw.equity           ?? raw.totalEquity    ?? 0);
    const available = Number(raw.availableBalance ?? raw.available      ?? 0);
    const cash      = Number(raw.cashBalance      ?? raw.walletBalance  ?? 0);
    const posMargin = Number(raw.positionMargin   ?? raw.usedMargin     ?? 0);
    const frozen    = Number(raw.frozenBalance    ?? raw.frozen         ?? 0);
    const unrealPnl = Number(raw.unrealized       ?? raw.unrealisedPnl ?? 0);
    if (!equity && !available && !cash) return null;
    return { equity, available, cash, posMargin, frozen, unrealPnl };
  }

  async getAccount(): Promise<LiveAccount> {
    if (!this.hasCredentials) {
      return this.emptyAccount('API keys non configurate nel file .env');
    }
    try {
      let equity = 0, available = 0, cash = 0, posMargin = 0, frozen = 0, unrealPnl = 0;

      // Primary: MEXC contract assets endpoint (has equity, unrealized, cashBalance)
      try {
        const res    = await (this.exchange as any).contractPrivateGetAccountAssets();
        const parsed = this.parseRaw(res);
        if (parsed) {
          ({ equity, available, cash, posMargin, frozen, unrealPnl } = parsed);
          this.logger.log(`[LIVE] assets OK: equity=${equity} avail=${available} cash=${cash} margin=${posMargin} unreal=${unrealPnl}`);
        } else {
          this.logger.warn(`[LIVE] assets: unexpected structure — ${JSON.stringify(res).slice(0, 200)}`);
        }
      } catch (e: any) {
        this.logger.warn(`[LIVE] contractPrivateGetAccountAssets error: ${e?.message?.slice(0, 100)}`);
      }

      // Fallback: ccxt fetchBalance (loses equity/unrealized but usable)
      if (!available && !equity) {
        const balance = await this.exchange.fetchBalance();
        // also try balance.info which contains the raw response
        const parsed = this.parseRaw(balance.info);
        if (parsed) {
          ({ equity, available, cash, posMargin, frozen, unrealPnl } = parsed);
          this.logger.log(`[LIVE] assets from balance.info: equity=${equity} avail=${available}`);
        } else {
          const usdt = (balance['USDT'] ?? balance['usdt'] ?? {}) as any;
          available = Number(usdt.free  ?? 0);
          posMargin = Number(usdt.used  ?? 0);
          cash      = Number(usdt.total ?? 0);
          equity    = cash;
          this.logger.warn(`[LIVE] using ccxt normalized fallback: avail=${available} cash=${cash}`);
        }
      }

      const used        = posMargin + frozen;
      const marginRatio = equity > 0 ? (used / equity) * 100 : 0;

      return {
        connected:        true,
        totalBalance:     +cash.toFixed(4),
        availableBalance: +available.toFixed(4),
        usedMargin:       +used.toFixed(4),
        unrealizedPnl:    +unrealPnl.toFixed(4),
        equity:           +equity.toFixed(4),
        marginRatio:      +marginRatio.toFixed(2),
        currency:         'USDT',
      };
    } catch (err) {
      this.logger.error(`getAccount: ${err.message}`);
      return this.emptyAccount(err.message);
    }
  }

  async getPositions(): Promise<LivePosition[]> {
    if (!this.hasCredentials) return [];
    try {
      const raw     = await this.exchange.fetchPositions();
      const openPos = raw.filter((p) => (p.contracts ?? 0) > 0);
      if (!openPos.length) return [];

      // Fetch live mark prices for all position symbols
      const tickers: Record<string, any> = {};
      try {
        const syms = [...new Set(openPos.map(p => p.symbol))];
        const data = await this.exchange.fetchTickers(syms);
        Object.assign(tickers, data);
      } catch {}

      return openPos.map((p) => {
        const ticker       = tickers[p.symbol] ?? {};
        const mark         = Number(p.markPrice ?? ticker.last ?? ticker.close ?? p.entryPrice ?? 0);
        const entry        = Number(p.entryPrice ?? 0);
        const contracts    = Number(p.contracts ?? 0);
        const contractSize = Number(p.contractSize ?? 1);
        const notional     = contracts * contractSize * (mark || entry);
        const collateral   = Number(p.collateral ?? p.initialMargin ?? p.info?.im ?? 0);

        // Unrealized PnL from ccxt or from MEXC profitRatio × initial margin
        let unrealPnl = Number(p.unrealizedPnl ?? 0);
        if (!unrealPnl && p.info?.profitRatio != null && collateral > 0) {
          unrealPnl = Number(p.info.profitRatio) * collateral;
        }
        const pnlPct = notional > 0
          ? (unrealPnl / (collateral || 1)) * 100
          : Number(p.percentage ?? 0);
        const initMarginPct = notional > 0 ? (collateral / notional) * 100 : 0;

        return {
          symbol:           p.symbol,
          side:             (p.side ?? 'long') as 'long' | 'short',
          contracts,
          notional:         +notional.toFixed(4),
          entryPrice:       entry,
          markPrice:        +mark.toFixed(6),
          liquidationPrice: Number(p.liquidationPrice ?? 0),
          leverage:         Number(p.leverage ?? 1),
          unrealizedPnl:    +unrealPnl.toFixed(4),
          unrealizedPnlPct: +pnlPct.toFixed(2),
          collateral:       +collateral.toFixed(4),
          initialMarginPct: +initMarginPct.toFixed(2),
        };
      });
    } catch (err) {
      this.logger.error(`getPositions: ${err.message}`);
      return [];
    }
  }

  async getOrders(): Promise<LiveOrder[]> {
    if (!this.hasCredentials) return [];
    try {
      const raw = await this.exchange.fetchOrders(undefined, undefined, 50);
      return raw
        .slice(0, 50)
        .map((o) => ({
          id:         o.id,
          symbol:     o.symbol,
          side:       (o.side ?? 'buy') as 'buy' | 'sell',
          type:       o.type ?? 'limit',
          amount:     o.amount ?? 0,
          price:      o.average ?? o.price ?? 0,
          filled:     o.filled  ?? 0,
          remaining:  o.remaining ?? 0,
          status:     o.status   ?? 'unknown',
          timestamp:  o.timestamp ?? Date.now(),
          reduceOnly: (o as any).reduceOnly ?? false,
        }));
    } catch {
      return [];
    }
  }

  private emptyAccount(error: string): LiveAccount {
    return {
      connected: false, error,
      totalBalance: 0, availableBalance: 0, usedMargin: 0,
      unrealizedPnl: 0, equity: 0, marginRatio: 0, currency: 'USDT',
    };
  }
}
