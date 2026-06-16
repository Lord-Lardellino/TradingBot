import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';

// ── Top-Down Daily ──────────────────────────────────────────────────────────
// UN trade al giorno, intraday (apre e chiude in giornata). Analisi in cascata:
//   1W  -> regime macro (EMA21): non si trada mai contro il settimanale
//   1D  -> bias del giorno (EMA20 vs EMA50 + posizione prezzo): long o short
//   4H  -> conferma momentum (RSI dal lato giusto + EMA20/50 allineate)
//   1H  -> innesco: pullback alla EMA20 1H + break della candela 1H precedente
// SL sullo swing 1H opposto (cap min/max %), size = rischio 5% capitale, TP a 2R
// (+10%). Flatten a mercato a fine giornata UTC. Sim + toggle live (TP/SL nativi MEXC).

@Injectable()
export class DailySniperService implements OnModuleInit {
  private readonly logger = new Logger(DailySniperService.name);
  private exchange: ccxt.mexc;
  private snapshot: any = { ready: false };

  constructor(private config: ConfigService, private prisma: PrismaService) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const has = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({ ...(has ? { apiKey, secret } : {}), enableRateLimit: true, timeout: 15000, options: { defaultType: 'swap' } });
    try { await this.exchange.loadMarkets(); } catch (e: any) { this.logger.warn(`[TD] markets: ${e?.message}`); }
    await this.getConfig();
    this.logger.log('[TD] Top-Down Daily attivo');
  }

  // ── Indicatori ────────────────────────────────────────────────────────────
  private ema(values: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const out: number[] = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  }

  // RSI Wilder
  private rsi(closes: number[], period: number): number[] {
    const out: number[] = new Array(closes.length).fill(NaN);
    if (closes.length < period + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    let avgG = gain / period, avgL = loss / period;
    out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
      avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
    return out;
  }

  private utcDate(d = new Date()): string { return d.toISOString().slice(0, 10); }

  // Giorno di trading ancorato all'apertura di New York: rolla a NY open, non a mezzanotte UTC
  private sessionDay(cfg: any, now = new Date()): string {
    const anchor = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cfg.nyOpenHour, cfg.nyOpenMin, 0);
    const d = now.getTime() >= anchor ? now : new Date(now.getTime() - 86400000);
    return this.utcDate(d);
  }

  // Capitale = saldo MAX disponibile sul conto futures (fallback: cfg.capitalUsdt)
  private async getCapital(cfg: any): Promise<number> {
    try {
      const bal = await this.exchange.fetchBalance({ type: 'swap' });
      const usdt = Number(bal?.USDT?.total ?? bal?.USDT?.free ?? 0);
      if (usdt > 0) return usdt;
    } catch (e: any) { this.logger.warn(`[TD] saldo non letto: ${e?.message?.slice(0, 50)}`); }
    return cfg.capitalUsdt;
  }

  // ── Loop ogni 30s ───────────────────────────────────────────────────────
  @Cron('*/30 * * * * *')
  async tick() {
    try {
      const cfg = await this.getConfig();
      if (!cfg.enabled) return;
      const market = this.exchange.market(cfg.symbol);
      const cs = Number((market as any)?.contractSize ?? 1) || 1;
      const minContracts = Number((market as any)?.limits?.amount?.min ?? 1) || 1;

      const now = new Date();
      const today = this.utcDate(now);
      const sDay = this.sessionDay(cfg, now);   // giorno di trading ancorato a NY open
      const utcH = now.getUTCHours();

      // ── Fetch multi-timeframe ────────────────────────────────────────────
      const [w, d, h4, h1] = await Promise.all([
        this.exchange.fetchOHLCV(cfg.symbol, cfg.weeklyTf, undefined, cfg.emaWeekly + 20),
        this.exchange.fetchOHLCV(cfg.symbol, cfg.dailyTf, undefined, cfg.emaDailySlow + 30),
        this.exchange.fetchOHLCV(cfg.symbol, cfg.h4Tf, undefined, Math.max(cfg.ema4hSlow, cfg.rsiPeriod) + 30),
        this.exchange.fetchOHLCV(cfg.symbol, cfg.h1Tf, undefined, cfg.ema1h + cfg.swingLookback + 20),
      ]);
      if (!w?.length || !d?.length || !h4?.length || !h1?.length) return;

      const price = Number(h1[h1.length - 1][4]);

      // 1W — regime macro (usa candela settimanale CHIUSA)
      const wC = w.map(c => Number(c[4]));
      const eW = this.ema(wC, cfg.emaWeekly);
      const wi = wC.length - 2;
      const weekUp = wC[wi] > eW[wi] && eW[wi] > eW[wi - 1];
      const weekDown = wC[wi] < eW[wi] && eW[wi] < eW[wi - 1];

      // 1D — bias del giorno (candela daily CHIUSA)
      const dC = d.map(c => Number(c[4]));
      const eDF = this.ema(dC, cfg.emaDailyFast);
      const eDS = this.ema(dC, cfg.emaDailySlow);
      const di = dC.length - 2;
      const dayUp = eDF[di] > eDS[di] && dC[di] > eDF[di];
      const dayDown = eDF[di] < eDS[di] && dC[di] < eDF[di];

      // 4H — conferma momentum (candela 4H CHIUSA)
      const h4C = h4.map(c => Number(c[4]));
      const e4F = this.ema(h4C, cfg.ema4h);
      const e4S = this.ema(h4C, cfg.ema4hSlow);
      const r4 = this.rsi(h4C, cfg.rsiPeriod);
      const fi = h4C.length - 2;
      const rsi4 = r4[fi];
      const mom4Up = e4F[fi] > e4S[fi] && rsi4 >= cfg.rsiLongMin;
      const mom4Down = e4F[fi] < e4S[fi] && rsi4 <= cfg.rsiShortMax;

      // Confluence -> direzione del giorno
      const weeklyOkUp = !cfg.requireWeekly || weekUp;
      const weeklyOkDown = !cfg.requireWeekly || weekDown;
      let bias: 'long' | 'short' | 'flat' = 'flat';
      if (weeklyOkUp && dayUp && mom4Up) bias = 'long';
      else if (weeklyOkDown && dayDown && mom4Down) bias = 'short';

      // 1H — innesco: pullback alla EMA20 1H + break candela 1H precedente
      const h1H = h1.map(c => Number(c[2]));
      const h1L = h1.map(c => Number(c[3]));
      const h1C = h1.map(c => Number(c[4]));
      const e1 = this.ema(h1C, cfg.ema1h);
      const ii = h1C.length - 2;          // ultima 1H CHIUSA
      const prev = ii - 1;
      // pullback: una delle ultime 2 candele 1H ha toccato/avvicinato la EMA20
      const tol = 0.0015;
      const pulledLong = (h1L[ii] <= e1[ii] * (1 + tol)) || (h1L[prev] <= e1[prev] * (1 + tol));
      const pulledShort = (h1H[ii] >= e1[ii] * (1 - tol)) || (h1H[prev] >= e1[prev] * (1 - tol));
      // break di struttura: la candela 1H chiusa rompe l'estremo della precedente nella direzione
      const breakUp = h1C[ii] > h1H[prev] && h1C[ii] > e1[ii];
      const breakDown = h1C[ii] < h1L[prev] && h1C[ii] < e1[ii];
      const triggerLong = bias === 'long' && pulledLong && breakUp;
      const triggerShort = bias === 'short' && pulledShort && breakDown;

      const open = await this.prisma.dailySniperTrade.findFirst({ where: { status: 'open' } });
      const lastH1 = h1[h1.length - 1];

      if (open) {
        // se è iniziata una nuova sessione NY (il trade è di un session-day precedente)
        // -> chiudi e rifai analisi nella nuova sessione
        const sessionReset = open.tradeDate !== sDay;
        await this.manageOpen(open, Number(lastH1[2]), Number(lastH1[3]), price, cs, sessionReset);
      } else if (triggerLong || triggerShort) {
        const tradedThisSession = await this.prisma.dailySniperTrade.findFirst({ where: { tradeDate: sDay } });
        if (!tradedThisSession) {
          const side = triggerLong ? 'long' : 'short';
          await this.openTrade(side, cfg, price, h1L, h1H, ii, sDay, cs, minContracts);
        }
      }

      this.snapshot = {
        ready: true, ts: Date.now(), symbol: cfg.symbol, price, utcHour: utcH, today,
        weekly: { up: weekUp, down: weekDown, ema: +eW[wi].toFixed(2) },
        daily: { up: dayUp, down: dayDown, emaFast: +eDF[di].toFixed(2), emaSlow: +eDS[di].toFixed(2) },
        h4: { up: mom4Up, down: mom4Down, rsi: +Number(rsi4).toFixed(1), emaFast: +e4F[fi].toFixed(2), emaSlow: +e4S[fi].toFixed(2) },
        h1: { ema20: +e1[ii].toFixed(2), pulledLong, pulledShort, breakUp, breakDown },
        bias, trigger: triggerLong ? 'long' : triggerShort ? 'short' : null,
        windowOpen: utcH < cfg.flattenHour,
      };
    } catch (e: any) { this.logger.warn(`[TD] tick: ${e?.message?.slice(0, 90)}`); }
  }

  private async manageOpen(t: any, high: number, low: number, price: number, cs: number, sessionReset: boolean) {
    const dir = t.side === 'long' ? 1 : -1;
    const hitTp = t.side === 'long' ? high >= t.takeProfit : low <= t.takeProfit;
    const hitSl = t.side === 'long' ? low <= t.stopLoss : high >= t.stopLoss;

    if (t.mode === 'live') {
      let stillOpen = true;
      try { stillOpen = (await this.exchange.fetchPositions([t.symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0).length > 0; } catch { return; }
      if (stillOpen && !hitTp && !hitSl && !sessionReset) return;     // lascia lavorare TP/SL nativi
      if (stillOpen) {
        try {
          if (t.side === 'long') await this.exchange.createMarketSellOrder(t.symbol, t.qty, { reduceOnly: true });
          else await this.exchange.createMarketBuyOrder(t.symbol, t.qty, { reduceOnly: true });
        } catch (e: any) { this.logger.warn(`[TD LIVE] close: ${e?.message?.slice(0, 40)}`); }
      }
      try { for (const o of await this.exchange.fetchOpenOrders(t.symbol)) { try { await this.exchange.cancelOrder(o.id, t.symbol); } catch {} } } catch {}
      try { await this.exchange.cancelAllOrders(t.symbol, { trigger: true }); } catch {}
      const reason = hitTp ? 'tp' : hitSl ? 'sl' : 'session';
      const exit = hitTp ? t.takeProfit : hitSl ? t.stopLoss : price;
      const pnl = (exit - t.entry) * dir * t.qty * cs;
      await this.prisma.dailySniperTrade.update({ where: { id: t.id }, data: { status: hitTp ? 'win' : (reason === 'session' ? 'manual' : 'loss'), exitPrice: exit, pnl, rMultiple: t.riskUsd > 0 ? pnl / t.riskUsd : 0, reason, closedAt: new Date() } });
      this.logger.log(`[TD LIVE] ${t.side} CHIUSO ${reason.toUpperCase()} · ${t.entry} → ${exit} · $${pnl.toFixed(4)}`);
      return;
    }

    if (!hitTp && !hitSl && !sessionReset) return;
    const reason = hitTp ? 'tp' : hitSl ? 'sl' : 'session';
    const exit = hitTp ? t.takeProfit : hitSl ? t.stopLoss : price;
    const pnl = (exit - t.entry) * dir * t.qty * cs;
    await this.prisma.dailySniperTrade.update({ where: { id: t.id }, data: { status: hitTp ? 'win' : (reason === 'session' ? 'manual' : 'loss'), exitPrice: exit, pnl, rMultiple: t.riskUsd > 0 ? pnl / t.riskUsd : 0, reason, closedAt: new Date() } });
    this.logger.log(`[TD SIM] ${t.side} CHIUSO ${reason.toUpperCase()} · ${t.entry} → ${exit} · $${pnl.toFixed(4)}`);
  }

  private async openTrade(side: 'long' | 'short', cfg: any, entry: number, lows: number[], highs: number[], i: number, today: string, cs: number, minContracts: number) {
    const look = cfg.swingLookback;
    const swing = side === 'long'
      ? Math.min(...lows.slice(i - look + 1, i + 1))
      : Math.max(...highs.slice(i - look + 1, i + 1));
    // buffer extra oltre lo swing -> SL leggermente piu largo (meno spike-out)
    const rawDist = (side === 'long' ? entry - swing : swing - entry) + entry * (cfg.slBufferPct / 100);
    const minDist = entry * (cfg.minStopPct / 100);
    const maxDist = entry * (cfg.maxStopPct / 100);
    const slDist = Math.min(Math.max(rawDist, minDist), maxDist);
    if (slDist <= 0) return;
    const sl = side === 'long' ? entry - slDist : entry + slDist;
    const tp = side === 'long' ? entry + cfg.riskReward * slDist : entry - cfg.riskReward * slDist;

    const capital = await this.getCapital(cfg);   // sempre capitale max del conto
    const riskUsd = capital * (cfg.riskPct / 100);
    const qty = Math.max(minContracts, Math.round(riskUsd / (slDist * cs)));
    const realRiskUsd = slDist * qty * cs;
    const mode = cfg.liveEnabled ? 'live' : 'sim';

    if (mode === 'live') {
      const pt = side === 'long' ? 1 : 2;
      const tpPx = Number(this.exchange.priceToPrecision(cfg.symbol, tp));
      const slPx = Number(this.exchange.priceToPrecision(cfg.symbol, sl));
      try {
        await this.exchange.setLeverage(cfg.leverage, cfg.symbol, { openType: 1, positionType: pt }).catch(() => {});
        if (side === 'long') await this.exchange.createMarketBuyOrder(cfg.symbol, qty, { openType: 1, positionType: 1, leverage: cfg.leverage });
        else await this.exchange.createMarketSellOrder(cfg.symbol, qty, { openType: 1, positionType: 2, leverage: cfg.leverage });
      } catch (e: any) { this.logger.warn(`[TD LIVE] apertura saltata: ${e?.message?.slice(0, 60)}`); return; }
      try {
        await new Promise((r) => setTimeout(r, 800));
        const pos = (await this.exchange.fetchPositions([cfg.symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0)[0];
        const positionId = pos?.info?.positionId;
        const posVol = Math.abs(Number(pos?.contracts ?? qty));
        const mexcSymbol = (this.exchange.market(cfg.symbol) as any).id;
        if (positionId) {
          await (this.exchange as any).contractPrivatePostStoporderPlace({ symbol: mexcSymbol, positionId, vol: posVol, stopLossPrice: slPx, takeProfitPrice: tpPx });
          this.logger.log(`[TD LIVE] TP/SL attaccati · posId ${positionId} · SL ${slPx} · TP ${tpPx}`);
        } else { this.logger.warn('[TD LIVE] positionId non trovato — SL/TP non attaccati'); }
      } catch (e: any) { this.logger.warn(`[TD LIVE] SL/TP: ${e?.message?.slice(0, 70)}`); }
    }

    await this.prisma.dailySniperTrade.create({
      data: { symbol: cfg.symbol, side, mode, tradeDate: today, entry, stopLoss: +sl.toFixed(2), takeProfit: +tp.toFixed(2), qty, leverage: cfg.leverage, riskUsd: realRiskUsd },
    });
    this.logger.log(`[TD ${mode.toUpperCase()}] ${side.toUpperCase()} APERTO · entry ${entry.toFixed(2)} · SL ${sl.toFixed(2)} · TP ${tp.toFixed(2)} · rischio $${realRiskUsd.toFixed(2)} (${cfg.riskPct}%) · qty ${qty}`);
  }

  // Chiude QUALSIASI posizione aperta sul symbol (anche aperta a mano) + ordini trigger
  private async closeExchangePosition(symbol: string) {
    try {
      const positions = (await this.exchange.fetchPositions([symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      for (const p of positions) {
        const vol = Math.abs(Number(p.contracts));
        const isLong = (p.side === 'long') || Number(p.contracts) > 0;
        try {
          if (isLong) await this.exchange.createMarketSellOrder(symbol, vol, { reduceOnly: true });
          else await this.exchange.createMarketBuyOrder(symbol, vol, { reduceOnly: true });
          this.logger.log(`[TD] posizione esistente chiusa · ${isLong ? 'long' : 'short'} vol ${vol}`);
        } catch (e: any) { this.logger.warn(`[TD] chiusura pos: ${e?.message?.slice(0, 50)}`); }
      }
    } catch (e: any) { this.logger.warn(`[TD] fetchPositions: ${e?.message?.slice(0, 50)}`); }
    try { for (const o of await this.exchange.fetchOpenOrders(symbol)) { try { await this.exchange.cancelOrder(o.id, symbol); } catch {} } } catch {}
    try { await this.exchange.cancelAllOrders(symbol, { trigger: true }); } catch {}
  }

  // Entrata FORZATA: chiude posizioni esistenti e apre subito nella direzione dei TF
  // alti (1D, fallback 1W) ignorando sessione/giorno. Per "previsione di stamattina".
  async forceEntry(sideOverride?: 'long' | 'short') {
    const cfg = await this.getConfig();
    const market = this.exchange.market(cfg.symbol);
    const cs = Number((market as any)?.contractSize ?? 1) || 1;
    const minContracts = Number((market as any)?.limits?.amount?.min ?? 1) || 1;

    // chiudi eventuale trade del bot già tracciato + posizione reale sull'exchange
    const existing = await this.prisma.dailySniperTrade.findFirst({ where: { status: 'open' } });
    if (existing) await this.prisma.dailySniperTrade.update({ where: { id: existing.id }, data: { status: 'manual', reason: 'replaced', closedAt: new Date() } });
    if (cfg.liveEnabled) await this.closeExchangePosition(cfg.symbol);

    // direzione: override -> snapshot daily -> snapshot weekly
    let side: 'long' | 'short' | undefined = sideOverride;
    if (!side) {
      const d = this.snapshot?.daily, w = this.snapshot?.weekly;
      if (d?.up) side = 'long'; else if (d?.down) side = 'short';
      else if (w?.up) side = 'long'; else if (w?.down) side = 'short';
    }
    if (!side) return { opened: false, reason: 'direzione non determinabile (TF neutri)' };

    const h1 = await this.exchange.fetchOHLCV(cfg.symbol, cfg.h1Tf, undefined, cfg.swingLookback + 10);
    if (!h1?.length) return { opened: false, reason: 'no candele 1H' };
    const lows = h1.map(c => Number(c[3]));
    const highs = h1.map(c => Number(c[2]));
    const price = Number(h1[h1.length - 1][4]);
    const i = h1.length - 2;
    const sDay = this.sessionDay(cfg);

    await this.openTrade(side, cfg, price, lows, highs, i, sDay, cs, minContracts);
    const open = await this.prisma.dailySniperTrade.findFirst({ where: { status: 'open' } });
    return { opened: !!open, side, trade: open };
  }

  // ── API ─────────────────────────────────────────────────────────────────
  async getConfig() {
    let cfg = await this.prisma.dailySniperConfig.findUnique({ where: { id: 1 } });
    if (!cfg) cfg = await this.prisma.dailySniperConfig.create({ data: { id: 1 } });
    return cfg;
  }

  async updateConfig(patch: any) {
    const allowed = ['enabled', 'liveEnabled', 'symbol', 'weeklyTf', 'dailyTf', 'h4Tf', 'h1Tf', 'emaWeekly', 'emaDailyFast', 'emaDailySlow', 'ema4h', 'ema4hSlow', 'ema1h', 'rsiPeriod', 'rsiLongMin', 'rsiShortMax', 'swingLookback', 'requireWeekly', 'riskReward', 'capitalUsdt', 'riskPct', 'leverage', 'maxStopPct', 'minStopPct', 'slBufferPct', 'nyOpenHour', 'nyOpenMin', 'flattenHour'];
    const data: any = {};
    for (const k of allowed) if (patch[k] !== undefined) data[k] = patch[k];
    await this.getConfig();
    return this.prisma.dailySniperConfig.update({ where: { id: 1 }, data });
  }

  async getDashboard() {
    const [config, openTrade, recent, all] = await Promise.all([
      this.getConfig(),
      this.prisma.dailySniperTrade.findFirst({ where: { status: 'open' }, orderBy: { openedAt: 'desc' } }),
      this.prisma.dailySniperTrade.findMany({ where: { status: { not: 'open' } }, orderBy: { closedAt: 'desc' }, take: 30 }),
      this.prisma.dailySniperTrade.findMany({ where: { status: { not: 'open' } } }),
    ]);
    const wins = all.filter(t => t.status === 'win');
    const losses = all.filter(t => t.status === 'loss');
    const closed = all.length;
    const pnl = all.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalR = all.reduce((s, t) => s + (t.rMultiple ?? 0), 0);

    let openEnriched: any = openTrade;
    if (openTrade && this.snapshot?.price) {
      let cs = 1;
      try { cs = Number((this.exchange.market(openTrade.symbol) as any)?.contractSize ?? 1) || 1; } catch {}
      const dir = openTrade.side === 'long' ? 1 : -1;
      const livePnl = (this.snapshot.price - openTrade.entry) * dir * openTrade.qty * cs;
      openEnriched = { ...openTrade, livePnl: +livePnl.toFixed(4), liveR: openTrade.riskUsd ? +(livePnl / openTrade.riskUsd).toFixed(2) : 0 };
    }
    return {
      config, market: this.snapshot, openTrade: openEnriched, recent,
      stats: {
        closed, wins: wins.length, losses: losses.length,
        winRate: closed ? +(wins.length / closed * 100).toFixed(1) : 0,
        pnl: +pnl.toFixed(4), totalR: +totalR.toFixed(2),
      },
    };
  }

  async closeOpenManual() {
    const open = await this.prisma.dailySniperTrade.findFirst({ where: { status: 'open' } });
    if (!open) return { closed: false };
    const price = this.snapshot?.price ?? open.entry;
    const market = this.exchange.market(open.symbol);
    const cs = Number((market as any)?.contractSize ?? 1) || 1;
    const dir = open.side === 'long' ? 1 : -1;
    const pnl = (price - open.entry) * dir * open.qty * cs;
    if (open.mode === 'live') {
      try {
        if (open.side === 'long') await this.exchange.createMarketSellOrder(open.symbol, open.qty, { reduceOnly: true });
        else await this.exchange.createMarketBuyOrder(open.symbol, open.qty, { reduceOnly: true });
      } catch {}
      try { await this.exchange.cancelAllOrders(open.symbol, { trigger: true }); } catch {}
    }
    await this.prisma.dailySniperTrade.update({ where: { id: open.id }, data: { status: 'manual', exitPrice: price, pnl, rMultiple: open.riskUsd ? pnl / open.riskUsd : 0, reason: 'manual', closedAt: new Date() } });
    return { closed: true, pnl };
  }

  async reset() {
    await this.closeOpenManual().catch(() => {});
    const res = await this.prisma.dailySniperTrade.deleteMany({});
    return { removed: res.count };
  }
}
