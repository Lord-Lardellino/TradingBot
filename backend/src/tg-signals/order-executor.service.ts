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
    const entryRef = p.entryType === 'limit' && p.entryPrice ? p.entryPrice : (await this.getPrice(symbol)) ?? p.entryPrice ?? 0;
    if (!entryRef) return { ok: false, error: 'prezzo entry non disponibile' };

    const { qty, riskUsd } = await this.sizeQty(symbol, entryRef, p.sl, p.riskPct);
    if (qty <= 0) return { ok: false, error: 'qty calcolata = 0' };

    try {
      await this.exchange.setLeverage(p.leverage, symbol, { openType: 1, positionType }).catch(() => {});
      const params: any = { openType: 1, positionType, leverage: p.leverage };
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

  // Attacca SL + N TP parziali. IMPORTANTE: MEXC SOMMA i volumi degli stop order
  // (code 5004 se SL_pieno + TP_parziali > posizione). Pattern corretto: N stop order,
  // ognuno con la SUA fetta di volume che porta SIA lo stesso SL SIA il proprio TP
  // (totale vol = posizione). Così ogni chunk ha TP+SL e i parziali funzionano.
  async attachStops(symbol: string, side: 'long' | 'short', qty: number, sl: number, tps: number[], tpSplit: number[]): Promise<string | undefined> {
    const pos = await this.getOpenPosition(symbol, side);
    const positionId = pos?.positionId;
    const posVol = Math.abs(Number(pos?.contracts ?? qty));
    const mexcSymbol = (this.exchange.market(symbol) as any).id;
    if (!positionId) { this.logger.warn('[ORD LIVE] positionId non trovato — SL/TP non attaccati'); return undefined; }

    const slPx = Number(this.exchange.priceToPrecision(symbol, sl));
    const refPrice = pos?.markPrice ?? pos?.entryPrice ?? await this.getPrice(symbol);
    if (refPrice && !this.protectionIsValid(side, refPrice, slPx, tps)) {
      throw new Error(`protection_invalid ${symbol}: price=${refPrice} sl=${slPx} tp=${tps.join('/')}`);
    }

    // azzera eventuali stop order già presenti (preset al fill / update SL) per non sommare i volumi
    try { await (this.exchange as any).contractPrivatePostStoporderCancelAll({ symbol: mexcSymbol }); await new Promise((r) => setTimeout(r, 400)); } catch {}

    // nessun TP → solo SL sul volume totale
    if (!tps?.length) {
      await (this.exchange as any).contractPrivatePostStoporderPlace({ symbol: mexcSymbol, positionId, vol: posVol, stopLossPrice: slPx });
      this.logger.log(`[ORD LIVE] SL attaccato (no TP) · posId ${positionId} · SL ${slPx}`);
      return positionId;
    }

    // N chunk: vol ripartito su tpSplit, ognuno con SL + il proprio TP (totale = posVol)
    const weights = this.normalizeSplit(tpSplit, tps.length);
    let allocated = 0;
    let placed = 0;
    for (let i = 0; i < tps.length; i++) {
      const isLast = i === tps.length - 1;
      const vol = isLast ? Math.max(1, posVol - allocated) : Math.max(1, Math.round(posVol * weights[i]));
      allocated += vol;
      const tpPx = Number(this.exchange.priceToPrecision(symbol, tps[i]));
      try {
        await (this.exchange as any).contractPrivatePostStoporderPlace({ symbol: mexcSymbol, positionId, vol, stopLossPrice: slPx, takeProfitPrice: tpPx });
        placed++;
      } catch (e: any) { this.logger.warn(`[ORD LIVE] chunk TP${i + 1}: ${e?.message?.slice(0, 50)}`); }
    }
    if (!placed) throw new Error(`protection_failed ${symbol}`);
    this.logger.log(`[ORD LIVE] SL+TP parziali attaccati · posId ${positionId} · SL ${slPx} · TP ${tps.join('/')} · chunk ${placed}/${tps.length}`);
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
    try {
      const positions = (await this.exchange.fetchPositions([symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      for (const pos of positions) {
        const vol = Math.abs(Number(pos.contracts));
        const isLong = (pos.side === 'long') || Number(pos.contracts) > 0;
        if (isLong) await this.exchange.createMarketSellOrder(symbol, vol, { reduceOnly: true });
        else await this.exchange.createMarketBuyOrder(symbol, vol, { reduceOnly: true });
      }
    } catch (e: any) { return { ok: false, error: e?.message?.slice(0, 80) }; }
    try { for (const o of await this.exchange.fetchOpenOrders(symbol)) { try { await this.exchange.cancelOrder(o.id, symbol); } catch {} } } catch {}
    try { await this.exchange.cancelAllOrders(symbol, { trigger: true }); } catch {}
    return { ok: true };
  }
}
