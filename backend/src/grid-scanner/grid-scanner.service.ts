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
  private simExtreme = new Map<string, { price: number; dir: number }>();  // sim: punto di svolta

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

        // BREAK: prezzo fuori range oppure ADX salito sopra soglia → chiudi
        const adxNow = cand?.adx ?? 0;
        if (price > bot.rangeHigh) { await this.closeSimGrid(bot.id, 'break_up', price); continue; }
        if (price < bot.rangeLow)  { await this.closeSimGrid(bot.id, 'break_down', price); continue; }
        if (cand && adxNow > cfg.exitAdx) { await this.closeSimGrid(bot.id, 'trend_adx', price); continue; }

        // CICLI (modello fedele al grid reale): un ciclo profittevole = il prezzo
        // OSCILLA (va e torna di 1 spacing). In trend non conta nulla (il grid reale
        // lì accumula, non profitta). Traccio il punto di svolta (estremo) e conto
        // i cicli solo all'INVERSIONE.
        const spacingPrice = (bot.rangeHigh - bot.rangeLow) / bot.gridLevels;
        let ext = this.simExtreme.get(bot.id) ?? { price: bot.entryPrice, dir: 0 };
        let cycles = 0;
        if (ext.dir >= 0 && price >= ext.price) {
          ext = { price, dir: 1 };                    // continua a salire → estendo estremo
        } else if (ext.dir <= 0 && price <= ext.price) {
          ext = { price, dir: -1 };                   // continua a scendere → estendo estremo
        } else {
          // INVERSIONE: il prezzo è tornato indietro → conto i livelli richiusi = cicli
          const reversal = Math.abs(price - ext.price);
          cycles = spacingPrice > 0 ? Math.floor(reversal / spacingPrice) : 0;
          if (cycles > 0) ext = { price, dir: price > ext.price ? 1 : -1 };
        }
        this.simExtreme.set(bot.id, ext);
        if (cycles > 0) {
          const notionalPerLevel = (bot.capitalUsdt * bot.leverage) / bot.gridLevels;
          const profitPerCycle = notionalPerLevel * (bot.spacingPct / 100) - notionalPerLevel * 0.0004;
          await this.prisma.gridBot.update({
            where: { id: bot.id },
            data: { realizedPnl: { increment: cycles * profitPerCycle }, filledCycles: { increment: cycles } },
          });
        }
      }

      // 2. Auto-apertura SIM: mantieni maxLong long + maxShort short (conta solo le SIM).
      //    Esclude le coppie già aperte in QUALSIASI modo (sim o live) per non duplicarle.
      if (cfg.autoTradeEnabled) {
        const allOpen = await this.prisma.gridBot.findMany({ where: { status: 'open' } });
        const simOpen = allOpen.filter(b => b.mode === 'sim');
        const openLong = simOpen.filter(b => b.side === 'long');
        const openShort = simOpen.filter(b => b.side === 'short');
        const openSymbols = new Set(allOpen.map(b => b.symbol));  // include anche le live

        const sugg = this.getSuggestions(cfg.maxLongGrids, cfg.maxShortGrids);
        for (const c of sugg.long) {
          if (openLong.length >= cfg.maxLongGrids) break;
          if (!openSymbols.has(c.symbol)) { await this.openSimGrid(c.symbol, 'long'); openSymbols.add(c.symbol); openLong.push({} as any); }
        }
        for (const c of sugg.short) {
          if (openShort.length >= cfg.maxShortGrids) break;
          if (!openSymbols.has(c.symbol)) { await this.openSimGrid(c.symbol, 'short'); openSymbols.add(c.symbol); openShort.push({} as any); }
        }
      }
    } catch (e: any) {
      this.logger.warn(`[GRID SIM] loop error: ${e?.message}`);
    }
  }

  // ── Apri una griglia simulata dal candidato in range ──────────────────────
  async openSimGrid(symbol: string, side: 'long' | 'short') {
    const cand = this.candidates.find(c => c.symbol === symbol);
    if (!cand) throw new Error(`${symbol} non è in range (nessun candidato)`);
    const cfg = await this.getConfig();
    const bot = await this.prisma.gridBot.create({
      data: {
        symbol, side, timeframe: cfg.timeframe, leverage: cfg.leverage,
        rangeLow: cand.rangeLow, rangeHigh: cand.rangeHigh, gridLevels: cand.gridLevels,
        spacingPct: cand.spacingPct, capitalUsdt: cfg.capitalPerGrid, entryPrice: cand.price,
        status: 'open',
      },
    });
    this.lastPrices.set(bot.id, cand.price);
    this.logger.log(`[GRID SIM] aperta ${side.toUpperCase()} ${cand.base} · range ${cand.rangeLow}-${cand.rangeHigh} · ~${cand.aprEst}% APR`);
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
    this.logger.log(`[GRID SIM] chiusa ${bot.side.toUpperCase()} ${bot.symbol.replace('/USDT:USDT','')} · ${reason} · cicli ${bot.filledCycles} · PnL $${bot.realizedPnl.toFixed(4)}`);
    return { closed: true, reason, pnl: bot.realizedPnl };
  }

  // ── Monitor griglie LIVE — ogni 15 secondi: rileva fill e ripiazza ────────
  @Cron('*/15 * * * * *')
  async monitorLiveGrids() {
    try {
      const bots = await this.prisma.gridBot.findMany({ where: { status: 'open', mode: 'live' } });
      for (const bot of bots) {
        try { await this.checkLiveGrid(bot); } catch (e: any) { this.logger.warn(`[GRID LIVE] ${bot.symbol}: ${e?.message?.slice(0, 50)}`); }
      }
    } catch (e: any) { this.logger.warn(`[GRID LIVE] monitor: ${e?.message}`); }
  }

  private async checkLiveGrid(bot: any) {
    const orders: any[] = bot.liveOrders ? JSON.parse(bot.liveOrders) : [];
    if (!orders.length) return;
    const cs = bot.contractSize || 1;
    const spacing = (bot.rangeHigh - bot.rangeLow) / bot.gridLevels;

    // BREAK: prezzo fuori range → chiudi tutto
    let price = this.candidates.find(c => c.symbol === bot.symbol)?.price;
    if (price == null) { try { price = Number((await this.swapExchange.fetchTicker(bot.symbol)).last); } catch { return; } }
    if (price && (price > bot.rangeHigh || price < bot.rangeLow)) {
      await this.closeLiveGrid(bot.id, price > bot.rangeHigh ? 'break_up' : 'break_down');
      return;
    }

    // Match per PREZZO (l'id da create è rotto su MEXC): un ordine salvato che non
    // ha più un ordine aperto al suo prezzo (entro mezzo spacing) = è stato riempito.
    const openOrders = await this.swapExchange.fetchOpenOrders(bot.symbol);
    const tol = spacing * 0.4;
    const isStillOpen = (p: number) => openOrders.some((o: any) => Math.abs(Number(o.price) - p) < tol);

    let pnlAdd = 0, cyclesAdd = 0, changed = false;
    const newOrders: any[] = [];

    for (const ord of orders) {
      if (isStillOpen(ord.price)) { newOrders.push(ord); continue; }
      // riempito → ripiazza l'ordine OPPOSTO un gradino dall'altra parte
      changed = true;
      // In LONG grid: SELL riempito = profitto (venduto in alto), ripiazza BUY sotto.
      //               BUY riempito = ricomprato, ripiazza SELL sopra (reduceOnly).
      // In SHORT grid: BUY riempito = profitto (ricomprato in basso), ripiazza SELL sopra.
      //                SELL riempito = rishortato, ripiazza BUY sotto (reduceOnly).
      const isProfitFill = (bot.side === 'long' && ord.side === 'sell') || (bot.side === 'short' && ord.side === 'buy');
      if (isProfitFill) { pnlAdd += spacing * bot.contractsPerLevel * cs; cyclesAdd += 1; }

      try {
        if (bot.side === 'long') {
          if (ord.side === 'sell') {
            const np = Number(this.swapExchange.priceToPrecision(bot.symbol, ord.price - spacing));
            if (np > bot.rangeLow && !isStillOpen(np)) { await this.swapExchange.createLimitBuyOrder(bot.symbol, bot.contractsPerLevel, np, { openType: 1, positionType: 1, leverage: bot.leverage }); newOrders.push({ price: np, side: 'buy' }); }
          } else {
            const np = Number(this.swapExchange.priceToPrecision(bot.symbol, ord.price + spacing));
            if (np < bot.rangeHigh && !isStillOpen(np)) { await this.swapExchange.createLimitSellOrder(bot.symbol, bot.contractsPerLevel, np, { openType: 1, positionType: 1, leverage: bot.leverage, reduceOnly: true }); newOrders.push({ price: np, side: 'sell' }); }
          }
        } else {
          if (ord.side === 'buy') {
            const np = Number(this.swapExchange.priceToPrecision(bot.symbol, ord.price + spacing));
            if (np < bot.rangeHigh && !isStillOpen(np)) { await this.swapExchange.createLimitSellOrder(bot.symbol, bot.contractsPerLevel, np, { openType: 1, positionType: 2, leverage: bot.leverage }); newOrders.push({ price: np, side: 'sell' }); }
          } else {
            const np = Number(this.swapExchange.priceToPrecision(bot.symbol, ord.price - spacing));
            if (np > bot.rangeLow && !isStillOpen(np)) { await this.swapExchange.createLimitBuyOrder(bot.symbol, bot.contractsPerLevel, np, { openType: 1, positionType: 2, leverage: bot.leverage, reduceOnly: true }); newOrders.push({ price: np, side: 'buy' }); }
          }
        }
      } catch (e: any) { this.logger.warn(`[GRID LIVE] ripiazzo: ${e?.message?.slice(0, 40)}`); }
    }

    if (changed) {
      if (pnlAdd > 0) this.logger.log(`[GRID LIVE] ${bot.symbol.replace('/USDT:USDT','')} +${cyclesAdd} cicli · +$${pnlAdd.toFixed(4)}`);
      await this.prisma.gridBot.update({
        where: { id: bot.id },
        data: { liveOrders: JSON.stringify(newOrders), realizedPnl: { increment: pnlAdd }, filledCycles: { increment: cyclesAdd } },
      });
    }
  }

  // ── Apri griglia LIVE BIDIREZIONALE: posizione base + buy sotto + sell sopra ─
  async openLiveGrid(symbol: string, side: 'long' | 'short', marginUsdt: number, liveLevels = 6) {
    const cand = this.candidates.find(c => c.symbol === symbol);
    if (!cand) throw new Error(`${symbol} non è in range`);
    const cfg = await this.getConfig();
    const leverage = cfg.leverage;
    const market = this.swapExchange.market(symbol);
    const cs = Number((market as any)?.contractSize ?? 1) || 1;
    const minContracts = Number((market as any)?.limits?.amount?.min ?? 1) || 1;

    const price = cand.price;
    const low = cand.rangeLow, high = cand.rangeHigh;
    const spacing = (high - low) / liveLevels;
    const pricePos = (price - low) / ((high - low) || 1);

    // 1. CENTRO RANGE: il prezzo deve stare al 25-75% così la griglia è bilanciata
    if (pricePos < 0.25 || pricePos > 0.75)
      throw new Error(`${cand.base} prezzo al ${(pricePos * 100).toFixed(0)}% del range (serve 25-75% per griglia bilanciata)`);

    // 2. Livelli EQUIDISTANTI centrati sul prezzo: il primo a ±0.5 spacing dal
    //    prezzo (così nessuno si riempie all'apertura), poi ogni spacing costante.
    //    Nessun buco al centro → griglia perfettamente uniforme sopra e sotto.
    const half = spacing * 0.5;
    const maxPerSide = Math.ceil(liveLevels / 2);
    const above: number[] = [];   // SELL (sopra il prezzo)
    const below: number[] = [];   // BUY (sotto il prezzo)
    for (let k = 0; k < maxPerSide; k++) {
      const sp = price + half + spacing * k;
      if (sp < high) above.push(Number(this.swapExchange.priceToPrecision(symbol, sp)));
      const bp = price - half - spacing * k;
      if (bp > low) below.push(Number(this.swapExchange.priceToPrecision(symbol, bp)));
    }
    const levels = [...new Set([...above, ...below])];     // dedup
    const totalOrders = above.length + below.length;
    if (totalOrders < 2) throw new Error(`troppi pochi livelli utili (${totalOrders}) — riduci spacing o cambia coppia`);

    // 3. Contratti/livello: margine TOTALE / ordini effettivi (posizione max = tutti pieni)
    const contractsPerLevel = Math.max(minContracts, Math.round((marginUsdt * leverage / totalOrders / price) / cs));
    const realNotionalPerLevel = contractsPerLevel * cs * price;
    const realMarginTotal = (realNotionalPerLevel * totalOrders) / leverage;
    if (realNotionalPerLevel < 1) throw new Error(`notional/livello ${realNotionalPerLevel.toFixed(2)}$ < minimo 1$ — aumenta margine`);

    try { await this.swapExchange.setLeverage(leverage, symbol, { openType: 1, positionType: side === 'long' ? 1 : 2 }); } catch {}

    const liveOrders: any[] = [];

    // NB: l'id da createLimitOrder è rotto su MEXC → salvo solo {price, side} e il
    // monitor confronta per PREZZO (affidabile) con fetchOpenOrders.
    if (side === 'long') {
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
    this.logger.log(`[GRID LIVE OPEN] ${side.toUpperCase()} ${cand.base} · ${liveOrders.length} ordini (${above.length} sell + ${below.length} buy) · margine tot ~$${realMarginTotal.toFixed(2)} · ${contractsPerLevel}c/lvl`);
    return { bot, ordersPlaced: liveOrders.length, sellOrders: above.length, buyOrders: below.length, contractsPerLevel, notionalPerLevel: +realNotionalPerLevel.toFixed(2), marginTotal: +realMarginTotal.toFixed(2) };
  }

  // ── Chiudi griglia LIVE: cancella ordini + chiudi posizione residua ───────
  async closeLiveGrid(botId: string, reason: string) {
    const bot = await this.prisma.gridBot.findUnique({ where: { id: botId } });
    if (!bot || bot.status !== 'open') return;
    try {
      // cancella tutti gli ordini aperti della coppia
      const openOrders = await this.swapExchange.fetchOpenOrders(bot.symbol);
      for (const o of openOrders) { try { await this.swapExchange.cancelOrder(o.id, bot.symbol); } catch {} }
      // chiudi posizione residua
      const positions = (await this.swapExchange.fetchPositions([bot.symbol])).filter((p: any) => Math.abs(Number(p.contracts || 0)) > 0);
      for (const p of positions) {
        const c = Math.abs(Number(p.contracts));
        try {
          if (p.side === 'long') await this.swapExchange.createMarketSellOrder(bot.symbol, c, { reduceOnly: true });
          else await this.swapExchange.createMarketBuyOrder(bot.symbol, c, { reduceOnly: true });
        } catch (e: any) { this.logger.warn(`[GRID LIVE CLOSE] pos: ${e?.message?.slice(0, 40)}`); }
      }
    } catch (e: any) { this.logger.warn(`[GRID LIVE CLOSE] ${e?.message?.slice(0, 50)}`); }
    await this.prisma.gridBot.update({
      where: { id: botId },
      data: { status: 'closed', closeReason: reason, closePnl: bot.realizedPnl, closedAt: new Date() },
    });
    this.logger.log(`[GRID LIVE CLOSE] ${bot.symbol} · ${reason} · cicli ${bot.filledCycles} · PnL $${bot.realizedPnl.toFixed(4)}`);
    return { closed: true, reason, pnl: bot.realizedPnl };
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
