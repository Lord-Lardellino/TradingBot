import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';

// ── Grid Trading Scanner ────────────────────────────────────────────────────
// Trova coppie in RANGE (oscillanti, "scariche") ideali per il grid trading e
// calcola il setup griglia. Il grid guadagna dall'oscillazione orizzontale e
// PERDE dal trend → cerchiamo ADX basso + range pulito, usciamo al break.
// Bilanciamento: 2 griglie LONG + 2 griglie SHORT per neutralità direzionale.

@Injectable()
export class GridScannerService implements OnModuleInit {
  private readonly logger = new Logger(GridScannerService.name);
  private swapExchange: ccxt.mexc;
  private candidates: GridCandidate[] = [];
  private lastScanAt: string | null = null;
  private isScanning = false;
  private lastPrices = new Map<string, number>();  // per live monitor
  // SIM fedele al live: posizione NETTA firmata (neutral grid) con costo medio.
  // lots = contratti netti (>0 long, <0 short) · avgEntry = prezzo medio di carico.
  private simPos = new Map<string, { lots: number; avgEntry: number; lastPrice: number }>();
  // Cooldown: coppie chiuse di recente → non riaprirle subito (rotazione)
  private recentlyClosed = new Map<string, number>();
  private readonly COOLDOWN_MS = 30 * 60 * 1000;  // 30 minuti
  // Debounce anti-wick: il take deve restare sopra target per 2 tick di fila
  private takeHits = new Map<string, number>();

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
    this.swapExchange = new ccxt.mexc({ ...base, enableRateLimit: true, timeout: 15000, options: { defaultType: 'swap' } });
    try { await this.swapExchange.loadMarkets(); } catch (e: any) { this.logger.warn(`[GRID] markets: ${e?.message}`); }
    await this.getConfig();  // crea config default
    this.scanRanges();       // primo scan
    this.logger.log('[GRID] Grid Scanner attivo');
  }

  // ── Scan ogni 5 minuti ────────────────────────────────────────────────────
  @Cron('0 */5 * * * *')
  async scanRanges() {
    if (this.isScanning) return;
    this.isScanning = true;
    try {
      const cfg = await this.getConfig();
      const tf = cfg.timeframe || '15m';

      // 1. Top coppie liquide
      const tickers = await this.swapExchange.fetchTickers();
      const liquid = Object.entries(tickers)
        .filter(([s, t]) => s.endsWith('/USDT:USDT') && Number((t as any).quoteVolume ?? 0) > cfg.minVolume24h)
        .sort((a, b) => Number((b[1] as any).quoteVolume) - Number((a[1] as any).quoteVolume))
        .slice(0, 80)
        .map(([s]) => s);

      const results: GridCandidate[] = [];

      // 2. Per ogni coppia: OHLCV → indicatori → range score
      for (const symbol of liquid) {
        try {
          const ohlcv = await this.swapExchange.fetchOHLCV(symbol, tf, undefined, 100);
          if (!ohlcv || ohlcv.length < 50) continue;

          const highs = ohlcv.map(c => Number(c[2]));
          const lows  = ohlcv.map(c => Number(c[3]));
          const closes = ohlcv.map(c => Number(c[4]));
          const price = closes[closes.length - 1];
          if (!price) continue;

          // Indicatori
          const adx = this.calcADX(highs, lows, closes, 14);
          const rsi = this.calcRSI(closes, 14);
          const atr = this.calcATR(highs, lows, closes, 14);
          const bb  = this.calcBollinger(closes, 20, 2);

          // Range sulle ultime 50 candele
          const recentHighs = highs.slice(-50);
          const recentLows  = lows.slice(-50);
          const rangeHigh = Math.max(...recentHighs);
          const rangeLow  = Math.min(...recentLows);
          const rangePct  = ((rangeHigh - rangeLow) / price) * 100;

          // Posizione del prezzo nel range (0 = fondo, 1 = cima)
          const pricePos = (price - rangeLow) / (rangeHigh - rangeLow || 1);

          // Conta i "tocchi" dei bordi (rimbalzi = range valido)
          const touchHigh = recentHighs.filter(h => h >= rangeHigh * 0.98).length;
          const touchLow  = recentLows.filter(l => l <= rangeLow * 1.02).length;
          const touches = touchHigh + touchLow;

          // ── Filtri: deve essere in range ──────────────────────────────────
          const inRange = adx < cfg.maxAdx && rangePct >= cfg.minRangePct && rangePct <= cfg.maxRangePct
                          && price <= bb.upper * 1.01 && price >= bb.lower * 0.99;
          if (!inRange) continue;

          // ── Range score (0-100) ───────────────────────────────────────────
          const adxScore   = Math.max(0, (cfg.maxAdx - adx) / cfg.maxAdx) * 40;     // ADX basso = top
          const rsiScore   = (1 - Math.abs(rsi - 50) / 50) * 20;                     // RSI centrale = top
          const touchScore = Math.min(touches / 6, 1) * 25;                          // più rimbalzi = range solido
          const bbScore    = price <= bb.upper && price >= bb.lower ? 15 : 5;        // dentro bande
          const score = Math.round(adxScore + rsiScore + touchScore + bbScore);

          // ── Setup griglia ─────────────────────────────────────────────────
          const spacingPct = rangePct / cfg.gridLevels;
          const feeRoundTrip = 0.04;  // taker 0.02% × 2 lati (futures MEXC)
          const profitPerCyclePct = spacingPct - feeRoundTrip;
          // Stima cicli/giorno CONSERVATIVA: la volatilità giornaliera (ATR×√candele)
          // diviso lo spacing dà gli attraversamenti teorici; scontiamo pesantemente
          // (fattore 0.12, cap 8) perché spread/slippage/periodi morti riducono molto
          // i cicli realmente profittevoli. È comunque una stima OTTIMISTICA.
          const candlesPerDay = tf === '5m' ? 288 : 96;
          const atrPct = (atr / price) * 100;
          const dailyVolPct = atrPct * Math.sqrt(candlesPerDay);
          const cyclesPerDay = Math.min(8, Math.max(0, (dailyVolPct / spacingPct) * 0.12));
          const dailyPct = Math.max(0, profitPerCyclePct * cyclesPerDay);
          const aprEst = dailyPct * 365;
          const liquidationPct = 100 / cfg.leverage;

          // Bias: prezzo nella metà bassa+RSI<50 → meglio LONG; alta+RSI>50 → SHORT
          const longBias  = (1 - pricePos) * 0.6 + (rsi < 50 ? 0.4 : 0);
          const shortBias = pricePos * 0.6 + (rsi > 50 ? 0.4 : 0);
          const preferredSide = longBias >= shortBias ? 'long' : 'short';

          // Warning break: prezzo vicino ai bordi o ADX in salita
          const breakRisk = pricePos > 0.92 ? 'vicino top' : pricePos < 0.08 ? 'vicino bottom' : adx > cfg.maxAdx * 0.85 ? 'ADX in salita' : 'ok';

          results.push({
            symbol,
            base: symbol.replace('/USDT:USDT', ''),
            price,
            vol24h: Number((tickers[symbol] as any).quoteVolume ?? 0),
            adx: +adx.toFixed(1),
            rsi: +rsi.toFixed(1),
            atrPct: +atrPct.toFixed(2),
            rangeLow: +rangeLow.toFixed(6),
            rangeHigh: +rangeHigh.toFixed(6),
            rangePct: +rangePct.toFixed(2),
            pricePos: +pricePos.toFixed(2),
            touches,
            score,
            spacingPct: +spacingPct.toFixed(3),
            gridLevels: cfg.gridLevels,
            profitPerCyclePct: +profitPerCyclePct.toFixed(3),
            cyclesPerDay: +cyclesPerDay.toFixed(1),
            dailyPct: +dailyPct.toFixed(3),
            aprEst: +aprEst.toFixed(0),
            leverage: cfg.leverage,
            liquidationPct: +liquidationPct.toFixed(1),
            preferredSide,
            breakRisk,
          });
        } catch { /* skip coppia */ }
      }

      // Ordina per score desc
      results.sort((a, b) => b.score - a.score);
      this.candidates = results;
      this.lastScanAt = new Date().toISOString();
      this.logger.log(`[GRID] ${liquid.length} coppie scan · ${results.length} in range · top: ${results[0]?.base ?? '-'} score ${results[0]?.score ?? '-'}`);
    } catch (e: any) {
      this.logger.warn(`[GRID] scanRanges: ${e?.message}`);
    } finally {
      this.isScanning = false;
    }
  }

  // ── Loop di SIMULAZIONE (paper trading con prezzi reali) — ogni minuto ────
  @Cron('30 * * * * *')
  async simLoop() {
    try {
      const cfg = await this.getConfig();
      // SOLO griglie SIM (le live sono gestite dal monitor live, non da qui)
      const bots = await this.prisma.gridBot.findMany({ where: { status: 'open', mode: 'sim' } });

      // 1. Aggiorna ogni griglia sim: cicli completati + check break
      for (const bot of bots) {
        const cand = this.candidates.find(c => c.symbol === bot.symbol);
        let price = cand?.price;
        if (price == null) {
          try { price = Number((await this.swapExchange.fetchTicker(bot.symbol)).last); } catch { continue; }
        }
        if (!price) continue;

        const cs = bot.contractSize || 1;
        const spacingPrice = (bot.rangeHigh - bot.rangeLow) / bot.gridLevels;
        const pricePos = (price - bot.rangeLow) / ((bot.rangeHigh - bot.rangeLow) || 1);
        const cpl = bot.contractsPerLevel;

        // ── NEUTRAL GRID (come MEXC): scendendo COMPRA (long), salendo VENDE (short).
        //    Posizione NETTA firmata, P&L a COSTO MEDIO esatto. Profitto = ogni chiusura
        //    completata (spacing − fee). Identico al live. ──────────────────────────
        const st = this.simPos.get(bot.id) ?? { lots: 0, avgEntry: price, lastPrice: bot.entryPrice };
        const feeRate = 0.0002;  // maker (ordini limite della griglia)
        let cyclesAdd = 0, realizedAdd = 0;
        const lo = Math.min(st.lastPrice, price), hi = Math.max(st.lastPrice, price);
        const crossed: number[] = [];
        for (let i = 1; i < bot.gridLevels; i++) { const L = bot.rangeLow + spacingPrice * i; if (L > lo && L <= hi) crossed.push(L); }
        const goingUp = price >= st.lastPrice;
        crossed.sort((a, b) => goingUp ? a - b : b - a);
        for (const L of crossed) {
          const fee = cpl * cs * L * feeRate;
          if (goingUp) {                                   // VENDI cpl @ L
            if (st.lots > 0) { const q = Math.min(cpl, st.lots); realizedAdd += (L - st.avgEntry) * q * cs - fee; st.lots -= q; if (cpl - q > 0) { st.avgEntry = L; st.lots -= (cpl - q); } cyclesAdd++; }
            else { st.avgEntry = ((-st.lots) * st.avgEntry + cpl * L) / ((-st.lots) + cpl); st.lots -= cpl; realizedAdd -= fee; }
          } else {                                         // COMPRA cpl @ L
            if (st.lots < 0) { const q = Math.min(cpl, -st.lots); realizedAdd += (st.avgEntry - L) * q * cs - fee; st.lots += q; if (cpl - q > 0) { st.avgEntry = L; st.lots += (cpl - q); } cyclesAdd++; }
            else { st.avgEntry = (st.lots * st.avgEntry + cpl * L) / (st.lots + cpl); st.lots += cpl; realizedAdd -= fee; }
          }
        }
        st.lastPrice = price;
        this.simPos.set(bot.id, st);
        const uPnl = (price - st.avgEntry) * st.lots * cs;
        if (realizedAdd !== 0 || cyclesAdd > 0) {
          await this.prisma.gridBot.update({ where: { id: bot.id }, data: { realizedPnl: { increment: realizedAdd }, filledCycles: { increment: cyclesAdd } } });
          bot.realizedPnl += realizedAdd;
        }

        // ── USCITE (come MEXC + safety stop): range break + stop sui bordi. NIENTE take
        //    sull'unrealized. Alla chiusura realizziamo anche l'unrealized residuo.
        const finalize = async (reason: string) => {
          await this.prisma.gridBot.update({ where: { id: bot.id }, data: { realizedPnl: { increment: uPnl } } });
          await this.closeSimGrid(bot.id, reason, price); this.simPos.delete(bot.id);
        };
        if (cand && (cand.adx ?? 0) > cfg.exitAdx) { await finalize('trend_adx'); continue; }
        if (price > bot.rangeHigh) { await finalize('break_up'); continue; }
        if (price < bot.rangeLow)  { await finalize('break_down'); continue; }
        if (pricePos > cfg.stopThreshold)       { await finalize('stop_early_up'); continue; }
        if (pricePos < (1 - cfg.stopThreshold)) { await finalize('stop_early_down'); continue; }
      }

      // 2. Auto-apertura SIM: griglie NEUTRAL sui migliori candidati in range (conta
      //    solo le SIM). Esclude coppie già aperte in QUALSIASI modo (sim o live).
      if (cfg.autoTradeEnabled) {
        const allOpen = await this.prisma.gridBot.findMany({ where: { status: 'open' } });
        const simOpen = allOpen.filter(b => b.mode === 'sim');
        const openSymbols = new Set(allOpen.map(b => b.symbol));  // include anche le live
        const maxNeutral = cfg.maxLongGrids + cfg.maxShortGrids;

        const sugg = this.getSuggestions(maxNeutral + 3, maxNeutral + 3);
        const cands = [...sugg.long, ...sugg.short]
          .filter((c, i, arr) => arr.findIndex(x => x.symbol === c.symbol) === i)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        for (const c of cands) {
          if (simOpen.length >= maxNeutral) break;
          if (!openSymbols.has(c.symbol) && !this.inCooldown(c.symbol)) { await this.openSimGrid(c.symbol, 'neutral'); openSymbols.add(c.symbol); simOpen.push({} as any); }
        }
      }
    } catch (e: any) {
      this.logger.warn(`[GRID SIM] loop error: ${e?.message}`);
    }
  }

  // ── Apri una griglia simulata dal candidato in range ──────────────────────
  async openSimGrid(symbol: string, side: 'long' | 'short' | 'neutral') {
    const cand = this.candidates.find(c => c.symbol === symbol);
    if (!cand) throw new Error(`${symbol} non è in range (nessun candidato)`);
    const cfg = await this.getConfig();
    // STESSI parametri del live: livelli DINAMICI, leva AUTO, contractsPerLevel.
    const price = cand.price, low = cand.rangeLow, high = cand.rangeHigh;
    const rangePct = ((high - low) / price) * 100;
    const liveLevels = Math.max(6, Math.min(20, Math.round(rangePct / cfg.gridSpacingPct)));  // spacing più largo = ciclo più grosso
    const leverage = Math.max(2, Math.min(3, Math.floor(100 / (rangePct * 2)) || 2));  // cap 3x
    let cs = 1, minContracts = 1;
    try { const m = this.swapExchange.market(symbol); cs = Number((m as any)?.contractSize ?? 1) || 1; minContracts = Number((m as any)?.limits?.amount?.min ?? 1) || 1; } catch {}
    const totalOrders = Math.max(1, liveLevels - 1);
    const contractsPerLevel = Math.max(minContracts, Math.round((cfg.capitalPerGrid * leverage / totalOrders / price) / cs));

    const bot = await this.prisma.gridBot.create({
      data: {
        symbol, side, mode: 'sim', timeframe: cfg.timeframe, leverage,
        rangeLow: low, rangeHigh: high, gridLevels: liveLevels,
        spacingPct: cand.spacingPct, capitalUsdt: cfg.capitalPerGrid, entryPrice: price,
        status: 'open', contractSize: cs, contractsPerLevel,
      },
    });
    this.simPos.set(bot.id, { lots: 0, avgEntry: price, lastPrice: price });
    this.logger.log(`[GRID SIM] aperta ${side.toUpperCase()} ${cand.base} · leva AUTO ${leverage}x · ${liveLevels} livelli · range ${low}-${high}`);
    return bot;
  }

  // ── Chiudi una griglia simulata ───────────────────────────────────────────
  async closeSimGrid(botId: string, reason: string, price?: number) {
    const bot = await this.prisma.gridBot.findUnique({ where: { id: botId } });
    if (!bot || bot.status !== 'open') return;
    await this.prisma.gridBot.update({
      where: { id: botId },
      data: { status: 'closed', closeReason: reason, closePrice: price ?? bot.entryPrice, closePnl: bot.realizedPnl, closedAt: new Date() },
    });
    this.lastPrices.delete(botId);
    this.simPos.delete(botId);
    this.recentlyClosed.set(bot.symbol, Date.now());  // cooldown
    this.logger.log(`[GRID SIM] chiusa ${bot.side.toUpperCase()} ${bot.symbol.replace('/USDT:USDT','')} · ${reason} · cicli ${bot.filledCycles} · PnL $${bot.realizedPnl.toFixed(4)}`);
    return { closed: true, reason, pnl: bot.realizedPnl };
  }

  private inCooldown(symbol: string): boolean {
    const t = this.recentlyClosed.get(symbol);
    return t != null && (Date.now() - t) < this.COOLDOWN_MS;
  }

  // ── Monitor griglie LIVE — ogni 15 secondi: rileva fill e ripiazza ────────
  @Cron('*/15 * * * * *')
  async monitorLiveGrids() {
    try {
      const bots = await this.prisma.gridBot.findMany({ where: { status: 'open', mode: 'live' } });
      for (const bot of bots) {
        try { await this.checkLiveGrid(bot); } catch (e: any) { this.logger.warn(`[GRID LIVE] ${bot.symbol}: ${e?.message?.slice(0, 50)}`); }
      }

      // Mantieni 1 griglia LIVE NEUTRAL (per validarla dal vivo con margine piccolo).
      const cfg = await this.getConfig();
      if (cfg.autoTradeEnabled && bots.length < 1) {
        const sugg = this.getSuggestions(6, 6);
        const openSym = new Set(bots.map(b => b.symbol));
        const cands = [...sugg.long, ...sugg.short]
          .filter((c, i, arr) => arr.findIndex(x => x.symbol === c.symbol) === i)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const c = cands.find(x => !openSym.has(x.symbol) && !this.inCooldown(x.symbol));
        if (c) {
          try {
            await this.openLiveGrid(c.symbol, 'neutral', cfg.capitalPerGrid, 10);
            this.logger.log(`[GRID LIVE] auto-mantenimento: aperta NEUTRAL ${c.base}`);
          } catch (e: any) { this.logger.warn(`[GRID LIVE] auto-apertura neutral saltata: ${e?.message?.slice(0, 50)}`); }
        }
      }
    } catch (e: any) { this.logger.warn(`[GRID LIVE] monitor: ${e?.message}`); }
  }

  private async checkLiveGrid(bot: any) {
    const orders: any[] = bot.liveOrders ? JSON.parse(bot.liveOrders) : [];
    const cs = bot.contractSize || 1;
    const spacing = (bot.rangeHigh - bot.rangeLow) / bot.gridLevels;
    const center = (bot.rangeLow + bot.rangeHigh) / 2;
    const neutral = bot.side === 'neutral';
    const cfg = await this.getConfig();

    let price = this.candidates.find(c => c.symbol === bot.symbol)?.price;
    if (price == null) { try { price = Number((await this.swapExchange.fetchTicker(bot.symbol)).last); } catch { return; } }
    const pricePos = (price - bot.rangeLow) / ((bot.rangeHigh - bot.rangeLow) || 1);

    // ── POSIZIONE REALE (un solo fetch): netta FIRMATA (+long/-short), entry, e
    //    REALIZZATO VERO da MEXC (info.realised = P&L trading, NON il funding). ──────
    let posContracts = 0, netSigned = 0, realised = 0, uPnl = 0;
    try {
      const ps = (await this.swapExchange.fetchPositions([bot.symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      for (const p of ps) {  // somma firmata su tutte le posizioni (gestisce anche hedge)
        const e = Number((p.info as any)?.holdAvgPrice ?? p.entryPrice ?? price);
        const c = Math.abs(Number(p.contracts));
        const sgn = p.side === 'short' ? -1 : 1;
        netSigned += c * sgn;
        uPnl += (price - e) * c * sgn * cs;
        realised += Number((p.info as any)?.realised ?? 0);
      }
      posContracts = Math.abs(netSigned);
    } catch {}
    const realTotal = realised + uPnl;

    // DIREZIONE EFFETTIVA: neutral = long sotto il centro / short sopra (segue la
    // posizione netta; se flat decide dal centro). Le direzionali usano il loro side.
    const eff: 'long' | 'short' = neutral
      ? (netSigned > 0 ? 'long' : netSigned < 0 ? 'short' : (price < center ? 'long' : 'short'))
      : (bot.side as 'long' | 'short');

    // ── USCITE ──────────────────────────────────────────────────────────────
    // TAKE PROFIT su PnL reale (SOLO direzionali; il neutral NON chiude sull'unrealized,
    // come MEXC) con debounce anti-wick.
    const target = bot.capitalUsdt * (cfg.takeProfitPct / 100);
    if (!neutral && realTotal >= target) {
      const hits = (this.takeHits.get(bot.id) ?? 0) + 1;
      this.takeHits.set(bot.id, hits);
      if (hits >= 2) { this.takeHits.delete(bot.id); await this.closeLiveGrid(bot.id, 'take_profit'); return; }
    } else { this.takeHits.delete(bot.id); }
    // USCITA TREND (chiave per la profittabilità): appena il mercato inizia a trendare
    // (ADX alto) chiudo la griglia PRIMA di accumulare la grossa perdita direzionale.
    // Se la coppia è uscita dai candidati (ha trendato fuori range) calcolo l'ADX al volo.
    let candAdx = this.candidates.find(c => c.symbol === bot.symbol)?.adx;
    if (candAdx == null) {
      try {
        const oh = await this.swapExchange.fetchOHLCV(bot.symbol, cfg.timeframe || '15m', undefined, 60);
        candAdx = this.calcADX(oh.map((c: any) => +c[2]), oh.map((c: any) => +c[3]), oh.map((c: any) => +c[4]));
      } catch { candAdx = 0; }
    }
    if ((candAdx ?? 0) > cfg.exitAdx) { await this.closeLiveGrid(bot.id, 'trend_adx'); return; }
    // STOP di sicurezza sui bordi: neutral teme ENTRAMBI i lati (carico long in basso,
    // short in alto); direzionale solo il lato sfavorevole.
    const stopUp   = (neutral || bot.side === 'short') && pricePos > cfg.stopThreshold;
    const stopDown = (neutral || bot.side === 'long')  && pricePos < (1 - cfg.stopThreshold);
    if (stopUp || stopDown) { await this.closeLiveGrid(bot.id, stopUp ? 'stop_early_up' : 'stop_early_down'); return; }
    // BREAK fuori range
    if (price > bot.rangeHigh || price < bot.rangeLow) { await this.closeLiveGrid(bot.id, price > bot.rangeHigh ? 'break_up' : 'break_down'); return; }
    if (!orders.length && !neutral) return;

    // ── Match per PREZZO (l'id da create è rotto su MEXC): un ordine salvato senza
    //    ordine aperto al suo prezzo (entro mezzo spacing) = è stato RIEMPITO. ──────
    const openOrders = await this.swapExchange.fetchOpenOrders(bot.symbol);
    const tol = spacing * 0.4;
    const isOpenAt = (p: number) => openOrders.some((o: any) => Math.abs(Number(o.price) - p) < tol);
    const cpl = bot.contractsPerLevel;
    const px = (v: number) => Number(this.swapExchange.priceToPrecision(bot.symbol, v));

    const newOrders: any[] = [];
    const has  = (p: number, side?: 'buy' | 'sell') => newOrders.some(o => Math.abs(o.price - p) < tol && (!side || o.side === side));
    const keep = (p: number, side: 'buy' | 'sell') => { if (!has(p, side)) newOrders.push({ price: p, side }); };

    // 1) Riporta gli ordini ancora aperti; conta i fill di chiusura come ATTIVITÀ.
    let cyclesAdd = 0;
    for (const ord of orders) {
      if (isOpenAt(ord.price)) { keep(ord.price, ord.side); continue; }
      const isClose = (eff === 'long' && ord.side === 'sell') || (eff === 'short' && ord.side === 'buy');
      if (isClose) cyclesAdd += 1;
    }

    // 2) Livelli equidistanti sopra/sotto il prezzo, con DEAD-ZONE di mezzo spacing:
    //    MAI un ordine sul livello appena preso (il centro).
    const above: number[] = [], below: number[] = [];
    for (let i = 1; i < bot.gridLevels; i++) {
      const L = px(bot.rangeLow + spacing * i);
      if (Math.abs(L - price) < spacing * 0.5) continue;
      if (L > price) above.push(L); else below.push(L);
    }
    above.sort((a, b) => a - b);
    below.sort((a, b) => b - a);

    // 3) CHIUSURE dei chunk in mano (reduceOnly), 1 per chunk, gated dalla posizione
    //    reale. eff long → SELL sopra (pt1) · eff short → BUY sotto (pt2).
    const chunks       = Math.round(posContracts / cpl);
    const closeSide: 'buy' | 'sell' = eff === 'long' ? 'sell' : 'buy';
    const closeLevels  = eff === 'long' ? above : below;
    const closePt      = eff === 'long' ? 1 : 2;
    let placed = newOrders.filter(o => o.side === closeSide).length;
    for (const L of closeLevels) {
      if (placed >= chunks) break;
      if (has(L)) continue;
      try {
        if (closeSide === 'sell') await this.swapExchange.createLimitSellOrder(bot.symbol, cpl, L, { openType: 1, positionType: closePt, leverage: bot.leverage, reduceOnly: true });
        else                      await this.swapExchange.createLimitBuyOrder(bot.symbol, cpl, L, { openType: 1, positionType: closePt, leverage: bot.leverage, reduceOnly: true });
        keep(L, closeSide); placed++;
      } catch (e: any) { this.logger.warn(`[GRID LIVE] ${closeSide}@${L}: ${e?.message?.slice(0, 40)}`); }
    }

    // 4) ENTRATE dense SENZA riaprire al centro: eff long → BUY sotto (pt1 apre long) ·
    //    eff short → SELL sopra (pt2 apre short). Salto un livello se ne tengo già il
    //    chunk (chiusura presente a ±1 tacca) → mai una nuova entrata sul livello preso.
    const openSide: 'buy' | 'sell' = eff === 'long' ? 'buy' : 'sell';
    const openLevels = eff === 'long' ? below : above;
    const openPt     = eff === 'long' ? 1 : 2;
    for (const L of openLevels) {
      if (has(L)) continue;
      const closeOfThis = eff === 'long' ? px(L + spacing) : px(L - spacing);
      if (has(closeOfThis, closeSide)) continue;
      try {
        if (openSide === 'buy') await this.swapExchange.createLimitBuyOrder(bot.symbol, cpl, L, { openType: 1, positionType: openPt, leverage: bot.leverage });
        else                    await this.swapExchange.createLimitSellOrder(bot.symbol, cpl, L, { openType: 1, positionType: openPt, leverage: bot.leverage });
        keep(L, openSide);
      } catch (e: any) { this.logger.warn(`[GRID LIVE] ${openSide}@${L}: ${e?.message?.slice(0, 40)}`); }
    }

    // stato reale + P&L REALIZZATO VERO (realised di MEXC), ordinato per prezzo decr.
    newOrders.sort((a, b) => b.price - a.price);
    if (cyclesAdd > 0 || Math.abs(realised - bot.realizedPnl) > 1e-6 || JSON.stringify(newOrders) !== JSON.stringify(orders)) {
      if (cyclesAdd > 0) this.logger.log(`[GRID LIVE] ${bot.symbol.replace('/USDT:USDT','')} ${eff} ${cyclesAdd} chiusure · realizzato $${realised.toFixed(4)} · uPnl $${uPnl.toFixed(4)}`);
      await this.prisma.gridBot.update({
        where: { id: bot.id },
        data: { liveOrders: JSON.stringify(newOrders), realizedPnl: realised, filledCycles: { increment: cyclesAdd } },
      });
    }
  }

  // ── Apri griglia LIVE BIDIREZIONALE: posizione base + buy sotto + sell sopra ─
  async openLiveGrid(symbol: string, side: 'long' | 'short' | 'neutral', marginUsdt: number, liveLevels = 6) {
    const cand = this.candidates.find(c => c.symbol === symbol);
    if (!cand) throw new Error(`${symbol} non è in range`);
    const cfg = await this.getConfig();
    const market = this.swapExchange.market(symbol);
    const cs = Number((market as any)?.contractSize ?? 1) || 1;
    const minContracts = Number((market as any)?.limits?.amount?.min ?? 1) || 1;

    const price = cand.price;
    const low = cand.rangeLow, high = cand.rangeHigh;
    const rangePct = ((high - low) / price) * 100;
    // NUMERO LIVELLI DINAMICO: si adatta al range ma sempre DENSO (min 10 livelli,
    // come prima). Spacing target ~gridSpacingPct % → range largo = più livelli.
    liveLevels = Math.max(6, Math.min(20, Math.round(rangePct / cfg.gridSpacingPct)));  // spacing più largo = ciclo più grosso
    const spacing = (high - low) / liveLevels;
    const pricePos = (price - low) / ((high - low) || 1);

    // 1. CENTRO RANGE: il prezzo deve stare al 25-75% così la griglia è bilanciata
    if (pricePos < 0.25 || pricePos > 0.75)
      throw new Error(`${cand.base} prezzo al ${(pricePos * 100).toFixed(0)}% del range (serve 25-75% per griglia bilanciata)`);

    // LEVA AUTOMATICA: liquidazione oltre il range MA cappata a 5x per limitare la
    // PERDITA al break (la leva amplifica la perdita: posizione × movimento × leva).
    // 5x è il compromesso: profitto/ciclo decente, perdita break gestibile.
    const safeLeverage = Math.floor(100 / (rangePct * 2));
    const leverage = Math.max(2, Math.min(3, safeLeverage || 2));  // cap 3x: perdita break più piccola
    const liquidationPct = +(100 / leverage).toFixed(1);

    // 2. Griglia FISSA ancorata al range: livelli sempre agli stessi prezzi
    //    (low + k×spacing), equidistanti. BUY ai livelli sotto il prezzo, SELL
    //    sopra. Gli ordini limite NON si riempiono all'apertura (buy sotto si
    //    attiva solo se scende, sell sopra solo se sale). I buy chiudono sempre
    //    sotto l'entrata della base = in profitto. Media ordini = centro griglia.
    const above: number[] = [];   // SELL (sopra il prezzo)
    const below: number[] = [];   // BUY (sotto il prezzo)
    for (let i = 1; i < liveLevels; i++) {
      const lp = Number(this.swapExchange.priceToPrecision(symbol, low + spacing * i));
      if (Math.abs(lp - price) < spacing * 0.5) continue;   // DEAD-ZONE: cella vuota attorno al prezzo
      if (lp > price) above.push(lp);
      else if (lp < price) below.push(lp);
    }
    const levels = [...new Set([...above, ...below])];     // dedup
    const totalOrders = above.length + below.length;
    if (totalOrders < 2) throw new Error(`troppi pochi livelli utili (${totalOrders}) — riduci spacing o cambia coppia`);

    // 3. Contratti/livello: margine TOTALE / ordini effettivi (posizione max = tutti pieni)
    const contractsPerLevel = Math.max(minContracts, Math.round((marginUsdt * leverage / totalOrders / price) / cs));
    const realNotionalPerLevel = contractsPerLevel * cs * price;
    const realMarginTotal = (realNotionalPerLevel * totalOrders) / leverage;
    if (realNotionalPerLevel < 1) throw new Error(`notional/livello ${realNotionalPerLevel.toFixed(2)}$ < minimo 1$ — aumenta margine`);

    const neutralEff: 'long' | 'short' = price < (low + high) / 2 ? 'long' : 'short';
    const levPt = side === 'neutral' ? (neutralEff === 'long' ? 1 : 2) : (side === 'long' ? 1 : 2);
    try { await this.swapExchange.setLeverage(leverage, symbol, { openType: 1, positionType: levPt }); } catch {}

    const liveOrders: any[] = [];

    // NB: l'id da createLimitOrder è rotto su MEXC → salvo solo {price, side} e il
    // monitor confronta per PREZZO (affidabile) con fetchOpenOrders.
    if (side === 'neutral') {
      // NEUTRAL: parte FLAT (nessuna base). Mette l'intera scala: BUY sotto il prezzo
      // (apre long, pt1) + SELL sopra (apre short, pt2). In one-way mode MEXC netta i
      // fill → posizione long sotto il centro, short sopra. Il monitor gestisce le
      // chiusure accoppiate. Se l'account è one-way puro e rifiuta un lato, si vede dai log.
      for (const l of below) {
        try { await this.swapExchange.createLimitBuyOrder(symbol, contractsPerLevel, l, { openType: 1, positionType: 1, leverage }); liveOrders.push({ price: l, side: 'buy' }); } catch (e: any) { this.logger.warn(`[GRID OPEN] buy@${l}: ${e?.message?.slice(0,40)}`); }
      }
      for (const l of above) {
        try { await this.swapExchange.createLimitSellOrder(symbol, contractsPerLevel, l, { openType: 1, positionType: 2, leverage }); liveOrders.push({ price: l, side: 'sell' }); } catch (e: any) { this.logger.warn(`[GRID OPEN] sell@${l}: ${e?.message?.slice(0,40)}`); }
      }
    } else if (side === 'long') {
      const baseContracts = contractsPerLevel * above.length;  // base = poter vendere ai SELL sopra
      if (baseContracts > 0) {
        try { await this.swapExchange.createMarketBuyOrder(symbol, baseContracts, { openType: 1, positionType: 1, leverage }); }
        catch (e: any) { throw new Error(`base long fallita: ${e?.message?.slice(0, 50)}`); }
      }
      for (const l of above) {
        try { await this.swapExchange.createLimitSellOrder(symbol, contractsPerLevel, l, { openType: 1, positionType: 1, leverage, reduceOnly: true }); liveOrders.push({ price: l, side: 'sell' }); } catch (e: any) { this.logger.warn(`[GRID OPEN] sell@${l}: ${e?.message?.slice(0,40)}`); }
      }
      for (const l of below) {
        try { await this.swapExchange.createLimitBuyOrder(symbol, contractsPerLevel, l, { openType: 1, positionType: 1, leverage }); liveOrders.push({ price: l, side: 'buy' }); } catch (e: any) { this.logger.warn(`[GRID OPEN] buy@${l}: ${e?.message?.slice(0,40)}`); }
      }
    } else {
      const baseContracts = contractsPerLevel * below.length;  // base = poter ricomprare ai BUY sotto
      if (baseContracts > 0) {
        try { await this.swapExchange.createMarketSellOrder(symbol, baseContracts, { openType: 1, positionType: 2, leverage }); }
        catch (e: any) { throw new Error(`base short fallita: ${e?.message?.slice(0, 50)}`); }
      }
      for (const l of below) {
        try { await this.swapExchange.createLimitBuyOrder(symbol, contractsPerLevel, l, { openType: 1, positionType: 2, leverage, reduceOnly: true }); liveOrders.push({ price: l, side: 'buy' }); } catch (e: any) { this.logger.warn(`[GRID OPEN] buy@${l}: ${e?.message?.slice(0,40)}`); }
      }
      for (const l of above) {
        try { await this.swapExchange.createLimitSellOrder(symbol, contractsPerLevel, l, { openType: 1, positionType: 2, leverage }); liveOrders.push({ price: l, side: 'sell' }); } catch (e: any) { this.logger.warn(`[GRID OPEN] sell@${l}: ${e?.message?.slice(0,40)}`); }
      }
    }

    if (!liveOrders.length) throw new Error('nessun ordine piazzato (controlla saldo/minimi)');

    const bot = await this.prisma.gridBot.create({
      data: {
        symbol, side, mode: 'live', timeframe: cfg.timeframe, leverage,
        rangeLow: low, rangeHigh: high, gridLevels: liveLevels, spacingPct: cand.spacingPct,
        capitalUsdt: marginUsdt, entryPrice: price, status: 'open',
        contractSize: cs, contractsPerLevel, liveOrders: JSON.stringify(liveOrders),
      },
    });
    // Calcolo profitto: ogni ciclo = spacing × contratti × contractSize (netto fee)
    const profitPerCycle = spacing * contractsPerLevel * cs - (contractsPerLevel * cs * price) * 0.0004;
    const dailyProfitEst = +(profitPerCycle * (cand.cyclesPerDay ?? 0)).toFixed(4);

    this.logger.log(`[GRID LIVE OPEN] ${side.toUpperCase()} ${cand.base} · ${liveOrders.length} ordini · leva AUTO ${leverage}x (liq ±${liquidationPct}%, range ${rangePct.toFixed(1)}%) · profit/ciclo $${profitPerCycle.toFixed(4)} · margine ~$${realMarginTotal.toFixed(2)}`);
    return {
      bot, ordersPlaced: liveOrders.length, sellOrders: above.length, buyOrders: below.length,
      contractsPerLevel, notionalPerLevel: +realNotionalPerLevel.toFixed(2), marginTotal: +realMarginTotal.toFixed(2),
      leverage, liquidationPct, profitPerCycle: +profitPerCycle.toFixed(4), dailyProfitEst,
    };
  }

  // ── Chiudi griglia LIVE: cancella ordini + chiudi posizione residua ───────
  async closeLiveGrid(botId: string, reason: string) {
    const bot = await this.prisma.gridBot.findUnique({ where: { id: botId } });
    if (!bot || bot.status !== 'open') return;
    let realClosePnl = bot.realizedPnl;   // fallback
    try {
      // cancella tutti gli ordini aperti della coppia
      const openOrders = await this.swapExchange.fetchOpenOrders(bot.symbol);
      for (const o of openOrders) { try { await this.swapExchange.cancelOrder(o.id, bot.symbol); } catch {} }
      // chiudi posizione residua — P&L REALE = realizzato MEXC + unrealized che incassiamo
      const cs = bot.contractSize || 1;
      let price = this.candidates.find(c => c.symbol === bot.symbol)?.price;
      if (price == null) { try { price = Number((await this.swapExchange.fetchTicker(bot.symbol)).last); } catch {} }
      const positions = (await this.swapExchange.fetchPositions([bot.symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      for (const p of positions) {
        const c = Math.abs(Number(p.contracts));
        const entry = Number((p.info as any)?.holdAvgPrice ?? p.entryPrice ?? price ?? 0);
        const realised = Number((p.info as any)?.realised ?? 0);
        const uPnl = price ? (bot.side === 'long' ? (price - entry) : (entry - price)) * c * cs : 0;
        realClosePnl = realised + uPnl;
        try {
          if (p.side === 'long') await this.swapExchange.createMarketSellOrder(bot.symbol, c, { reduceOnly: true });
          else await this.swapExchange.createMarketBuyOrder(bot.symbol, c, { reduceOnly: true });
        } catch (e: any) { this.logger.warn(`[GRID LIVE CLOSE] pos: ${e?.message?.slice(0, 40)}`); }
      }
    } catch (e: any) { this.logger.warn(`[GRID LIVE CLOSE] ${e?.message?.slice(0, 50)}`); }
    this.takeHits.delete(botId);
    await this.prisma.gridBot.update({
      where: { id: botId },
      data: { status: 'closed', closeReason: reason, closePnl: realClosePnl, realizedPnl: realClosePnl, closedAt: new Date() },
    });
    this.recentlyClosed.set(bot.symbol, Date.now());  // cooldown 30 min
    this.logger.log(`[GRID LIVE CLOSE] ${bot.symbol} · ${reason} · P&L REALE $${realClosePnl.toFixed(4)}`);
    return { closed: true, reason, pnl: realClosePnl };
  }

  // ── RESET totale: chiudi griglie live reali + cancella tutto il DB grid ───
  async resetGrid() {
    // 1. Chiudi tutte le griglie LIVE aperte (cancella ordini + chiudi posizioni reali)
    const liveBots = await this.prisma.gridBot.findMany({ where: { status: 'open', mode: 'live' } });
    for (const b of liveBots) { try { await this.closeLiveGrid(b.id, 'reset'); } catch {} }
    // 2. Cancella TUTTE le griglie dal DB (sim + chiuse + live)
    const res = await this.prisma.gridBot.deleteMany({});
    this.lastPrices.clear();
    this.logger.log(`[GRID RESET] ${liveBots.length} griglie live chiuse · ${res.count} record DB rimossi`);
    return { liveClosed: liveBots.length, dbRemoved: res.count };
  }

  // ── Indicatori ────────────────────────────────────────────────────────────
  private calcRSI(closes: number[], period = 14): number {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period, avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private calcATR(highs: number[], lows: number[], closes: number[], period = 14): number {
    if (highs.length < period + 1) return 0;
    const trs: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      trs.push(tr);
    }
    const recent = trs.slice(-period);
    return recent.reduce((s, v) => s + v, 0) / recent.length;
  }

  private calcBollinger(closes: number[], period = 20, mult = 2): { upper: number; mid: number; lower: number; width: number } {
    if (closes.length < period) { const p = closes[closes.length - 1]; return { upper: p, mid: p, lower: p, width: 0 }; }
    const recent = closes.slice(-period);
    const mid = recent.reduce((s, v) => s + v, 0) / period;
    const variance = recent.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return { upper: mid + mult * std, mid, lower: mid - mult * std, width: (2 * mult * std) / mid };
  }

  private calcADX(highs: number[], lows: number[], closes: number[], period = 14): number {
    if (highs.length < period * 2) return 25;
    const plusDM: number[] = [], minusDM: number[] = [], tr: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const up = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      plusDM.push(up > down && up > 0 ? up : 0);
      minusDM.push(down > up && down > 0 ? down : 0);
      tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    // Wilder smoothing
    const smooth = (arr: number[]) => {
      let sum = arr.slice(0, period).reduce((s, v) => s + v, 0);
      const out = [sum];
      for (let i = period; i < arr.length; i++) { sum = sum - sum / period + arr[i]; out.push(sum); }
      return out;
    };
    const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
    const dx: number[] = [];
    for (let i = 0; i < trS.length; i++) {
      const pDI = 100 * (pS[i] / (trS[i] || 1));
      const mDI = 100 * (mS[i] / (trS[i] || 1));
      const sum = pDI + mDI;
      dx.push(sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum);
    }
    const recentDx = dx.slice(-period);
    return recentDx.reduce((s, v) => s + v, 0) / (recentDx.length || 1);
  }

  // ── API ─────────────────────────────────────────────────────────────────
  async getConfig() {
    let cfg = await this.prisma.gridConfig.findUnique({ where: { id: 1 } });
    if (!cfg) cfg = await this.prisma.gridConfig.create({ data: { id: 1 } });
    return cfg;
  }

  async updateConfig(updates: any) {
    const cfg = await this.prisma.gridConfig.update({ where: { id: 1 }, data: { ...updates } });
    this.logger.log(`[GRID CONFIG] aggiornata`);
    return cfg;
  }

  getStatus() {
    return {
      lastScanAt: this.lastScanAt,
      isScanning: this.isScanning,
      inRangePairs: this.candidates.length,
      topScore: this.candidates[0]?.score ?? 0,
    };
  }

  // Suggerimenti bilanciati: migliori 2 long + 2 short, SOLO centro-range (25-75%)
  getSuggestions(maxLong = 2, maxShort = 2) {
    const centered = this.candidates.filter(c => c.pricePos >= 0.25 && c.pricePos <= 0.75);
    const longs = centered.filter(c => c.preferredSide === 'long').slice(0, maxLong);
    const shorts = centered.filter(c => c.preferredSide === 'short').slice(0, maxShort);
    return { long: longs, short: shorts };
  }

  async getDashboard() {
    const cfg = await this.getConfig();
    const allBots = await this.prisma.gridBot.findMany({ orderBy: { openedAt: 'desc' } });
    const openBots = allBots.filter(b => b.status === 'open');
    const closedBots = allBots.filter(b => b.status === 'closed');

    // Arricchisci le griglie aperte con prezzo attuale e distanza dai bordi
    const activeBots = openBots.map(b => {
      const cand = this.candidates.find(c => c.symbol === b.symbol);
      const price = cand?.price ?? b.entryPrice;
      const pos = (price - b.rangeLow) / ((b.rangeHigh - b.rangeLow) || 1);
      const distToBreak = Math.min(price - b.rangeLow, b.rangeHigh - price) / price * 100;
      return {
        ...b,
        currentPrice: price,
        pricePos: +pos.toFixed(2),
        distToBreakPct: +distToBreak.toFixed(2),
        adx: cand?.adx ?? null,
      };
    });

    // Separa LIVE da SIM
    const liveBots = activeBots.filter(b => b.mode === 'live');
    const simBots  = activeBots.filter(b => b.mode === 'sim');
    const sumPnl = (arr: any[]) => +arr.reduce((s, b) => s + (b.realizedPnl ?? b.closePnl ?? 0), 0).toFixed(4);

    return {
      candidates: this.candidates.slice(0, 40),
      suggestions: getSuggestionsSafe(this, cfg),
      liveBots,
      simBots,
      closedBots: closedBots.slice(0, 20),
      live: {
        pnl: sumPnl(liveBots),
        cycles: liveBots.reduce((s, b) => s + b.filledCycles, 0),
        count: liveBots.length,
      },
      sim: {
        pnl: sumPnl(simBots),
        cycles: simBots.reduce((s, b) => s + b.filledCycles, 0),
        count: simBots.length,
        closedPnl: sumPnl(closedBots),
        closedCount: closedBots.length,
      },
      status: this.getStatus(),
      config: cfg,
    };
  }
}

function getSuggestionsSafe(svc: GridScannerService, cfg: any) {
  try { return svc.getSuggestions(cfg.maxLongGrids ?? 2, cfg.maxShortGrids ?? 2); }
  catch { return { long: [], short: [] }; }
}

// ── Tipi ────────────────────────────────────────────────────────────────────
export interface GridCandidate {
  symbol: string;
  base: string;
  price: number;
  vol24h: number;
  adx: number;
  rsi: number;
  atrPct: number;
  rangeLow: number;
  rangeHigh: number;
  rangePct: number;
  pricePos: number;
  touches: number;
  score: number;
  spacingPct: number;
  gridLevels: number;
  profitPerCyclePct: number;
  cyclesPerDay: number;
  dailyPct: number;
  aprEst: number;
  leverage: number;
  liquidationPct: number;
  preferredSide: 'long' | 'short';
  breakRisk: string;
}
