import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ── Funding Rate Arbitrage ────────────────────────────────────────────────────
// Strategia delta-neutral: spot LONG + futures SHORT sullo stesso asset
// Guadagno: funding rate pagato dai long agli short ogni 8 ore
// Rischio: funding rate che diventa negativo (chiudi e cambia asset)

@Injectable()
export class FundingArbService implements OnModuleInit {
  private readonly logger = new Logger(FundingArbService.name);
  private swapExchange: ccxt.mexc;
  private spotExchange: ccxt.mexc;
  private rates: FundingRate[]  = [];
  private lastScanAt: string | null = null;
  private isScanning = false;

  constructor(
    private config: ConfigService,
    private events: EventsGateway,
    private prisma: PrismaService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    const base = hasKeys ? { apiKey, secret } : {};

    this.swapExchange = new ccxt.mexc({ ...base, enableRateLimit: true, timeout: 10000, options: { defaultType: 'swap' } });
    this.spotExchange = new ccxt.mexc({ ...base, enableRateLimit: true, timeout: 10000, options: { defaultType: 'spot' } });

    try { await this.swapExchange.loadMarkets(); } catch (e: any) { this.logger.warn(`[FUNDING] swap markets: ${e?.message}`); }
    try { await this.spotExchange.loadMarkets(); } catch (e: any) { this.logger.warn(`[FUNDING] spot markets: ${e?.message}`); }

    await this.scanRates();
    this.logger.log('[FUNDING] Funding Rate Arbitrage monitor attivo');
  }

  // ── Auto-entry/exit loop — ogni 15 minuti ───────────────────────────────
  @Cron('0 */15 * * * *')
  async autoTradeLoop() {
    try {
      const cfg = await this.prisma.fundingArbConfig.findUnique({ where: { id: 1 } });
      if (!cfg?.autoTradeEnabled) return;

      // 1. Controlla posizioni aperte — se rate negativo, ESCI
      const openPos = await this.prisma.fundingArbPosition.findMany({ where: { status: 'open' } });
      for (const pos of openPos) {
        const rate = this.rates.find(r => r.symbol === pos.symbol);
        if (!rate || rate.fundingRate < 0) {
          this.logger.log(`[FUNDING AUTO] ${pos.symbol}: rate negativo (${rate?.fundingRate}), EXIT`);
          await this.closePosition(pos.id, 'rate_negative');
        }
      }

      // 2. Controlla pair positivi — se niente posizione aperta, ENTRA
      // FILTRO LIQUIDITÀ: solo coppie con volume 24h decente (esclude shitcoin
      // illiquide con APR 500% dove lo spread mangia il funding) e APR sensato.
      const MIN_VOL_24H = 500_000;   // $500k volume minimo
      const MAX_APR     = 300;       // sopra 300% APR = quasi sempre rate instabile/illiquido
      const positive = this.rates.filter(r =>
        r.fundingRate > 0 &&
        r.hasSpot &&
        r.vol24h > MIN_VOL_24H &&
        r.aprPct <= MAX_APR &&
        !openPos.some(p => p.symbol === r.symbol)
      );
      const maxSlots = (cfg.maxOpenPositions ?? 5) - openPos.length;
      const toEnter = positive.slice(0, maxSlots);  // già ordinate per APR desc

      for (const rate of toEnter) {
        try {
          // enterPosition salva già nel DB
          const res = await this.enterPosition(rate.symbol, cfg.capitalPerPosition ?? 15, cfg.leveragePerPosition ?? 1);
          this.logger.log(`[FUNDING AUTO] ${rate.symbol}: ENTRY OK · notional=${res.notional}\\$ · daily+${res.dailyProfit}\\$`);
        } catch (e: any) {
          this.logger.warn(`[FUNDING AUTO] ${rate.symbol}: entry failed: ${e?.message?.slice(0, 50)}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[FUNDING AUTO] loop error: ${e?.message}`);
    }
  }

  // ── Scansione ogni 30 minuti ─────────────────────────────────────────────
  @Cron('0 */30 * * * *')
  async scanRates() {
    if (this.isScanning) return;
    this.isScanning = true;

    try {
      // 1. Prendi tutti i funding rate in batch dall'API MEXC contract
      const batchRes  = await fetch('https://contract.mexc.com/api/v1/contract/funding_rate', { signal: AbortSignal.timeout(10000) });
      const batchJson = await batchRes.json();

      // 2. Tickers per prezzo e volume
      const tickers = await this.swapExchange.fetchTickers();

      const results: FundingRate[] = [];

      // batchJson.data è un array di { symbol, fundingRate, nextSettleTime, ... }
      const rateMap = new Map<string, any>();
      if (batchJson?.success && Array.isArray(batchJson.data)) {
        for (const item of batchJson.data) {
          rateMap.set(String(item.symbol), item);
        }
      }

      // Merge con tickers CCXT
      for (const [ccxtSymbol, ticker] of Object.entries(tickers)) {
        if (!ccxtSymbol.endsWith('/USDT:USDT')) continue;
        const base     = ccxtSymbol.replace('/USDT:USDT', '');
        const mexcSym  = `${base}_USDT`;
        const rateData = rateMap.get(mexcSym);
        if (!rateData) continue;

        const fundingRate = Number(rateData.fundingRate ?? 0);
        const nextSettle  = rateData.nextSettleTime ? new Date(Number(rateData.nextSettleTime)).toISOString() : null;
        const price       = Number((ticker as any).last ?? 0);
        const vol24h      = Number((ticker as any).quoteVolume ?? 0);
        if (!price) continue;

        const spotSymbol   = `${base}/USDT`;
        const hasSpot      = this.spotExchange.markets?.[spotSymbol] != null;

        // Detect settlement interval — default 8h, some pairs are 4h
        let settleHours = 8;
        if (rateData.fundingPeriod) {
          const match = String(rateData.fundingPeriod).match(/(\d+)[Hh]/);
          if (match) settleHours = parseInt(match[1]);
        }
        const settlePerDay = 24 / settleHours;
        const dailyPct     = fundingRate * settlePerDay * 100;
        const aprPct       = fundingRate * settlePerDay * 365 * 100;

        results.push({
          symbol: ccxtSymbol,
          base,
          spotSymbol,
          hasSpot,
          price,
          vol24h,
          fundingRate:   parseFloat(fundingRate.toFixed(6)),
          settleHours,
          settlePerDay:  parseFloat(settlePerDay.toFixed(1)),
          dailyPct:      parseFloat(dailyPct.toFixed(4)),
          aprPct:        parseFloat(aprPct.toFixed(2)),
          nextFunding:   nextSettle,
          timestamp:     new Date().toISOString(),
        });
      }

      // Ordina: positivi per APR desc, poi negativi
      results.sort((a, b) => b.aprPct - a.aprPct);
      this.rates      = results;
      this.lastScanAt = new Date().toISOString();

      const positive = results.filter(r => r.fundingRate > 0);
      this.events.emitFundingRates(results.slice(0, 30));
      this.logger.log(
        `[FUNDING] ${results.length} pair · ${positive.length} positivi · top: ${results[0]?.base ?? '-'} ${results[0]?.aprPct?.toFixed(1) ?? '-'}% APR`
      );

    } catch (e: any) {
      this.logger.warn(`[FUNDING] scanRates: ${e?.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ── Calcola profitto atteso per una posizione ─────────────────────────────
  calcProjection(symbol: string, capitalUsdt: number, leverage = 1): FundingProjection | null {
    const rate = this.rates.find(r => r.symbol === symbol);
    if (!rate) return null;

    // Notional = capitale * leva
    // Liquidation distance = entry ± (entry * marginPct / leverage)
    // Con leva 2x, marginPct 100%, liquidation = 0.5% away
    const notional      = capitalUsdt * leverage;
    const liquidationPct = 100 / leverage;  // distanza da entry in %
    const dailyProfit   = notional * (rate.dailyPct / 100);
    const monthlyProfit = dailyProfit * 30;
    const yearlyProfit  = dailyProfit * 365;

    return {
      symbol,
      capitalUsdt,
      notional,
      fundingRate:      rate.fundingRate,
      dailyPct:         rate.dailyPct,
      aprPct:           rate.aprPct,
      dailyProfit:      parseFloat(dailyProfit.toFixed(4)),
      monthlyProfit:    parseFloat(monthlyProfit.toFixed(2)),
      yearlyProfit:     parseFloat(yearlyProfit.toFixed(2)),
      leverage,
      liquidationPct:   parseFloat(liquidationPct.toFixed(2)),
    };
  }

  // ── Close: vendi spot + chiudi short futures ────────────────────────────
  private async closePosition(posId: string, reason: string) {
    const pos = await this.prisma.fundingArbPosition.findUnique({ where: { id: posId } });
    if (!pos || pos.status !== 'open') return;

    try {
      const base = pos.symbol.replace('/USDT:USDT', '');
      const spotSymbol = `${base}/USDT`;

      // 1. Vendi SPOT (quantità in coin)
      const spotSell = await this.spotExchange.createMarketSellOrder(spotSymbol, pos.quantity);
      const salePrice = spotSell.info?.filledPrice ?? pos.entryPrice;
      const pnl = (salePrice - pos.entryPrice) * pos.quantity;

      // 2. Chiudi SHORT FUTURES (converti coin → contratti)
      const market = this.swapExchange.market(pos.symbol);
      const contractSize = Number((market as any)?.contractSize ?? 1) || 1;
      const contracts = pos.quantity / contractSize;
      await this.swapExchange.createMarketBuyOrder(pos.symbol, contracts, { reduceOnly: true });

      // Salva chiusura
      await this.prisma.fundingArbPosition.update({
        where: { id: posId },
        data: {
          status: 'closed',
          closePrice: salePrice,
          closePnl: pnl,
          closeTime: new Date(),
          closeReason: reason,
        },
      });

      this.logger.log(`[FUNDING CLOSE] ${pos.symbol}: ${reason} · PnL=${pnl.toFixed(4)}\\$`);
    } catch (e: any) {
      this.logger.error(`[FUNDING CLOSE] ${pos.symbol}: ${e?.message?.slice(0, 50)}`);
    }
  }

  // ── Entry: compra spot + apri short futures ──────────────────────────────
  async enterPosition(symbol: string, capitalUsdt: number, leverage = 1) {
    const rate = this.rates.find(r => r.symbol === symbol);
    if (!rate || !rate.hasSpot) throw new Error(`${symbol} non ha spot disponibile o rate sconosciuto`);
    if (rate.fundingRate <= 0) throw new Error(`${symbol} ha rate negativo (${rate.fundingRate}), non fattibile`);

    try {
      const base = symbol.replace('/USDT:USDT', '');
      const spotSymbol = `${base}/USDT`;

      // Logica delta-neutral:
      // - SPOT: compro capitalUsdt fisso (es. 2$) → quantità = capitalUsdt / price
      // - FUTURES: shorto la STESSA quantità (delta-neutral) con leva impostata
      // - notional = quantità × price ≈ capitalUsdt (su questo guadagno il funding)
      // - margine futures = notional / leverage

      // ── PRE-CHECK fattibilità futures PRIMA di comprare lo spot ──────────
      // I futures MEXC si ordinano in CONTRATTI (1 contratto = contractSize coin).
      // Verifichiamo il minimo contratti: se non raggiungibile con capitalUsdt, SKIP
      // senza comprare lo spot (evita il loop apri-spot/rollback).
      const market = this.swapExchange.market(symbol);
      const contractSize = Number((market as any)?.contractSize ?? 1) || 1;
      const minContracts = Number((market as any)?.limits?.amount?.min ?? 1) || 1;

      const spotQuantity0 = capitalUsdt / rate.price;
      const rawContracts  = spotQuantity0 / contractSize;
      // arrotonda al minimo step di contratti (>= minContracts)
      const contracts = Math.max(minContracts, Math.round(rawContracts / minContracts) * minContracts);

      // Costo minimo reale del futures con minContracts
      const minFuturesNotional = minContracts * contractSize * rate.price;
      // Se il minimo contratti vale molto più del capitale (>2.5x), la coppia non è
      // fattibile con questo capitale → skip pulito senza toccare lo spot
      if (minFuturesNotional > capitalUsdt * 2.5) {
        throw new Error(`${base} minimo futures ${minFuturesNotional.toFixed(2)}$ > capitale ${capitalUsdt}$ (skip)`);
      }

      // 1. Compra SPOT — quantità allineata ai contratti futures per restare delta-neutral
      const targetCoin = contracts * contractSize;
      const spotOrderRes = await this.spotExchange.createMarketBuyOrder(spotSymbol, targetCoin);
      const spotQuantity = spotOrderRes.amount ?? targetCoin;

      // 3. Imposta la leva su MEXC PRIMA di aprire (ISOLATED mode, posizione short)
      // MEXC richiede openType (1=isolated, 2=cross) e positionType (1=long, 2=short)
      try {
        await this.swapExchange.setLeverage(leverage, symbol, { openType: 1, positionType: 2 });
        this.logger.log(`[FUNDING] setLeverage ${leverage}x ISOLATED OK su ${symbol}`);
      } catch (e: any) {
        this.logger.warn(`[FUNDING] setLeverage ${leverage}x ${symbol} FALLITO: ${e?.message?.slice(0, 60)}`);
      }

      // 4. Apri SHORT FUTURES in ISOLATED — con ROLLBACK atomico: se fallisce, rivendo lo spot
      let futuresRes: any;
      try {
        futuresRes = await this.swapExchange.createMarketSellOrder(symbol, contracts, { openType: 1, positionType: 2, leverage });
      } catch (e: any) {
        this.logger.warn(`[FUNDING] ${base} futures fallito → ROLLBACK vendo spot. err: ${e?.message?.slice(0, 50)}`);
        await this.spotExchange.createMarketSellOrder(spotSymbol, spotQuantity).catch((re: any) =>
          this.logger.error(`[FUNDING] ${base} ROLLBACK spot FALLITO: ${re?.message?.slice(0, 50)}`)
        );
        throw new Error(`Futures fallito (spot rollbackato): ${e?.message?.slice(0, 60)}`);
      }
      // quantità reale in coin shortate = contratti eseguiti × contractSize
      const futuresContracts = futuresRes.amount ?? contracts;
      const futuresQuantity = futuresContracts * contractSize;

      const entryTs = Date.now();
      const notional       = futuresQuantity * rate.price;  // valore reale shortato
      const marginFutures  = notional / leverage;          // margine bloccato sui futures
      const totalCapital   = capitalUsdt + marginFutures;  // spot + margine futures
      const liquidationPct = 100 / leverage;
      const dailyProfit    = notional * (rate.dailyPct / 100);

      this.logger.log(
        `[FUNDING ENTRY] ${base} · spot=${spotQuantity} coin (${capitalUsdt}$) · short=${futuresContracts} contratti (cs=${contractSize}) = ${futuresQuantity} coin · leva=${leverage}x · marginFut=${marginFutures.toFixed(2)}$ · liq=${liquidationPct}% · daily+${dailyProfit.toFixed(4)}$`
      );

      // Salva nel DB (sia per entry manuale che automatica → il cron le conta correttamente)
      await this.prisma.fundingArbPosition.create({
        data: {
          symbol,
          entryPrice: rate.price,
          quantity: spotQuantity,
          fundingRate: rate.fundingRate,
          status: 'open',
          entryTime: new Date(entryTs),
        },
      }).catch((e: any) => this.logger.warn(`[FUNDING] DB save ${base}: ${e?.message?.slice(0, 40)}`));

      return {
        symbol,
        base,
        spotQuantity: parseFloat(spotQuantity.toFixed(8)),
        futuresQuantity: parseFloat(futuresQuantity.toFixed(8)),
        capitalUsdt,
        notional: parseFloat(notional.toFixed(4)),
        marginFutures: parseFloat(marginFutures.toFixed(4)),
        totalCapital: parseFloat(totalCapital.toFixed(4)),
        leverage,
        fundingRate: rate.fundingRate,
        aprPct: rate.aprPct,
        dailyProfit: parseFloat(dailyProfit.toFixed(4)),
        liquidationPct: parseFloat(liquidationPct.toFixed(2)),
        entryTime: new Date(entryTs).toISOString(),
        nextFunding: rate.nextFunding,
      };
    } catch (e: any) {
      this.logger.error(`[FUNDING ENTRY] ${symbol}: ${e?.message}`);
      throw new Error(`Entry fallito: ${e?.message}`);
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────
  getTopRates(limit = 50) {
    return this.rates.slice(0, limit);
  }

  getPositiveRates() {
    return this.rates.filter(r => r.fundingRate > 0);
  }

  getNegativeRates() {
    return this.rates.filter(r => r.fundingRate < 0);
  }

  getStatus() {
    const positive = this.rates.filter(r => r.fundingRate > 0);
    const top5     = this.rates.slice(0, 5);
    return {
      lastScanAt:    this.lastScanAt,
      isScanning:    this.isScanning,
      totalPairs:    this.rates.length,
      positivePairs: positive.length,
      negativePairs: this.rates.filter(r => r.fundingRate < 0).length,
      avgApr:        positive.length ? positive.reduce((s, r) => s + r.aprPct, 0) / positive.length : 0,
      top5,
    };
  }

  getDashboard() {
    return {
      rates:   this.rates.slice(0, 100),
      status:  this.getStatus(),
      updatedAt: this.lastScanAt,
    };
  }

  async getConfig() {
    let cfg = await this.prisma.fundingArbConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.fundingArbConfig.create({
        data: { id: 1, autoTradeEnabled: false, maxOpenPositions: 10, capitalPerPosition: 2, leveragePerPosition: 2 },
      });
    }
    return cfg;
  }

  async updateConfig(updates: any) {
    const cfg = await this.prisma.fundingArbConfig.update({
      where: { id: 1 },
      data: { ...updates },
    });
    this.logger.log(`[FUNDING CONFIG] updated: autoTradeEnabled=${cfg.autoTradeEnabled}`);
    return cfg;
  }

  async getPositions() {
    const positions = await this.prisma.fundingArbPosition.findMany({ orderBy: { entryTime: 'desc' } });
    const openPos = positions.filter(p => p.status === 'open');
    const closedPos = positions.filter(p => p.status === 'closed');

    const totalPnl = closedPos.reduce((sum, p) => sum + (p.closePnl ?? 0), 0);
    const unrealizedPnl = openPos.reduce((sum, p) => {
      const rate = this.rates.find(r => r.symbol === p.symbol);
      if (!rate) return sum;
      const dailyProfit = (p.quantity * p.entryPrice) * (rate.dailyPct / 100);
      return sum + dailyProfit;
    }, 0);

    return {
      openPositions: openPos,
      closedPositions: closedPos.slice(0, 20),
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      unrealizedPnl: parseFloat(unrealizedPnl.toFixed(4)),
      totalPositions: positions.length,
    };
  }

  // ── Vendi TUTTO lo spot reale sul wallet MEXC (esclude USDT/stablecoin) ───
  async closeAllSpot() {
    const STABLES = new Set(['USDT', 'USDC', 'USD', 'BUSD', 'DAI', 'TUSD']);
    let sold = 0;
    const errors: string[] = [];

    try {
      const balance = await this.spotExchange.fetchBalance();
      const free = balance.free ?? {};

      for (const [asset, amount] of Object.entries(free)) {
        const qty = Number(amount);
        if (!qty || qty <= 0 || STABLES.has(asset)) continue;

        const spotSymbol = `${asset}/USDT`;
        if (!this.spotExchange.markets?.[spotSymbol]) continue;

        try {
          // Verifica valore minimo (~0.5$) usando ultimo prezzo noto
          const rate = this.rates.find(r => r.base === asset);
          const price = rate?.price ?? 0;
          if (price > 0 && qty * price < 0.5) continue;  // dust troppo piccolo

          await this.spotExchange.createMarketSellOrder(spotSymbol, qty);
          this.logger.log(`[CLEANUP SPOT] venduto ${qty} ${asset}`);
          sold++;
        } catch (e: any) {
          errors.push(`${asset}: ${e?.message?.slice(0, 40)}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[CLEANUP SPOT] fetchBalance failed: ${e?.message}`);
      throw new Error(`Vendita spot fallita: ${e?.message}`);
    }

    this.logger.log(`[CLEANUP SPOT] ${sold} asset venduti${errors.length ? ` · errori: ${errors.length}` : ''}`);
    return { sold, errors };
  }

  // ── Chiudi TUTTE le posizioni futures reali su MEXC ──────────────────────
  async closeAllFutures() {
    let closed = 0;
    const errors: string[] = [];

    try {
      const positions = await this.swapExchange.fetchPositions();
      const openPositions = positions.filter((p: any) => Math.abs(Number(p.contracts ?? 0)) > 0);

      for (const pos of openPositions) {
        const symbol = pos.symbol;
        const contracts = Math.abs(Number(pos.contracts));
        const side = pos.side; // 'short' | 'long'
        try {
          // Chiudi: se short → buy, se long → sell
          if (side === 'short') {
            await this.swapExchange.createMarketBuyOrder(symbol, contracts, { reduceOnly: true });
          } else {
            await this.swapExchange.createMarketSellOrder(symbol, contracts, { reduceOnly: true });
          }
          this.logger.log(`[CLEANUP FUT] chiuso ${side} ${contracts} ${symbol}`);
          closed++;
        } catch (e: any) {
          errors.push(`${symbol}: ${e?.message?.slice(0, 40)}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`[CLEANUP FUT] fetchPositions failed: ${e?.message}`);
      throw new Error(`Chiusura futures fallita: ${e?.message}`);
    }

    this.logger.log(`[CLEANUP FUT] ${closed} posizioni chiuse${errors.length ? ` · errori: ${errors.length}` : ''}`);
    return { closed, errors };
  }

  // ── Reset completo: vendi spot + chiudi futures + pulisci DB ──────────────
  async resetAll() {
    const spotRes = await this.closeAllSpot().catch(e => ({ sold: 0, errors: [e.message] }));
    const futRes  = await this.closeAllFutures().catch(e => ({ closed: 0, errors: [e.message] }));

    // Pulisci DB
    await this.prisma.fundingArbPosition.updateMany({
      where: { status: 'open' },
      data: { status: 'closed', closeReason: 'reset_all' },
    });

    this.logger.log(`[RESET] spot venduti=${spotRes.sold} · futures chiusi=${futRes.closed}`);
    return { spotSold: spotRes.sold, futuresClosed: futRes.closed };
  }
}

// ── Tipi ──────────────────────────────────────────────────────────────────────
export interface FundingRate {
  symbol:        string;
  base:          string;
  spotSymbol:    string;
  hasSpot:       boolean;
  price:         number;
  vol24h:        number;
  fundingRate:   number;
  settleHours:   number;  // 4, 8, 12, ecc
  settlePerDay:  number;  // 24 / settleHours
  dailyPct:      number;
  aprPct:        number;
  nextFunding:   string | null;
  timestamp:     string;
}

export interface FundingProjection {
  symbol:           string;
  capitalUsdt:      number;
  notional:         number;
  leverage:         number;
  liquidationPct:   number;
  fundingRate:      number;
  dailyPct:         number;
  aprPct:           number;
  dailyProfit:      number;
  monthlyProfit:    number;
  yearlyProfit:     number;
}
