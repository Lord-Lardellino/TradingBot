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
    const dup = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tgMessageId: msg.messageId } });
    if (dup) return;
    if (msg.title && channel.title !== msg.title) {
      await this.prisma.tgChannel.update({ where: { id: channel.id }, data: { title: msg.title } }).catch(() => {});
    }

    // PRE-FILTRO ECONOMICO (zero Gemini): prendiamo SOLO i segnali. Tutto ciò che non
    // ha la forma di un segnale operativo (promo, chiacchiere, news, risultati VIP)
    // viene scartato senza chiamare Gemini → drastico taglio delle richieste.
    if (!this.looksLikeSignal(msg.text)) {
      await this.prisma.tgSignal.create({ data: {
        channelDbId: channel.id, tgMessageId: msg.messageId, rawText: msg.text.slice(0, 4000),
        parsed: '{}', type: 'RUMORE', status: 'skipped', note: 'pre-filtro: non è un segnale (no Gemini)',
      } });
      return;
    }

    const memory = await this.getPromptMemory();
    const parsed = await this.parser.parse(msg.text, memory.summary, { riskPct: channel.riskPct, leverageMax: channel.levaMax });
    const rec = await this.prisma.tgSignal.create({
      data: {
        channelDbId: channel.id, tgMessageId: msg.messageId, rawText: msg.text.slice(0, 4000),
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
    const fields = /\b(entry|entrata|sl|stop\s*loss|tp\d?|take\s*profit|targets?|leverage|leva)\b/.test(t);
    return action || fields;
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
            ...(skipCodes ? { enabled: false } : {}),
          },
        });
        if (rec.createdAt.getTime() === rec.updatedAt.getTime()) added++;
      }
      if (added) this.logger.log(`[TGS] auto-registrati ${added} canali Telegram`);
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
    if (p.sl == null) return void (await skip('SL mancante — impossibile dimensionare il rischio'));
    const symbol = p.symbol ? this.executor.resolveSymbol(p.symbol) : null;
    if (!symbol) return void (await skip(`simbolo non mappabile: ${p.symbol}`));

    // No duplicati: blocca solo lo STESSO symbol+side già aperto su questo canale
    // (coin diversi sullo stesso canale sono permessi → prima li skippava tutti).
    const dupSameSymbol = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, symbol, side: p.side, tradeStatus: { in: ['open', 'pending'] } } });
    if (dupSameSymbol) return void (await skip(`già un trade ${p.side} aperto su ${symbol} (no duplicato)`));

    if (p.leverage == null) return void (await skip('leva Gemini mancante'));
    const leverage = this.resolveLeverage(p.leverage, channel.levaMax);
    const tpSplit = String(channel.tpSplit).split(',').map((x: string) => Number(x.trim())).filter((x) => x > 0);

    // Decisione entrata: se il prezzo è nella ZONA d'entrata → MARKET subito;
    // altrimenti LIMIT al prezzo d'entrata (con SL/TP preimpostati).
    const livePrice = await this.executor.getPrice(symbol);
    const zone = this.entryZone(p);
    let entryType: 'market' | 'limit' = p.entryType;
    let entryPrice: number | null = p.entryPrice;
    if (livePrice && zone && livePrice >= zone.lo && livePrice <= zone.hi) {
      entryType = 'market'; entryPrice = null;
    } else if (p.entryPrice != null) {
      entryType = 'limit'; entryPrice = p.entryPrice;
    } else {
      entryType = 'market'; entryPrice = null;
    }
    const entryRef = (entryType === 'limit' && entryPrice) ? entryPrice : (livePrice ?? entryPrice);
    if (!entryRef) return void (await skip('prezzo entry non disponibile'));
    // Protezione valida rispetto al prezzo d'ingresso effettivo (non al prezzo live,
    // che per un limit lontano falsava il controllo e skippava setup validi).
    if (!this.executor.protectionIsValid(p.side, entryRef, p.sl, p.tps)) {
      return void (await skip(`SL/TP incoerenti con entry ${entryRef}: SL=${p.sl} TP=${p.tps.join('/')}`));
    }

    if (channel.mode === 'live') {
      const r = await this.executor.openLive({ symbol, side: p.side, entryType, entryPrice: entryPrice ?? undefined, sl: p.sl, tps: p.tps, tpSplit, riskPct: channel.riskPct, leverage });
      if (!r.ok) return void (await skip(`live: ${r.error}`));
      const tradeStatus = (r.positionId || entryType === 'market') ? 'open' : 'pending';
      const note = r.positionId ? `live posId ${r.positionId}` : r.preset ? 'live limit preset (SL/TP sull-ordine)' : 'live pending limit';
      await this.prisma.tgSignal.update({ where: { id: recId }, data: {
        status: 'executed', mode: 'live', tradeStatus, symbol, side: p.side,
        entry: r.entry, stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), qty: r.qty, leverage, riskUsd: r.riskUsd,
        note,
      } });
      this.logger.log(`[TGS LIVE] ${channel.username ?? channel.channelId} → ${entryType} ${p.side} ${symbol} qty ${r.qty}`);
    } else {
      const { qty, riskUsd } = await this.executor.sizeQty(symbol, entryRef, p.sl, channel.riskPct);
      await this.prisma.tgSignal.update({ where: { id: recId }, data: {
        status: 'executed', mode: 'sim', tradeStatus: 'open', symbol, side: p.side,
        entry: entryRef, stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), qty, leverage, riskUsd,
        note: `sim ${entryType}`,
      } });
      this.logger.log(`[TGS SIM] ${channel.username ?? channel.channelId} → ${entryType} ${p.side} ${symbol} qty ${qty} entry ${entryRef}`);
    }
  }

  // Zona d'entrata: range esplicito se presente, altrimenti banda ±0.15% sul prezzo singolo.
  private entryZone(p: ParsedSignal): { lo: number; hi: number } | null {
    if (p.entryLow != null && p.entryHigh != null) return { lo: Math.min(p.entryLow, p.entryHigh), hi: Math.max(p.entryLow, p.entryHigh) };
    if (p.entryPrice != null) { const tol = Math.abs(p.entryPrice) * 0.0015; return { lo: p.entryPrice - tol, hi: p.entryPrice + tol }; }
    return null;
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

  @Cron('*/20 * * * * *')
  async monitorLiveStops() {
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

        if (String(t.note ?? '').match(/posId\s+(?!n\/d)/i)) continue;
        const tps: number[] = JSON.parse(t.takeProfits ?? '[]');
        if (!tps.length) continue;
        const position = await this.executor.getOpenPosition(t.symbol, t.side as any);
        if (!position) {
          const hasOrder = await this.executor.hasOpenOrder(t.symbol);
          const hasStops = await this.executor.hasStopOrders(t.symbol);
          if (!hasOrder && !hasStops) {
            await this.prisma.tgSignal.update({
              where: { id: t.id },
              data: {
                tradeStatus: 'closed',
                reason: 'no_fill',
                note: 'chiuso: nessuna posizione/ordine live trovato',
                closedAt: new Date(),
              },
            });
          }
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
