import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramClientService, IncomingMessage } from './telegram-client.service';
import { SignalParserService, ParsedSignal } from './signal-parser.service';
import { OrderExecutorService } from './order-executor.service';

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

  constructor(
    private prisma: PrismaService,
    private tg: TelegramClientService,
    private parser: SignalParserService,
    private executor: OrderExecutorService,
  ) {}

  onModuleInit() {
    this.tg.onMessage((msg) => this.handleIncoming(msg).catch((e) => this.logger.warn(`[TGS] handle: ${e?.message?.slice(0, 80)}`)));
  }

  // ── Ingresso messaggio ────────────────────────────────────────────────────
  private async handleIncoming(msg: IncomingMessage) {
    const channel = await this.prisma.tgChannel.findUnique({ where: { channelId: msg.channelId } });
    if (!channel || !channel.enabled) return;                 // canale non monitorato
    // dedup: stesso messaggio già processato
    const dup = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tgMessageId: msg.messageId } });
    if (dup) return;
    if (msg.title && channel.title !== msg.title) {
      await this.prisma.tgChannel.update({ where: { id: channel.id }, data: { title: msg.title } }).catch(() => {});
    }

    const memory = await this.getPromptMemory();
    const parsed = await this.parser.parse(msg.text, memory.summary);
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
    // RUMORE → nessuna azione
    return this.learnFromNonSignal(rec.id, msg.text, parsed, memory.summary, channel.title ?? channel.username ?? channel.channelId);
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

    // un solo trade aperto per canale: se ce n'è uno, salta (no hedge)
    const openOnChannel = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tradeStatus: 'open' } });
    if (openOnChannel) return void (await skip('già un trade aperto su questo canale (no hedge)'));

    const leverage = Math.min(p.leverage ?? channel.levaMax, channel.levaMax);
    const tpSplit = String(channel.tpSplit).split(',').map((x: string) => Number(x.trim())).filter((x) => x > 0);
    const entryRef = (p.entryType === 'limit' && p.entryPrice) ? p.entryPrice : (await this.executor.getPrice(symbol)) ?? p.entryPrice;
    if (!entryRef) return void (await skip('prezzo entry non disponibile'));

    if (channel.mode === 'live') {
      const r = await this.executor.openLive({ symbol, side: p.side, entryType: p.entryType, entryPrice: p.entryPrice ?? undefined, sl: p.sl, tps: p.tps, tpSplit, riskPct: channel.riskPct, leverage });
      if (!r.ok) return void (await skip(`live: ${r.error}`));
      await this.prisma.tgSignal.update({ where: { id: recId }, data: {
        status: 'executed', mode: 'live', tradeStatus: 'open', symbol, side: p.side,
        entry: r.entry, stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), qty: r.qty, leverage, riskUsd: r.riskUsd,
        note: `live · posId ${r.positionId ?? 'n/d'}`,
      } });
      this.logger.log(`[TGS LIVE] ${channel.username ?? channel.channelId} → ${p.side} ${symbol} qty ${r.qty}`);
    } else {
      const { qty, riskUsd } = await this.executor.sizeQty(symbol, entryRef, p.sl, channel.riskPct);
      await this.prisma.tgSignal.update({ where: { id: recId }, data: {
        status: 'executed', mode: 'sim', tradeStatus: 'open', symbol, side: p.side,
        entry: entryRef, stopLoss: p.sl, takeProfits: JSON.stringify(p.tps), qty, leverage, riskUsd,
        note: 'sim',
      } });
      this.logger.log(`[TGS SIM] ${channel.username ?? channel.channelId} → ${p.side} ${symbol} qty ${qty} entry ${entryRef}`);
    }
  }

  // ── UPDATE: sposta SL (BE) sul trade aperto del canale ────────────────────
  private async applyUpdate(channel: any, recId: string, p: ParsedSignal) {
    const open = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tradeStatus: 'open' }, orderBy: { createdAt: 'desc' } });
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
    const open = await this.prisma.tgSignal.findFirst({ where: { channelDbId: channel.id, tradeStatus: 'open' }, orderBy: { createdAt: 'desc' } });
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

  // ── API ───────────────────────────────────────────────────────────────────
  async getDashboard() {
    const [channels, openTrades, recent, all, tgStatus, promptMemory] = await Promise.all([
      this.prisma.tgChannel.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.tgSignal.findMany({ where: { tradeStatus: 'open' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.tgSignal.findMany({ orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.tgSignal.findMany({ where: { tradeStatus: { in: ['win', 'loss', 'closed'] } } }),
      Promise.resolve(this.tg.status()),
      this.getPromptMemory(),
    ]);
    const wins = all.filter((t) => t.tradeStatus === 'win').length;
    const losses = all.filter((t) => t.tradeStatus === 'loss').length;
    const pnl = all.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const closed = all.length;
    return {
      telegram: tgStatus, channels, openTrades, recent, promptMemory,
      stats: { closed, wins, losses, winRate: closed ? +(wins / closed * 100).toFixed(1) : 0, pnl: +pnl.toFixed(4) },
    };
  }

  getChannels() { return this.prisma.tgChannel.findMany({ orderBy: { createdAt: 'asc' } }); }

  async listDialogs() { return this.tg.listDialogs(); }

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
    if (!t || t.tradeStatus !== 'open') return { closed: false };
    await this.closeTrade(t, 'manual');
    return { closed: true };
  }

  async reset() {
    const r = await this.prisma.tgSignal.deleteMany({});
    return { removed: r.count };
  }
}
