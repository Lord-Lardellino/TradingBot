import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';

// ── 3 EMA Scalper (BTCUSDT 1m) ──────────────────────────────────────────────
// Trend filtrato da 3 EMA allineate+inclinate (50/100/200). Ingresso sul PULLBACK:
// il prezzo rintraccia verso la EMA veloce senza rompere la EMA lenta, poi rientra
// con la prima candela nella direzione del trend. SL su swing low/high, TP a R:R.
// Niente trade in fase laterale (EMA intrecciate/piatte). Sim + toggle live.

@Injectable()
export class EmaScalperService implements OnModuleInit {
  private readonly logger = new Logger(EmaScalperService.name);
  private exchange: ccxt.mexc;
  private snapshot: any = { ready: false };
  private lastClosedAt = 0;                 // cooldown anti-whipsaw
  private readonly COOLDOWN_MS = 90 * 1000; // ~1.5 candele 1m

  constructor(private config: ConfigService, private prisma: PrismaService) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const has = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({ ...(has ? { apiKey, secret } : {}), enableRateLimit: true, timeout: 15000, options: { defaultType: 'swap' } });
    try { await this.exchange.loadMarkets(); } catch (e: any) { this.logger.warn(`[EMA] markets: ${e?.message}`); }
    await this.getConfig();
    this.logger.log('[EMA] 3 EMA Scalper attivo');
  }

  // ── EMA ─────────────────────────────────────────────────────────────────
  private ema(values: number[], period: number): number[] {
    const k = 2 / (period + 1);
    const out: number[] = [];
    let prev = values[0];
    for (let i = 0; i < values.length; i++) { prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k); out.push(prev); }
    return out;
  }

  // ── Loop ogni 10 secondi: valuta setup + gestisce il trade aperto ─────────
  @Cron('*/10 * * * * *')
  async tick() {
    try {
      const cfg = await this.getConfig();
      if (!cfg.enabled) return;
      const market = this.exchange.market(cfg.symbol);
      const cs = Number((market as any)?.contractSize ?? 1) || 1;
      const minContracts = Number((market as any)?.limits?.amount?.min ?? 1) || 1;

      const need = cfg.emaSlow + 60;
      const ohlcv = await this.exchange.fetchOHLCV(cfg.symbol, cfg.timeframe, undefined, need);
      if (!ohlcv || ohlcv.length < cfg.emaSlow + 10) return;

      const opens = ohlcv.map(c => Number(c[1]));
      const highs = ohlcv.map(c => Number(c[2]));
      const lows = ohlcv.map(c => Number(c[3]));
      const closes = ohlcv.map(c => Number(c[4]));
      const emaF = this.ema(closes, cfg.emaFast);
      const emaM = this.ema(closes, cfg.emaMid);
      const emaS = this.ema(closes, cfg.emaSlow);

      const n = closes.length;
      const i = n - 2;          // ultima candela CHIUSA (l'ultima è in formazione)
      const cur = n - 1;        // candela corrente (prezzo live)
      const price = closes[cur];

      // ── TREND (allineamento + pendenza) ────────────────────────────────────
      const sl = cfg.slopeLookback;
      const upAligned   = emaF[i] > emaM[i] && emaM[i] > emaS[i];
      const downAligned = emaF[i] < emaM[i] && emaM[i] < emaS[i];
      const upSlope   = emaF[i] > emaF[i - sl] && emaS[i] >= emaS[i - sl];
      const downSlope = emaF[i] < emaF[i - sl] && emaS[i] <= emaS[i - sl];
      const spreadPct = Math.abs(emaF[i] - emaS[i]) / price * 100;
      const choppy = spreadPct < cfg.minEmaSpreadPct;
      let trend: 'up' | 'down' | 'flat' = 'flat';
      if (!choppy && upAligned && upSlope) trend = 'up';
      else if (!choppy && downAligned && downSlope) trend = 'down';

      // ── PULLBACK + INGRESSO (candela chiusa i) ─────────────────────────────
      // Pullback = il prezzo TORNA A TESTARE la EMA veloce (anche solo di stoppino/wick)
      // nelle ultime 2 candele, SENZA rompere la EMA lenta. Ingresso = candela di RIGETTO
      // nella direzione del trend (verde sopra la EMA per long, rossa sotto per short).
      const pb = cfg.pullbackLookback;
      const heldSlowLong  = lows.slice(i - pb + 1, i + 1).every((lw, k) => lw > emaS[i - pb + 1 + k]);
      const touchedFastLong = lows[i] <= emaF[i] || lows[i - 1] <= emaF[i - 1];
      const triggerLong = touchedFastLong && closes[i] > emaF[i] && closes[i] > opens[i];
      const setupLong = trend === 'up' && heldSlowLong && triggerLong;

      const heldSlowShort = highs.slice(i - pb + 1, i + 1).every((hg, k) => hg < emaS[i - pb + 1 + k]);
      const touchedFastShort = highs[i] >= emaF[i] || highs[i - 1] >= emaF[i - 1];
      const triggerShort = touchedFastShort && closes[i] < emaF[i] && closes[i] < opens[i];
      const setupShort = trend === 'down' && heldSlowShort && triggerShort;

      const session = this.inSession();
      const sessionOk = !cfg.sessionFilter || session.active;

      // ── GESTIONE trade aperto (TP/SL su high/low della candela corrente) ─────
      const open = await this.prisma.emaScalperTrade.findFirst({ where: { status: 'open' } });
      const coolingDown = Date.now() - this.lastClosedAt < this.COOLDOWN_MS;
      if (open) {
        await this.manageOpen(open, highs[cur], lows[cur], price, cs);
      } else if (sessionOk && !coolingDown && (setupLong || setupShort)) {
        await this.openTrade(setupLong ? 'long' : 'short', cfg, price, lows, highs, i, cs, minContracts);
      }

      this.snapshot = {
        ready: true, ts: Date.now(), symbol: cfg.symbol, price,
        ema: { fast: +emaF[i].toFixed(2), mid: +emaM[i].toFixed(2), slow: +emaS[i].toFixed(2), spreadPct: +spreadPct.toFixed(3) },
        trend, choppy, session,
        setup: setupLong ? 'long' : setupShort ? 'short' : null,
        signals: { touchedFastLong, heldSlowLong, triggerLong, touchedFastShort, heldSlowShort, triggerShort },
      };
    } catch (e: any) { this.logger.warn(`[EMA] tick: ${e?.message?.slice(0, 80)}`); }
  }

  private inSession() {
    const h = new Date().getUTCHours();
    const london = h >= 7 && h < 16;
    const ny = h >= 12 && h < 21;
    return { active: london || ny, london, ny, utcHour: h };
  }

  private async manageOpen(t: any, high: number, low: number, price: number, cs: number) {
    let hit: 'tp' | 'sl' | null = null, exit = price;
    if (t.side === 'long') {
      if (high >= t.takeProfit) { hit = 'tp'; exit = t.takeProfit; }
      else if (low <= t.stopLoss) { hit = 'sl'; exit = t.stopLoss; }
    } else {
      if (low <= t.takeProfit) { hit = 'tp'; exit = t.takeProfit; }
      else if (high >= t.stopLoss) { hit = 'sl'; exit = t.stopLoss; }
    }
    if (!hit) return;
    const dir = t.side === 'long' ? 1 : -1;
    const pnl = (exit - t.entry) * dir * t.qty * cs;
    const rMultiple = t.riskUsd > 0 ? pnl / t.riskUsd : 0;
    if (t.mode === 'live') {
      try {
        if (t.side === 'long') await this.exchange.createMarketSellOrder(t.symbol, t.qty, { reduceOnly: true });
        else await this.exchange.createMarketBuyOrder(t.symbol, t.qty, { reduceOnly: true });
      } catch (e: any) { this.logger.warn(`[EMA LIVE] chiusura: ${e?.message?.slice(0, 50)}`); }
    }
    await this.prisma.emaScalperTrade.update({
      where: { id: t.id },
      data: { status: hit === 'tp' ? 'win' : 'loss', exitPrice: exit, pnl, rMultiple, reason: hit, closedAt: new Date() },
    });
    this.lastClosedAt = Date.now();
    this.logger.log(`[EMA ${t.mode.toUpperCase()}] ${t.side} CHIUSO ${hit.toUpperCase()} · entry ${t.entry} → ${exit} · PnL $${pnl.toFixed(4)} (${rMultiple.toFixed(2)}R)`);
  }

  private async openTrade(side: 'long' | 'short', cfg: any, price: number, lows: number[], highs: number[], i: number, cs: number, minContracts: number) {
    const look = cfg.swingLookback;
    const entry = price;
    // SL su swing low/high, ma SEMPRE dal lato giusto: se lo swing è oltre l'entrata
    // (es. prezzo sotto il supporto recente) il setup NON è valido → skip.
    const swing = side === 'long'
      ? Math.min(...lows.slice(i - look + 1, i + 1))
      : Math.max(...highs.slice(i - look + 1, i + 1));
    const swingDist = side === 'long' ? entry - swing : swing - entry;
    if (swingDist <= 0) return;                       // swing dalla parte sbagliata
    const risk = Math.max(swingDist, entry * 0.0012); // distanza minima 0.12% → TP a 2R copre le fee (~0.12% a/r)
    const sl = side === 'long' ? entry - risk : entry + risk;
    const tp = side === 'long' ? entry + cfg.riskReward * risk : entry - cfg.riskReward * risk;
    const qty = Math.max(minContracts, Math.round((cfg.capitalUsdt * cfg.leverage / entry) / cs));
    const riskUsd = risk * qty * cs;
    const mode = cfg.liveEnabled ? 'live' : 'sim';

    if (mode === 'live') {
      try {
        await this.exchange.setLeverage(cfg.leverage, cfg.symbol, { openType: 1, positionType: side === 'long' ? 1 : 2 }).catch(() => {});
        if (side === 'long') await this.exchange.createMarketBuyOrder(cfg.symbol, qty, { openType: 1, positionType: 1, leverage: cfg.leverage });
        else await this.exchange.createMarketSellOrder(cfg.symbol, qty, { openType: 1, positionType: 2, leverage: cfg.leverage });
      } catch (e: any) { this.logger.warn(`[EMA LIVE] apertura saltata: ${e?.message?.slice(0, 60)}`); return; }
    }

    await this.prisma.emaScalperTrade.create({
      data: { symbol: cfg.symbol, side, mode, entry, stopLoss: +sl.toFixed(2), takeProfit: +tp.toFixed(2), qty, leverage: cfg.leverage, riskUsd },
    });
    this.logger.log(`[EMA ${mode.toUpperCase()}] ${side.toUpperCase()} APERTO · entry ${entry.toFixed(2)} · SL ${sl.toFixed(2)} · TP ${tp.toFixed(2)} · R:R ${cfg.riskReward} · qty ${qty}`);
  }

  // ── API ───────────────────────────────────────────────────────────────────
  async getConfig() {
    let cfg = await this.prisma.emaScalperConfig.findUnique({ where: { id: 1 } });
    if (!cfg) cfg = await this.prisma.emaScalperConfig.create({ data: { id: 1 } });
    return cfg;
  }

  async updateConfig(patch: any) {
    const allowed = ['enabled', 'liveEnabled', 'symbol', 'timeframe', 'emaFast', 'emaMid', 'emaSlow', 'riskReward', 'capitalUsdt', 'leverage', 'swingLookback', 'pullbackLookback', 'slopeLookback', 'minEmaSpreadPct', 'sessionFilter'];
    const data: any = {};
    for (const k of allowed) if (patch[k] !== undefined) data[k] = patch[k];
    await this.getConfig();
    return this.prisma.emaScalperConfig.update({ where: { id: 1 }, data });
  }

  async getDashboard() {
    const [config, openTrade, recent, all] = await Promise.all([
      this.getConfig(),
      this.prisma.emaScalperTrade.findFirst({ where: { status: 'open' }, orderBy: { openedAt: 'desc' } }),
      this.prisma.emaScalperTrade.findMany({ where: { status: { not: 'open' } }, orderBy: { closedAt: 'desc' }, take: 30 }),
      this.prisma.emaScalperTrade.findMany({ where: { status: { not: 'open' } } }),
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
        avgWinR: wins.length ? +(wins.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / wins.length).toFixed(2) : 0,
      },
    };
  }

  async closeOpenManual() {
    const open = await this.prisma.emaScalperTrade.findFirst({ where: { status: 'open' } });
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
    }
    await this.prisma.emaScalperTrade.update({ where: { id: open.id }, data: { status: 'manual', exitPrice: price, pnl, rMultiple: open.riskUsd ? pnl / open.riskUsd : 0, reason: 'manual', closedAt: new Date() } });
    return { closed: true, pnl };
  }

  async reset() {
    await this.closeOpenManual().catch(() => {});
    const res = await this.prisma.emaScalperTrade.deleteMany({});
    this.lastClosedAt = 0;
    return { removed: res.count };
  }
}
