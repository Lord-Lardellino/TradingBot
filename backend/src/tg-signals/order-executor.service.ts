import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';

// ── Motore ordini parametrico ───────────────────────────────────────────────
// Estratto/generalizzato dal modulo daily-sniper: stesso flusso di apertura
// (setLeverage → market/limit order → SL/TP nativi via contractPrivatePostStoporderPlace
// con positionId) ma parametrico su (symbol, side, entry, sl, tp[]...).
// Differenza chiave: TP MULTIPLI → uno stop-order nativo PARZIALE per ogni TP
// (vol ripartito), più 1 SL nativo sul volume totale.

export interface ExecParams {
  symbol: string;            // simbolo MEXC già normalizzato (BTC/USDT:USDT)
  side: 'long' | 'short';
  entryType: 'market' | 'limit';
  entryPrice?: number;       // richiesto per limit; per market è solo riferimento
  sl: number;
  tps: number[];             // uno o più take-profit (prezzi)
  tpSplit: number[];         // ripartizione % volume sui TP (es. [50,30,20])
  riskPct: number;           // % capitale a rischio
  leverage: number;          // leva già cappata a levaMax dal chiamante
}

export interface ExecResult {
  ok: boolean;
  qty?: number;
  entry?: number;
  riskUsd?: number;
  positionId?: string;
  preset?: boolean;          // SL/TP preimpostati sull'ordine (limit non ancora riempito)
  error?: string;
}

export interface LivePositionSnapshot {
  positionId?: string;
  contracts: number;
  entryPrice?: number;
  markPrice?: number;
}

@Injectable()
export class OrderExecutorService implements OnModuleInit {
  private readonly logger = new Logger(OrderExecutorService.name);
  private exchange: ccxt.mexc;
  private ready = false;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const has = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({ ...(has ? { apiKey, secret } : {}), enableRateLimit: true, timeout: 15000, options: { defaultType: 'swap' } });
    try { await this.exchange.loadMarkets(); this.ready = true; } catch (e: any) { this.logger.warn(`[ORD] markets: ${e?.message}`); }
  }

  isReady() { return this.ready; }

  // ── Normalizzazione simbolo ───────────────────────────────────────────────
  // "BTC" | "btcusdt" | "BTC/USDT" | "BTC-USDT" → "BTC/USDT:USDT" se esiste su MEXC swap.
  resolveSymbol(raw: string): string | null {
    if (!raw) return null;
    const s = raw.trim().toUpperCase();
    const direct = this.tryMarket(s) || this.tryMarket(`${s}:USDT`);
    if (direct) return direct;
    // estrai la base (toglie USDT/PERP/suffissi e separatori)
    const base = s.replace(/[\/\-_: ]/g, '').replace(/USDT.*$/, '').replace(/PERP$/, '');
    if (!base) return null;
    return this.tryMarket(`${base}/USDT:USDT`);
  }

  private tryMarket(sym: string): string | null {
    try { const m = this.exchange.market(sym); return m ? m.symbol : null; } catch { return null; }
  }

  private marketMeta(symbol: string): { cs: number; minContracts: number } {
    const m = this.exchange.market(symbol) as any;
    return { cs: Number(m?.contractSize ?? 1) || 1, minContracts: Number(m?.limits?.amount?.min ?? 1) || 1 };
  }

  // Capitale = saldo MAX disponibile sul conto futures
  async getCapital(fallback = 100): Promise<number> {
    try {
      const bal = await this.exchange.fetchBalance({ type: 'swap' });
      const usdt = Number(bal?.USDT?.total ?? bal?.USDT?.free ?? 0);
      if (usdt > 0) return usdt;
    } catch (e: any) { this.logger.warn(`[ORD] saldo non letto: ${e?.message?.slice(0, 50)}`); }
    return fallback;
  }

  // Saldo LIBERO (disponibile) sul conto futures — base per il margine dinamico.
  async getFreeBalance(): Promise<number> {
    try {
      const bal = await this.exchange.fetchBalance({ type: 'swap' });
      return Number(bal?.USDT?.free ?? bal?.USDT?.total ?? 0) || 0;
    } catch (e: any) { this.logger.warn(`[ORD] saldo libero non letto: ${e?.message?.slice(0, 50)}`); return 0; }
  }

  // % del saldo LIBERO usata come margine per ogni trade (margine dinamico).
  private static readonly MARGIN_PCT = 0.25;

  // Sizing a MARGINE: notional = margine(= MARGIN_PCT del libero) × leva (del segnale).
  // qty in contratti = notional / (entry × contractSize). Cosi i gain seguono la leva
  // del segnale e la size scala con l'account.
  async sizeByMargin(symbol: string, entry: number, lev: number): Promise<{ qty: number; margin: number; notional: number; cs: number }> {
    const { cs, minContracts } = this.marketMeta(symbol);
    const free = await this.getFreeBalance();
    const margin = free * OrderExecutorService.MARGIN_PCT;
    const notional = margin * Math.max(1, lev);
    const qty = (entry > 0 && cs > 0 && notional > 0) ? Math.max(minContracts, Math.floor(notional / (entry * cs))) : minContracts;
    return { qty, margin, notional, cs };
  }

  async getPrice(symbol: string): Promise<number | null> {
    try { const t = await this.exchange.fetchTicker(symbol); return Number(t?.last ?? t?.close ?? 0) || null; } catch { return null; }
  }

  async getOpenPosition(symbol: string, side?: 'long' | 'short'): Promise<LivePositionSnapshot | null> {
    const positions = (await this.exchange.fetchPositions([symbol]))
      .filter((x: any) => Math.abs(Number(x.contracts || 0)) > 0);
    const pos = side
      ? positions.find((x: any) => (x.side === side) || (side === 'long' ? Number(x.contracts) > 0 : Number(x.contracts) < 0))
      : positions[0];
    if (!pos) return null;
    return {
      positionId: pos?.info?.positionId ? String(pos.info.positionId) : undefined,
      contracts: Math.abs(Number(pos.contracts ?? 0)),
      entryPrice: Number(pos.entryPrice ?? pos.info?.openAvgPrice ?? 0) || undefined,
      markPrice: Number(pos.markPrice ?? pos.info?.markPrice ?? 0) || undefined,
    };
  }

  async hasOpenOrder(symbol: string): Promise<boolean> {
    try {
      const orders = await this.exchange.fetchOpenOrders(symbol, undefined, undefined, { type: 'swap' });
      return orders.some((o: any) => String(o.status ?? '').toLowerCase() === 'open' || Number(o.remaining ?? 0) > 0);
    } catch (e: any) {
      this.logger.warn(`[ORD LIVE] open orders ${symbol}: ${e?.message?.slice(0, 70)}`);
      return true;
    }
  }

  // Stop order (SL/TP) attivi sulla posizione: se ce ne sono, la posizione è viva.
  // Serve a NON dichiarare "no_fill" quando il limit si è riempito (i filled hanno
  // solo stop order, non ordini normali) e fetchPositions ha un singhiozzo transitorio.
  async listStopOrders(symbol: string, positionId?: string): Promise<any[]> {
    try {
      const id = (this.exchange.market(symbol) as any).id;
      const r = await (this.exchange as any).contractPrivateGetStoporderOpenOrders({ symbol: id });
      const arr = (r && r.data) || [];
      const list = Array.isArray(arr) ? arr : [];
      return positionId ? list.filter((o: any) => String(o.positionId ?? '') === String(positionId)) : list;
    } catch { return [{ unknown: true }]; }   // nel dubbio non chiudere
  }

  async hasStopOrders(symbol: string, positionId?: string): Promise<boolean> {
    return (await this.listStopOrders(symbol, positionId)).length > 0;
  }

  async hasProtection(symbol: string, positionId: string | undefined, needsTp: boolean): Promise<boolean> {
    const orders = await this.listStopOrders(symbol, positionId);
    if (orders.some((o: any) => o.unknown)) return true;
    const hasSl = orders.some((o: any) => o.stopLossPrice != null && String(o.stopLossPrice) !== '');
    const hasTp = orders.some((o: any) => o.takeProfitPrice != null && String(o.takeProfitPrice) !== '');
    return hasSl && (!needsTp || hasTp);
  }

  // Dimensiona la quantità in contratti dato il rischio (entry-SL).
  async sizeQty(symbol: string, entry: number, sl: number, riskPct: number, capitalFallback = 100): Promise<{ qty: number; riskUsd: number; cs: number }> {
    const { cs, minContracts } = this.marketMeta(symbol);
    const slDist = Math.abs(entry - sl);
    const capital = await this.getCapital(capitalFallback);
    const riskUsd = capital * (riskPct / 100);
    const qty = slDist > 0 ? Math.max(minContracts, Math.round(riskUsd / (slDist * cs))) : minContracts;
    return { qty, riskUsd: slDist * qty * cs, cs };
  }

  // ── Apertura LIVE su MEXC ─────────────────────────────────────────────────
  async openLive(p: ExecParams): Promise<ExecResult> {
    const { symbol, side } = p;
    const positionType = side === 'long' ? 1 : 2;
    const entryRef = p.entryType === 'limit' && p.entryPrice ? p.entryPrice : p.entryPrice ?? (await this.getPrice(symbol)) ?? 0;
    if (!entryRef) return { ok: false, error: 'prezzo entry non disponibile' };

    // Leva SL-SAFE: cappa la leva del segnale cosi' la liquidazione resta OLTRE lo SL
    // (lo SL del segnale diventa un vero stop, perdita ~margine). safe = 0.8×entry/distanza-SL.
    const slDist = Math.abs(entryRef - p.sl);
    const safeLev = slDist > 0 ? Math.max(1, Math.floor((entryRef / slDist) * 0.8)) : Math.max(1, Math.round(p.leverage || 1));
    const lev = Math.max(1, Math.min(Math.round(p.leverage || safeLev), safeLev));
    const { qty, cs } = await this.sizeByMargin(symbol, entryRef, lev);
    if (qty <= 0) return { ok: false, error: 'qty = 0 (saldo libero insufficiente?)' };
    const riskUsd = Math.abs(entryRef - p.sl) * qty * cs;   // perdita stimata se va allo SL

    try {
      await this.exchange.setLeverage(lev, symbol, { openType: 1, positionType }).catch(() => {});
      const params: any = { openType: 1, positionType, leverage: lev };
      if (p.entryType === 'limit' && p.entryPrice) {
        const px = Number(this.exchange.priceToPrecision(symbol, p.entryPrice));
        // SL PREIMPOSTATO sull'ordine limit (MEXC lo accetta su order/create): così la
        // posizione è protetta dall'istante del fill. I TP PARZIALI non possono stare su
        // un ordine non riempito (servono positionId+vol) → vengono attaccati al fill dal
        // monitor (attachStops: SL + N TP parziali). Niente TP unico qui (andrebbe in
        // conflitto coi parziali).
        params.stopLossPrice = Number(this.exchange.priceToPrecision(symbol, p.sl));
        if (side === 'long') await this.exchange.createLimitBuyOrder(symbol, qty, px, params);
        else await this.exchange.createLimitSellOrder(symbol, qty, px, params);
        this.logger.log(`[ORD LIVE] LIMIT ${side.toUpperCase()} ${symbol} qty ${qty} @ ${px} · SL preimpostato ${params.stopLossPrice} · TP parziali al fill`);
        return { ok: true, qty, entry: px, riskUsd, preset: true };
      } else {
        if (side === 'long') await this.exchange.createMarketBuyOrder(symbol, qty, params);
        else await this.exchange.createMarketSellOrder(symbol, qty, params);
      }
    } catch (e: any) {
      return { ok: false, error: `apertura: ${e?.message?.slice(0, 80)}` };
    }

    // Market order: posizione immediata → attacca SL nativo + N TP parziali.
    let positionId: string | undefined;
    try {
      await new Promise((r) => setTimeout(r, 800));
      positionId = await this.attachStops(symbol, side, qty, p.sl, p.tps, p.tpSplit);
    } catch (e: any) { this.logger.warn(`[ORD LIVE] SL/TP: ${e?.message?.slice(0, 70)}`); }
    this.logger.log(`[ORD LIVE] ${side.toUpperCase()} ${symbol} qty ${qty} entry~${entryRef} SL ${p.sl} TP ${p.tps.join('/')} rischio $${riskUsd.toFixed(2)}`);
    return { ok: true, qty, entry: entryRef, riskUsd, positionId };
  }

  // Attacca 1 SL pieno + N TP parziali (vol ripartito su tpSplit). SL e TP su MEXC sono
  // pool SEPARATI, quindi SL_pieno + TP_parziali è valido. IMPORTANTE: prima azzerare gli
  // stop order esistenti (preset al fill / update), altrimenti i volumi si sommano → 5004.
  async attachStops(symbol: string, side: 'long' | 'short', qty: number, sl: number, tps: number[], tpSplit: number[]): Promise<string | undefined> {
    const pos = await this.getOpenPosition(symbol, side);
    const positionId = pos?.positionId;
    const posVol = Math.abs(Number(pos?.contracts ?? qty));
    const mexcSymbol = (this.exchange.market(symbol) as any).id;
    if (!positionId) { this.logger.warn('[ORD LIVE] positionId non trovato — SL/TP non attaccati'); return undefined; }

    const slPx = Number(this.exchange.priceToPrecision(symbol, sl));
    const refPrice = pos?.markPrice ?? (await this.getPrice(symbol)) ?? pos?.entryPrice;
    if (refPrice && !this.protectionIsValid(side, refPrice, slPx, tps)) {
      throw new Error(`protection_invalid ${symbol}: price=${refPrice} sl=${slPx} tp=${tps.join('/')}`);
    }

    // azzera eventuali stop order già presenti (preset al fill / update SL) per non sommare i volumi
    try { await (this.exchange as any).contractPrivatePostStoporderCancelAll({ symbol: mexcSymbol }); await new Promise((r) => setTimeout(r, 500)); } catch {}

    // 1 SL pieno sul volume totale
    await (this.exchange as any).contractPrivatePostStoporderPlace({ symbol: mexcSymbol, positionId, vol: posVol, stopLossPrice: slPx });
    if (!tps?.length) {
      this.logger.log(`[ORD LIVE] SL attaccato (no TP) · posId ${positionId} · SL ${slPx}`);
      return positionId;
    }

    // N TP parziali: ripartisci posVol sui pesi tpSplit
    const weights = this.normalizeSplit(tpSplit, tps.length);
    let allocated = 0;
    let placed = 0;
    for (let i = 0; i < tps.length; i++) {
      const isLast = i === tps.length - 1;
      const vol = isLast ? Math.max(1, posVol - allocated) : Math.max(1, Math.round(posVol * weights[i]));
      allocated += vol;
      const tpPx = Number(this.exchange.priceToPrecision(symbol, tps[i]));
      try {
        await (this.exchange as any).contractPrivatePostStoporderPlace({ symbol: mexcSymbol, positionId, vol, takeProfitPrice: tpPx });
        placed++;
      } catch (e: any) { this.logger.warn(`[ORD LIVE] TP${i + 1}: ${e?.message?.slice(0, 50)}`); }
    }
    if (!placed) throw new Error(`protection_failed_tp ${symbol}`);
    this.logger.log(`[ORD LIVE] 1 SL + ${placed} TP parziali attaccati · posId ${positionId} · SL ${slPx} · TP ${tps.join('/')}`);
    return positionId;
  }

  // pesi normalizzati (somma 1) per n TP, partendo da split tipo [50,30,20]
  protectionIsValid(side: 'long' | 'short', reference: number, sl: number, tps: number[]) {
    if (!Number.isFinite(reference) || reference <= 0) return true;
    if (side === 'long') {
      if (sl >= reference) return false;
      return tps.some((tp) => Number(tp) > reference);
    }
    if (sl <= reference) return false;
    return tps.some((tp) => Number(tp) < reference);
  }

  private normalizeSplit(split: number[], n: number): number[] {
    const base = (split && split.length ? split : [50, 30, 20]).slice(0, n);
    while (base.length < n) base.push(base.length ? base[base.length - 1] : 100 / n);
    const sum = base.reduce((s, x) => s + x, 0) || 1;
    return base.map((x) => x / sum);
  }

  // ── Chiusura LIVE: market reduceOnly su tutta la posizione + cancel trigger ─
  async closeLive(symbol: string, side: 'long' | 'short', qty?: number): Promise<{ ok: boolean; error?: string }> {
    const wantedOrderSide = side === 'long' ? 'buy' : 'sell';
    const closeSide = side === 'long' ? 'sell' : 'buy';
    const mexcSymbol = (this.exchange.market(symbol) as any).id;
    let positionId: string | undefined;

    try {
      const positions = (await this.exchange.fetchPositions([symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      for (const pos of positions) {
        const vol = Math.abs(Number(pos.contracts));
        const isLong = (pos.side === 'long') || Number(pos.contracts) > 0;
        if ((side === 'long') !== isLong) continue;
        positionId = pos?.info?.positionId ? String(pos.info.positionId) : undefined;
        await this.exchange.createOrder(symbol, 'market', closeSide, qty ?? vol, undefined, { reduceOnly: true });
      }
    } catch (e: any) { return { ok: false, error: e?.message?.slice(0, 80) }; }

    try {
      for (const o of await this.exchange.fetchOpenOrders(symbol, undefined, undefined, { type: 'swap' })) {
        if (o.side !== wantedOrderSide) continue;
        try { await this.exchange.cancelOrder(o.id, symbol); } catch {}
      }
    } catch {}

    if (positionId) {
      try {
        for (const o of await this.listStopOrders(symbol, positionId)) {
          if (o.unknown) continue;
          const stopOrderId = o.id ?? o.stopOrderId;
          if (stopOrderId) {
            try { await (this.exchange as any).contractPrivatePostStoporderCancel({ symbol: mexcSymbol, stopOrderId }); } catch {}
          }
        }
      } catch {}
    }

    return { ok: true };
  }
}
