import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramClientService, IncomingMessage } from './telegram-client.service';
import { SignalParserService, ParsedSignal } from './signal-parser.service';
import { OrderExecutorService } from './order-executor.service';
import { GemmaService } from '../gemma/gemma.service';

// ── Orchestratore Telegram Signals ──────────────────────────────────────────
// GramJS (messaggio) → Gemini (parse) → risk/normalizzazione → esecuzione
// sim|live PER-CANALE. UPDATE/CLOSE legati all'ultimo trade aperto DI QUEL canale.
//
// NOTA sim: i TP multipli parziali sono gestiti nativamente dall'exchange solo in
// LIVE. In SIM approssimiamo con TP1 (win) / SL (loss) a chiusura piena — il monitor
// non replica le chiusure parziali. La logica live invece attacca SL + N TP parziali.

@Injectable()
export class TgSignalsService implements OnModuleInit {
  private readonly logger = new Logger(TgSignalsService.name);
  private lastDialogSyncAt = 0;
  private syncingDialogs = false;
  private monitoringLive = false;   // guardia: niente run sovrapposti del monitor live (gira ogni 2s)

  constructor(
    private prisma: PrismaService,
    private tg: TelegramClientService,
    private parser: SignalParserService,
    private executor: OrderExecutorService,
    private gemma: GemmaService,
  ) {}

  onModuleInit() {
    this.tg.onMessage((msg) => this.handleIncoming(msg).catch((e) => this.logger.warn(`[TGS] handle: ${e?.message?.slice(0, 80)}`)));
    setTimeout(() => this.syncDialogs(true).catch((e) => this.logger.warn(`[TGS] sync dialogs: ${e?.message?.slice(0, 80)}`)), 15000);
    // Catch-up all'avvio: recupera i segnali arrivati durante il downtime del restart
    // (finestra in cui il listener realtime è offline) senza aspettare il poll dei 5 min.
    setTimeout(() => this.pollTelegramMessages(15).catch((e) => this.logger.warn(`[TGS] catch-up poll: ${e?.message?.slice(0, 80)}`)), 45000);
  }

  // ── Ingresso messaggio ────────────────────────────────────────────────────
  private async handleIncoming(msg: IncomingMessage) {
    const channel = await this.ensureChannelForMessage(msg);
    if (!channel.enabled) return;                 // canale disattivato manualmente
    // dedup: stesso messaggio già processato
    const rawText = msg.text.slice(0, 4000);
    const dup = await this.prisma.tgSignal.findFirst({
      where: { channelDbId: channel.id, tgMessageId: msg.messageId },
      orderBy: { createdAt: 'desc' },
    });
    if (dup) {
      const textChanged = dup.rawText !== rawText;
      // Messaggio MODIFICATO in un'istruzione di uscita → chiudi il trade aperto del canale.
      if (textChanged && this.isCloseInstruction(msg.text)) {
        const open = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tradeStatus: { in: ['open', 'pending'] } }, orderBy: { createdAt: 'desc' } });
        if (open) { await this.closeTrade(open, 'close'); this.logger.log(`[TGS] CLOSE da messaggio modificato → ${open.symbol}`); return; }
      }
      const changedSkippedSignal = textChanged && dup.status === 'skipped' && dup.tradeStatus === 'none';
      // Edit su un trade aperto con SL di default → ri-processa per applicare lo SL/TP vero.
      const editOnDefaultSl = textChanged && dup.tradeStatus === 'open';   // edit su trade aperto → ri-processa per aggiornare SL/TP
      if (!changedSkippedSignal && !editOnDefaultSl) return;
    }
    if (msg.title && channel.title !== msg.title) {
      await this.prisma.tgChannel.update({ where: { id: channel.id }, data: { title: msg.title } }).catch(() => {});
    }

    // PRE-FILTRO ECONOMICO (zero Gemini): prendiamo SOLO i segnali. Tutto ciò che non
    // ha la forma di un segnale operativo (promo, chiacchiere, news, risultati VIP)
    // viene scartato senza chiamare Gemini → drastico taglio delle richieste.
    if (!this.looksLikeSignal(msg.text)) {
      await this.prisma.tgSignal.create({ data: {
        channelDbId: channel.id, tgMessageId: msg.messageId, rawText,
        parsed: '{}', type: 'RUMORE', status: 'skipped', note: 'pre-filtro: non è un segnale (no Gemini)',
      } });
      return;
    }

    const memory = await this.getPromptMemory();
    const parsed = await this.parser.parse(msg.text, memory.summary, { riskPct: channel.riskPct, leverageMax: channel.levaMax });
    // Override leva dal testo grezzo: Gemini a volte sbaglia (es. "SHORT 20X" letto come 10).
    const rawLev = this.extractLeverage(msg.text);
    if (rawLev != null) parsed.leverage = rawLev;
    else parsed.leverage = Math.max(50, Number(parsed.leverage) || 0);   // leva non scritta nel segnale → default alto (50)
    // CLOSE robusto: se il messaggio dice chiaramente di uscire/chiudere e NON e' un nuovo
    // ingresso, forza la chiusura (override su eventuale errore di classificazione Gemini).
    if (parsed.type !== 'NEW' && this.isCloseInstruction(msg.text)) parsed.type = 'CLOSE';
    const rec = await this.prisma.tgSignal.create({
      data: {
        channelDbId: channel.id, tgMessageId: msg.messageId, rawText,
        parsed: JSON.stringify(parsed), type: parsed.type,
        symbol: parsed.symbol, side: parsed.side, confidence: parsed.confidence,
        status: 'parsed',
      },
    });

    if (parsed.type === 'NEW') return this.executeNew(channel, rec.id, parsed);
    if (parsed.type === 'UPDATE') return this.applyUpdate(channel, rec.id, parsed);
    if (parsed.type === 'CLOSE') return this.applyClose(channel, rec.id);
    // RUMORE (Gemini ha visto che non era operativo) → scarto, niente news-brain.
    return void (await this.prisma.tgSignal.update({ where: { id: rec.id }, data: { status: 'skipped', note: 'non operativo' } }));
  }

  // Riconosce a regex (zero costo) se un messaggio ha la forma di un segnale/gestione
  // trade. Serve solo a decidere SE chiamare Gemini, non a interpretare il segnale.
  private looksLikeSignal(text: string): boolean {
    const t = (text || '').toLowerCase();
    if (!t.trim()) return false;
    // serve una direzione/azione operativa…
    const action = /\b(long|short|buy|sell|compra|vendi|close|chiudi|exit|breakeven|break\s*even)\b/.test(t);
    // …oppure i campi tipici di un setup (entry/sl/tp/target/leva)
    const fields = /\b(entry|entrata|sl|stop[\s_-]*loss|tp\d?|take[\s_-]*profits?|targets?|leverage|leva)\b/.test(t);
    return action || fields;
  }

  // Estrae la leva dichiarata nel testo grezzo (es. "20X", "leva 20", "cross 20x").
  // Override usato quando Gemini sbaglia la leva del segnale.
  private extractLeverage(text: string): number | null {
    const t = (text || '').toLowerCase();
    const m =
      t.match(/(\d{1,3})\s*x\b/) ||                                  // "20x", "20 x"
      t.match(/\bx\s*(\d{1,3})\b/) ||                                // "x20"
      t.match(/(?:lev(?:erage|a)?|cross|isolated)\s*:?\s*(\d{1,3})/); // "leva 20", "leverage: 20"
    if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 125) return n; }
    return null;
  }

  // Vero solo se il messaggio e' una vera ISTRUZIONE di chiusura/uscita del trade
  // (es. "Exit #AGLD", "close the trade", "chiudi", "book profit"), non una menzione
  // casuale di "close" (es. "candle close above").
  private isCloseInstruction(text: string): boolean {
    const t = (text || '').toLowerCase();
    return /\b(exit|close)\s+(the\s+|this\s+|now|all|trade|position|#|\$)/.test(t)
        || /\b(chiudi|chiudere|esci|uscire)\b/.test(t)
        || /\b(book|take)\s+profit\b/.test(t);
  }

  private async ensureChannelForMessage(msg: IncomingMessage) {
    const skipCodes = this.isCodesChannel(msg.title);
    return this.prisma.tgChannel.upsert({
      where: { channelId: msg.channelId },
      create: {
        channelId: msg.channelId,
        title: msg.title ?? null,
        enabled: !skipCodes,
        mode: 'sim',
        riskPct: 4.0,
        levaMax: 20,
        minConf: 0.6,
        tpSplit: '50,30,20',
      },
      update: {
        ...(msg.title ? { title: msg.title } : {}),
        ...(skipCodes ? { enabled: false } : {}),
      },
    });
  }

  private isCodesChannel(...parts: Array<string | null | undefined>) {
    const text = parts.filter(Boolean).join(' ').toLowerCase();
    return /\b(codice|codici|code|codes|otp|2fa)\b/.test(text);
  }

  private async syncDialogs(force = false) {
    const now = Date.now();
    if (this.syncingDialogs) return;
    if (!force && now - this.lastDialogSyncAt < 60_000) return;
    this.lastDialogSyncAt = now;

    const status = this.tg.status();
    if (!status.connected) return;

    this.syncingDialogs = true;
    try {
      const dialogs = await this.tg.listDialogs();
      // id normalizzato (toglie -100/segno): i record creati dal realtime usano un
      // formato diverso da quello dei dialoghi → confronto su forma normalizzata.
      const norm = (s: string | null | undefined) => String(s ?? '').replace(/^-100/, '').replace(/^-/, '');
      const liveNorm = new Set(dialogs.map((d) => norm(d.id)));
      let added = 0;
      for (const d of dialogs) {
        const skipCodes = this.isCodesChannel(d.title, d.username);
        const rec = await this.prisma.tgChannel.upsert({
          where: { channelId: d.id },
          create: {
            channelId: d.id,
            username: d.username ?? null,
            title: d.title ?? null,
            enabled: !skipCodes,
            mode: 'sim',
            riskPct: 4.0,
            levaMax: 20,
            minConf: 0.6,
            tpSplit: '50,30,20',
          },
          update: {
            username: d.username ?? null,
            title: d.title ?? null,
            enabled: !skipCodes,   // mirror: sei iscritto → attivo (salvo canale di codici/OTP)
          },
        });
        if (rec.createdAt.getTime() === rec.updatedAt.getTime()) added++;
      }
      if (added) this.logger.log(`[TGS] auto-registrati ${added} canali Telegram`);

      // Mirror dell'iscrizione: disabilita i canali che NON sono piu nei tuoi dialoghi
      // (lasciati/eliminati su Telegram). GUARDIA: se i dialoghi tornano vuoti (errore
      // transitorio) NON disabilita nulla, per non spegnere tutto per sbaglio.
      if (dialogs.length) {
        const enabledChans = await this.prisma.tgChannel.findMany({ where: { enabled: true } });
        const stale = enabledChans.filter((c) => !liveNorm.has(norm(c.channelId)));
        if (stale.length) {
          await this.prisma.tgChannel.updateMany({ where: { id: { in: stale.map((c) => c.id) } }, data: { enabled: false } });
          this.logger.log(`[TGS] disabilitati ${stale.length} canali non piu nei dialoghi: ${stale.map((c) => c.title ?? c.channelId).join(', ').slice(0, 200)}`);
        }
      }
    } finally {
      this.syncingDialogs = false;
    }
  }

  // ── NEW: apri trade (sim|live) ────────────────────────────────────────────
  private async getPromptMemory() {
    return this.prisma.tgPromptMemory.upsert({
      where: { id: 1 },
      create: { id: 1, summary: '' },
      update: {},
    });
  }

  private async learnFromNonSignal(recId: string, rawText: string, parsed: ParsedSignal, currentMemory: string, sourceLabel = '') {
    const analysis = await this.parser.analyzeNews(rawText, currentMemory, sourceLabel);
    const merged = { ...parsed, brain: analysis };

    if (analysis.relevant) {
      await this.prisma.tgPromptMemory.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          summary: analysis.promptMemory,
          lastNews: analysis.summary,
          lastAnalysis: JSON.stringify(analysis),
        },
        update: {
          summary: analysis.promptMemory,
          lastNews: analysis.summary,
          lastAnalysis: JSON.stringify(analysis),
        },
      });
    }

    await this.prisma.tgSignal.update({
      where: { id: recId },
      data: {
        parsed: JSON.stringify(merged),
        status: analysis.relevant ? 'context' : 'skipped',
        note: analysis.relevant
          ? `brain aggiornato (${analysis.kind}, conf ${analysis.confidence})`
          : `saltato: ${analysis.kind.toLowerCase()}`,
      },
    });
  }

  private async executeNew(channel: any, recId: string, p: ParsedSignal) {
    const skip = (note: string) => this.prisma.tgSignal.update({ where: { id: recId }, data: { status: 'skipped', note } });

    if (p.confidence < channel.minConf) return void (await skip(`confidenza ${p.confidence} < soglia ${channel.minConf}`));
    if (!p.side) return void (await skip('direzione non riconosciuta'));
    // SL mancante: NON skippiamo piu' — si entra lo stesso (simbolo+leva) e si mette uno
    // SL di default (100% margine = distanza 1/leva), poi si aggiorna quando arriva lo SL vero.
    const symbol = p.symbol ? this.executor.resolveSymbol(p.symbol) : null;
    if (!symbol) return void (await skip(`simbolo non mappabile: ${p.symbol}`));

    // No duplicati: blocca solo lo STESSO symbol+side già aperto su questo canale
    // (coin diversi sullo stesso canale sono permessi → prima li skippava tutti).
    const dupSameSymbol = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, symbol, side: p.side, tradeStatus: { in: ['open', 'pending'] } } });
    if (dupSameSymbol) {
      // Trade aperto con SL di default e ora arriva lo SL vero → aggiorna SL/TP (non riapre).
      if (p.sl != null && dupSameSymbol.mode === 'live') {
        const tpSplitU = String(channel.tpSplit).split(',').map((x: string) => Number(x.trim())).filter((x) => x > 0);
        try { await this.executor.attachStops(symbol, p.side as any, dupSameSymbol.qty ?? 0, p.sl, p.tps, tpSplitU); } catch (e: any) { this.logger.warn(`[TGS] update SL/TP ${symbol}: ${e?.message?.slice(0, 60)}`); }
        await this.prisma.tgSignal.update({ where: { id: dupSameSymbol.id }, data: { stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), note: String(dupSameSymbol.note ?? '').replace(' · SL-default', '') + ' · SL/TP aggiornati' } });
        return void (await skip(`SL/TP veri applicati su ${symbol} (era SL-default)`));
      }
      return void (await skip(`già un trade ${p.side} aperto su ${symbol} (no duplicato)`));
    }

    if (channel.mode === 'live') {
      const liveConflict = await this.prisma.tgSignal.findFirst({
        where: { symbol, mode: 'live', tradeStatus: { in: ['open', 'pending'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (liveConflict) {
        return void (await skip(`live gia attivo su ${symbol} da altro canale: non tocco posizione/SL/TP`));
      }
    }

    if (p.leverage == null) return void (await skip('leva Gemini mancante'));
    const leverage = this.resolveLeverage(p.leverage, channel.levaMax);
    const tpSplit = String(channel.tpSplit).split(',').map((x: string) => Number(x.trim())).filter((x) => x > 0);

    // Decisione entrata: se il prezzo è nella ZONA d'entrata → MARKET subito;
    // altrimenti LIMIT al prezzo d'entrata (con SL/TP preimpostati).
    const livePrice = await this.executor.getPrice(symbol);
    const zone = this.entryZone(p);
    let entryType: 'market' | 'limit' = p.entryType;
    let entryPrice: number | null = p.entryPrice;
    if (livePrice && zone && this.priceNearZone(livePrice, zone)) {
      entryType = 'market'; entryPrice = null;
    } else if (p.entryPrice != null) {
      entryType = 'limit'; entryPrice = p.entryPrice;
    } else {
      entryType = 'market'; entryPrice = null;
    }
    const entryRef = (entryType === 'limit' && entryPrice) ? entryPrice : (livePrice ?? entryPrice);
    if (!entryRef) return void (await skip('prezzo entry non disponibile'));
    // SL di default se mancante: distanza 1/leva dall'entry → se toccato perdi il 100% del
    // margine ("tanto quello e'"). Verra' aggiornato quando arriva lo SL vero (edit/UPDATE).
    let slIsDefault = false;
    if (p.sl == null) {
      p.sl = p.side === 'long' ? entryRef * (1 - 1 / leverage) : entryRef * (1 + 1 / leverage);
      slIsDefault = true;
    }
    // Protezione valida rispetto al prezzo d'ingresso effettivo. Con TP assenti si entra
    // comunque (SL only): la gestione d'uscita arriva dai messaggi del canale.
    if (!this.executor.protectionIsValid(p.side, entryRef, p.sl, p.tps)) {
      return void (await skip(`SL/TP incoerenti con entry ${entryRef}: SL=${p.sl} TP=${p.tps.join('/')}`));
    }

    if (channel.mode === 'live') {
      const r = await this.executor.openLive({ symbol, side: p.side, entryType, entryPrice: (entryType === 'market' ? entryRef : entryPrice) ?? undefined, sl: p.sl, tps: p.tps, tpSplit, riskPct: channel.riskPct, leverage });
      if (!r.ok) return void (await skip(`live: ${r.error}`));
      const tradeStatus = (r.positionId || entryType === 'market') ? 'open' : 'pending';
      const note = (r.positionId ? `live posId ${r.positionId}` : r.preset ? 'live limit preset (SL/TP sull-ordine)' : 'live pending limit') + (slIsDefault ? ' · SL-default' : '');
      await this.prisma.tgSignal.update({ where: { id: recId }, data: {
        status: 'executed', mode: 'live', tradeStatus, symbol, side: p.side,
        entry: r.entry, stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), qty: r.qty, leverage, riskUsd: r.riskUsd,
        note,
      } });
      this.logger.log(`[TGS LIVE] ${channel.username ?? channel.channelId} → ${entryType} ${p.side} ${symbol} qty ${r.qty}`);
    } else {
      const sm = await this.executor.sizeByMargin(symbol, entryRef, leverage);
      const qty = sm.qty; const riskUsd = Math.abs(entryRef - p.sl) * qty * sm.cs;
      await this.prisma.tgSignal.update({ where: { id: recId }, data: {
        status: 'executed', mode: 'sim', tradeStatus: 'open', symbol, side: p.side,
        entry: entryRef, stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), qty, leverage, riskUsd,
        note: `sim ${entryType}${slIsDefault ? ' · SL-default' : ''}`,
      } });
      this.logger.log(`[TGS SIM] ${channel.username ?? channel.channelId} → ${entryType} ${p.side} ${symbol} qty ${qty} entry ${entryRef}`);
    }
  }

  // Zona d'entrata: range esplicito se presente, altrimenti banda ±0.15% sul prezzo singolo.
  private entryZone(p: ParsedSignal): { lo: number; hi: number } | null {
    if (p.entryLow != null && p.entryHigh != null) return { lo: Math.min(p.entryLow, p.entryHigh), hi: Math.max(p.entryLow, p.entryHigh) };
    if (p.entryPrice != null) { const tol = Math.abs(p.entryPrice) * 0.0035; return { lo: p.entryPrice - tol, hi: p.entryPrice + tol }; }
    return null;
  }

  private priceNearZone(price: number, zone: { lo: number; hi: number }) {
    const mid = (zone.lo + zone.hi) / 2;
    const width = Math.max(zone.hi - zone.lo, Math.abs(mid) * 0.0035);
    const buffer = Math.max(Math.abs(mid) * 0.0035, width * 0.25);
    return price >= zone.lo - buffer && price <= zone.hi + buffer;
  }

  // ── UPDATE: sposta SL (BE) sul trade aperto del canale ────────────────────
  private async applyUpdate(channel: any, recId: string, p: ParsedSignal) {
    const open = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tradeStatus: { in: ['open', 'pending'] } }, orderBy: { createdAt: 'desc' } });
    if (!open) return void (await this.prisma.tgSignal.update({ where: { id: recId }, data: { status: 'skipped', note: 'UPDATE senza trade aperto' } }));

    const newSl = p.newSl ?? null;
    if (newSl != null && open.symbol && open.side) {
      if (open.mode === 'live') {
        try { await this.executor.attachStops(open.symbol, open.side as any, open.qty ?? 0, newSl, JSON.parse(open.takeProfits ?? '[]'), String(channel.tpSplit).split(',').map(Number)); } catch {}
      }
      await this.prisma.tgSignal.update({ where: { id: open.id }, data: { stopLoss: newSl, reason: 'update' } });
    }
    await this.prisma.tgSignal.update({ where: { id: recId }, data: { status: 'executed', note: newSl != null ? `SL → ${newSl}` : 'update senza nuovo SL' } });
  }

  // ── CLOSE: chiudi il trade aperto del canale ──────────────────────────────
  private async applyClose(channel: any, recId: string) {
    const open = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tradeStatus: { in: ['open', 'pending'] } }, orderBy: { createdAt: 'desc' } });
    if (!open) return void (await this.prisma.tgSignal.update({ where: { id: recId }, data: { status: 'skipped', note: 'CLOSE senza trade aperto' } }));
    await this.closeTrade(open, 'close');
    await this.prisma.tgSignal.update({ where: { id: recId }, data: { status: 'executed', note: `chiuso ${open.symbol}` } });
  }

  // Chiude un trade (sim o live) al prezzo corrente.
  private async closeTrade(t: any, reason: string) {
    const price = (t.symbol ? await this.executor.getPrice(t.symbol) : null) ?? t.entry ?? 0;
    if (t.mode === 'live' && t.symbol && t.side) await this.executor.closeLive(t.symbol, t.side, t.qty ?? undefined);
    const pnl = this.pnlOf(t, price);
    await this.prisma.tgSignal.update({ where: { id: t.id }, data: { tradeStatus: 'closed', exitPrice: price, pnl, reason, closedAt: new Date() } });
    this.logger.log(`[TGS] CHIUSO ${t.mode} ${t.symbol} ${reason} · pnl ~$${pnl.toFixed(4)}`);
  }

  private pnlOf(t: any, exit: number): number {
    const dir = t.side === 'long' ? 1 : -1;
    return (exit - (t.entry ?? exit)) * dir * (t.qty ?? 0);   // cs≈1 per la stima sim; live usa il PnL reale dell'exchange
  }

  // ── Monitor SIM: TP1 (win) / SL (loss) a chiusura piena ───────────────────
  @Cron('*/30 * * * * *')
  async monitorSim() {
    const open = await this.prisma.tgSignal.findMany({ where: { tradeStatus: 'open', mode: 'sim' } });
    for (const t of open) {
      try {
        if (!t.symbol || !t.side) continue;
        const price = await this.executor.getPrice(t.symbol);
        if (!price) continue;
        const tps: number[] = JSON.parse(t.takeProfits ?? '[]');
        const tp1 = tps[0];
        const hitTp = tp1 != null && (t.side === 'long' ? price >= tp1 : price <= tp1);
        const hitSl = t.stopLoss != null && (t.side === 'long' ? price <= t.stopLoss : price >= t.stopLoss);
        if (!hitTp && !hitSl) continue;
        const exit = hitTp ? tp1 : t.stopLoss!;
        const pnl = this.pnlOf(t, exit);
        await this.prisma.tgSignal.update({ where: { id: t.id }, data: { tradeStatus: hitTp ? 'win' : 'loss', exitPrice: exit, pnl, reason: hitTp ? 'tp' : 'sl', closedAt: new Date() } });
        this.logger.log(`[TGS SIM] ${t.symbol} ${hitTp ? 'WIN' : 'LOSS'} · ${t.entry} → ${exit} · $${pnl.toFixed(4)}`);
      } catch {}
    }
  }

  @Cron('*/2 * * * * *')
  async monitorLiveStops() {
    if (this.monitoringLive) return;   // evita run sovrapposti (ora gira ogni 2s)
    this.monitoringLive = true;
    try {
    const open = await this.prisma.tgSignal.findMany({
      where: { tradeStatus: { in: ['open', 'pending'] }, mode: 'live' },
    });

    for (const t of open) {
      try {
        if (!t.symbol || !t.side || !t.qty || !t.stopLoss) continue;

        // Limit con SL PREIMPOSTATO sull'ordine. Appena si riempie (posizione esiste)
        // attacca SL + TP PARZIALI (come il market). Se l'ordine sparisce senza
        // posizione → no_fill.
        if (/preset/i.test(String(t.note ?? ''))) {
          const pos = await this.executor.getOpenPosition(t.symbol, t.side as any);
          if (pos) {
            const tpsP: number[] = JSON.parse(t.takeProfits ?? '[]');
            const ch = await this.prisma.tgChannel.findUnique({ where: { id: t.channelDbId } });
            const split = String(ch?.tpSplit ?? '50,30,20').split(',').map(Number).filter((x) => x > 0);
            const posId = await this.executor.attachStops(t.symbol, t.side as any, t.qty, t.stopLoss, tpsP, split);
            await this.prisma.tgSignal.update({ where: { id: t.id }, data: { tradeStatus: 'open', note: `live posId ${posId ?? 'n/d'} (SL+TP parziali)` } });
            this.logger.log(`[TGS LIVE] fill limit ${t.symbol} → SL+TP parziali attaccati posId ${posId}`);
          } else if (!(await this.executor.hasOpenOrder(t.symbol)) && !(await this.executor.hasStopOrders(t.symbol))) {
            await this.prisma.tgSignal.update({ where: { id: t.id }, data: { tradeStatus: 'closed', reason: 'no_fill', note: 'chiuso: limit preset non riempito', closedAt: new Date() } });
          }
          continue;
        }

        const tps: number[] = JSON.parse(t.takeProfits ?? '[]');
        const position = await this.executor.getOpenPosition(t.symbol, t.side as any);
        if (!position) {
          const hasOrder = await this.executor.hasOpenOrder(t.symbol);
          const hasStops = await this.executor.hasStopOrders(t.symbol);
          if (!hasOrder && !hasStops) {
            const hadPosition = /posId\s+(?!n\/d)/i.test(String(t.note ?? ''));
            await this.prisma.tgSignal.update({
              where: { id: t.id },
              data: {
                tradeStatus: 'closed',
                reason: hadPosition ? 'external_close' : 'no_fill',
                note: hadPosition ? 'chiuso: posizione live non piu presente' : 'chiuso: nessuna posizione/ordine live trovato',
                closedAt: new Date(),
              },
            });
          }
          continue;
        }

        const protectedNow = await this.executor.hasProtection(t.symbol, position.positionId, tps.length > 0);
        if (protectedNow) {
          if (!/posId\s+(?!n\/d)/i.test(String(t.note ?? '')) && position.positionId) {
            await this.prisma.tgSignal.update({
              where: { id: t.id },
              data: { tradeStatus: 'open', note: `live posId ${position.positionId}` },
            });
          }
          // BE automatico: appena TP1 viene toccato (parziale riempito → volume ridotto)
          // sposta lo SL a entry, una sola volta.
          await this.maybeMoveToBreakeven(t, position, tps);
          continue;
        }

        const channel = await this.prisma.tgChannel.findUnique({ where: { id: t.channelDbId } });
        const tpSplit = String(channel?.tpSplit ?? '50,30,20').split(',').map(Number).filter((x) => x > 0);
        const posId = await this.executor.attachStops(t.symbol, t.side as any, t.qty, t.stopLoss, tps, tpSplit);
        if (!posId) continue;

        await this.prisma.tgSignal.update({
          where: { id: t.id },
          data: { tradeStatus: 'open', note: `live posId ${posId}` },
        });
        this.logger.log(`[TGS LIVE] SL/TP agganciati post-fill ${t.symbol} posId ${posId}`);
      } catch (e: any) {
        const msg = String(e?.message ?? '');
        this.logger.warn(`[TGS LIVE] monitor SL/TP: ${msg.slice(0, 80)}`);
        if (/protection_|price of stop-limit order error/i.test(msg) && t.symbol && t.side) {
          await this.closeTrade(t, 'protection_failed');
          await this.prisma.tgSignal.update({
            where: { id: t.id },
            data: { note: `chiuso: protezione non valida (${msg.slice(0, 90)})` },
          });
        }
      }
    }
    } finally { this.monitoringLive = false; }
  }

  // ── BE automatico: TP1 toccato → SL a entry (una sola volta) ──────────────
  // Rileva il tocco di TP1 dal calo del volume della posizione (il TP1 parziale
  // nativo si e' riempito). Poi riaggancia SL=entry sul volume residuo, mantenendo
  // i TP ancora davanti al prezzo. Errori (es. protezione non valida per un rapido
  // ritracciamento) vengono inghiottiti qui: NON propagano al monitor, cosi non
  // possono causare chiusure indesiderate; si ritenta al tick successivo.
  private async maybeMoveToBreakeven(t: any, position: { contracts: number; markPrice?: number; positionId?: string }, tps: number[]) {
    if (tps.length < 2) return;                                  // 1 solo TP: al fill chiude tutto, niente BE
    if (/\bBE\b/.test(String(t.note ?? ''))) return;             // gia' spostato a break-even
    if (!t.entry || !t.side || !t.symbol || !t.qty) return;

    const curVol = Math.abs(Number(position.contracts ?? 0));
    const tp1Filled = curVol > 0 && curVol < Number(t.qty) * 0.999;
    if (!tp1Filled) return;                                      // TP1 non ancora toccato

    const long = t.side === 'long';
    const price = position.markPrice ?? (await this.executor.getPrice(t.symbol)) ?? Number(t.entry);
    // Lo STOP a break-even si puo' piazzare solo se il prezzo e' ancora oltre l'entry
    // (long: prezzo > entry). Altrimenti lo stop sarebbe "gia' passato".
    const canPlaceBeStop = long ? price > t.entry : price < t.entry;

    if (canPlaceBeStop) {
      // sposta lo SL a entry sul volume residuo, mantenendo i TP ancora davanti al prezzo
      const remaining = tps.filter((tp) => (long ? tp > price : tp < price));
      const channel = await this.prisma.tgChannel.findUnique({ where: { id: t.channelDbId } });
      const split = String(channel?.tpSplit ?? '50,30,20').split(',').map(Number).filter((x) => x > 0);
      try {
        const posId = await this.executor.attachStops(t.symbol, t.side, t.qty, t.entry, remaining, split);
        await this.prisma.tgSignal.update({
          where: { id: t.id },
          data: { stopLoss: t.entry, reason: 'be', note: `live posId ${posId ?? position.positionId ?? 'n/d'} · BE` },
        });
        this.logger.log(`[TGS LIVE] BE ${t.symbol}: TP1 toccato → SL spostato a entry ${t.entry}`);
      } catch (e: any) {
        this.logger.warn(`[TGS LIVE] BE ${t.symbol}: ${String(e?.message ?? '').slice(0, 70)}`);
      }
    } else {
      // Il prezzo e' gia' tornato all'entry/sotto dopo il TP1: non si puo' piazzare lo stop
      // a BE (sarebbe gia' passato). CHIUDO subito a mercato il residuo per loccare il
      // ~breakeven, invece di lasciarlo correre verso la liquidazione (questo era il bug).
      try {
        await this.closeTrade(t, 'be');
        this.logger.log(`[TGS LIVE] BE ${t.symbol}: prezzo rientrato a entry dopo TP1 → chiuso residuo a mercato (~breakeven)`);
      } catch (e: any) {
        this.logger.warn(`[TGS LIVE] BE close ${t.symbol}: ${String(e?.message ?? '').slice(0, 70)}`);
      }
    }
  }

  @Cron('0 */5 * * * *')   // backstop ogni 5 min: il realtime listener copre l'immediatezza
  async pollTelegramMessages(limitPerDialog = 10) {
    if (!this.tg.status().connected) return { ok: false, reason: 'telegram non connesso', checked: 0 };
    try {
      const messages = await this.tg.listRecentMessages(limitPerDialog);
      for (const msg of messages) {
        await this.handleIncoming(msg).catch((e) => this.logger.warn(`[TGS] poll handle: ${e?.message?.slice(0, 80)}`));
      }
      if (messages.length) this.logger.log(`[TGS] polling Telegram: ${messages.length} messaggi controllati`);
      return { ok: true, checked: messages.length };
    } catch (e: any) {
      this.logger.warn(`[TGS] polling Telegram: ${e?.message?.slice(0, 80)}`);
      return { ok: false, reason: e?.message?.slice(0, 120), checked: 0 };
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────
  async getDashboard() {
    await this.syncDialogs().catch((e) => this.logger.warn(`[TGS] sync dialogs: ${e?.message?.slice(0, 80)}`));
    const [channels, openTrades, recent, all, tgStatus, promptMemory] = await Promise.all([
      this.prisma.tgChannel.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.tgSignal.findMany({ where: { tradeStatus: { in: ['open', 'pending'] } }, orderBy: { createdAt: 'desc' } }),
      this.prisma.tgSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.tgSignal.findMany({ where: { tradeStatus: { in: ['win', 'loss', 'closed'] } } }),
      Promise.resolve(this.tg.status()),
      this.getPromptMemory(),
    ]);
    const wins = all.filter((t) => t.tradeStatus === 'win').length;
    const losses = all.filter((t) => t.tradeStatus === 'loss').length;
    const pnl = all.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const closed = all.length;
    const gemmaIdx = this.gemma.modelIdx;
    return {
      telegram: tgStatus, channels, openTrades, recent, promptMemory,
      gemma: { model: this.gemma.currentModel, idx: gemmaIdx, onFallback: gemmaIdx > 0 },
      stats: { closed, wins, losses, winRate: closed ? +(wins / closed * 100).toFixed(1) : 0, pnl: +pnl.toFixed(4) },
    };
  }

  getChannels() { return this.prisma.tgChannel.findMany({ orderBy: { createdAt: 'asc' } }); }

  async listDialogs() {
    await this.syncDialogs(true).catch((e) => this.logger.warn(`[TGS] sync dialogs: ${e?.message?.slice(0, 80)}`));
    return this.tg.listDialogs();
  }

  async testParse(b: any) {
    const rawText = String(b?.text ?? '').trim();
    if (!rawText) return { ok: false, error: 'testo mancante' };

    const channel = b?.channelId
      ? await this.prisma.tgChannel.findFirst({
          where: { OR: [{ channelId: String(b.channelId) }, { id: Number(b.channelId) || -1 }] },
        })
      : await this.prisma.tgChannel.findFirst({ where: { enabled: true }, orderBy: { createdAt: 'asc' } });

    const ctx = {
      riskPct: Number(channel?.riskPct ?? 4.0),
      leverageMax: Number(channel?.levaMax ?? 20),
      minConf: Number(channel?.minConf ?? 0.6),
    };
    const memory = await this.getPromptMemory();
    const parsed = await this.parser.parse(rawText, memory.summary, { riskPct: ctx.riskPct, leverageMax: ctx.leverageMax });
    const normalizedSymbol = parsed.symbol ? this.executor.resolveSymbol(parsed.symbol) : null;
    const leverage = parsed.leverage == null ? null : this.resolveLeverage(parsed.leverage, ctx.leverageMax);

    const checks: string[] = [];
    if (parsed.type !== 'NEW') checks.push(`tipo ${parsed.type}: nessun ingresso`);
    if (parsed.confidence < ctx.minConf) checks.push(`confidenza ${parsed.confidence} < soglia ${ctx.minConf}`);
    if (!parsed.side) checks.push('direzione mancante');
    if (parsed.sl == null) checks.push('SL mancante');
    if (!normalizedSymbol) checks.push(`simbolo non mappabile: ${parsed.symbol ?? '-'}`);
    if (parsed.leverage == null) checks.push('leva Gemini mancante');

    return {
      ok: true,
      wouldExecute: checks.length === 0,
      checks,
      parsed,
      normalized: {
        symbol: normalizedSymbol,
        leverage,
        leverageFromGemini: parsed.leverage,
        leverageCap: ctx.leverageMax,
        riskPct: ctx.riskPct,
        confidenceThreshold: ctx.minConf,
      },
    };
  }

  private resolveLeverage(parsed: number, max: number) {
    const cap = Math.max(1, Math.floor(Number(max) || 1));
    const suggested = isFinite(Number(parsed)) ? Math.round(Number(parsed)) : 1;
    return Math.max(1, Math.min(suggested, cap));
  }

  addChannel(b: any) {
    return this.prisma.tgChannel.create({ data: {
      channelId: String(b.channelId), username: b.username ?? null, title: b.title ?? null,
      enabled: b.enabled ?? true, mode: b.mode === 'live' ? 'live' : 'sim',
      riskPct: b.riskPct ?? 4.0, levaMax: b.levaMax ?? 20, minConf: b.minConf ?? 0.6, tpSplit: b.tpSplit ?? '50,30,20',
    } });
  }

  updateChannel(id: number, b: any) {
    const allowed = ['username', 'title', 'enabled', 'mode', 'riskPct', 'levaMax', 'minConf', 'tpSplit'];
    const data: any = {};
    for (const k of allowed) if (b[k] !== undefined) data[k] = b[k];
    if (data.mode && data.mode !== 'live') data.mode = 'sim';
    return this.prisma.tgChannel.update({ where: { id }, data });
  }

  removeChannel(id: number) { return this.prisma.tgChannel.delete({ where: { id } }); }

  async closeSignalManual(id: string) {
    const t = await this.prisma.tgSignal.findUnique({ where: { id } });
    if (!t || !['open', 'pending'].includes(t.tradeStatus)) return { closed: false };
    await this.closeTrade(t, 'manual');
    return { closed: true };
  }

  async reset() {
    const r = await this.prisma.tgSignal.deleteMany({});
    return { removed: r.count };
  }
}
