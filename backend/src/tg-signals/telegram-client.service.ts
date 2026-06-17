import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Wrapper GramJS (account utente MTProto). Login una-tantum via script CLI
// (npm run tg:login) → StringSession salvata in .env (TG_SESSION). Qui ci limitiamo
// a connetterci con la sessione salvata e a inoltrare gli eventi "nuovo messaggio".
// Lettura PASSIVA: nessun invio, nessuna azione sui canali.

export interface IncomingMessage {
  channelId: string;   // id del peer (canale) come stringa
  messageId: string;
  text: string;
  title?: string;
}

@Injectable()
export class TelegramClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramClientService.name);
  private client: any;
  private connected = false;
  private handler?: (msg: IncomingMessage) => void;

  constructor(private config: ConfigService) {}

  async onModuleInit() {
    await this.start().catch((e) => this.logger.warn(`[TG] start: ${e?.message?.slice(0, 80)}`));
  }

  async onModuleDestroy() {
    try { await this.client?.disconnect(); } catch {}
  }

  onMessage(cb: (msg: IncomingMessage) => void) { this.handler = cb; }

  status() {
    const configured = !!(this.apiId() && this.apiHash() && this.session());
    return { configured, connected: this.connected };
  }

  private apiId() { return Number(this.config.get<string>('TG_API_ID', '')) || 0; }
  private apiHash() { return this.config.get<string>('TG_API_HASH', ''); }
  private session() { return this.config.get<string>('TG_SESSION', ''); }

  async start() {
    if (this.connected) return;
    const apiId = this.apiId(); const apiHash = this.apiHash(); const session = this.session();
    if (!apiId || !apiHash || !session) {
      this.logger.warn('[TG] credenziali/sessione mancanti — listener disattivato (lancia npm run tg:login)');
      return;
    }
    // import dinamico: GramJS è pesante, lo carichiamo solo se configurato
    const { TelegramClient } = await import('telegram');
    const { StringSession } = await import('telegram/sessions');
    const { NewMessage } = await import('telegram/events');

    this.client = new TelegramClient(new StringSession(session), apiId, apiHash, {
      connectionRetries: 5,
      // tieni la connessione viva e ricevi gli update in tempo reale
      autoReconnect: true,
      retryDelay: 1000,
      requestRetries: 5,
    });
    await this.client.connect();
    this.connected = await this.client.checkAuthorization();
    if (!this.connected) { this.logger.warn('[TG] sessione non autorizzata — rifai npm run tg:login'); return; }

    this.client.addEventHandler(async (event: any) => {
      try {
        const msg = event?.message;
        const text: string = msg?.message ?? '';
        if (!text) return;
        const channelId = String(msg?.chatId ?? msg?.peerId?.channelId ?? '');
        let title: string | undefined;
        try { const chat = await msg.getChat(); title = chat?.title ?? chat?.username; } catch {}
        this.logger.log(`[TG] realtime msg da ${title ?? channelId} (#${msg?.id})`);
        this.handler?.({ channelId, messageId: String(msg?.id ?? ''), text, title });
      } catch (e: any) { this.logger.warn(`[TG] msg handler: ${e?.message?.slice(0, 60)}`); }
    }, new NewMessage({}));

    // IMPORTANTE: scalda la cache delle entità/dialoghi. Senza questo GramJS spesso
    // NON consegna in tempo reale i post dei canali (broadcast) finché non li ha in cache.
    try {
      await this.client.getDialogs({ limit: 200 });
      // recupera eventuali update persi mentre era disconnesso
      if (typeof (this.client as any).catchUp === 'function') await (this.client as any).catchUp();
    } catch (e: any) { this.logger.warn(`[TG] warmup dialoghi: ${e?.message?.slice(0, 60)}`); }

    this.logger.log('[TG] listener MTProto attivo (realtime, lettura passiva canali)');
  }

  // Lista dei dialoghi (canali/gruppi) a cui l'account è iscritto — per la UI di setup.
  async listDialogs(): Promise<{ id: string; title: string; username?: string; isChannel: boolean }[]> {
    if (!this.connected || !this.client) return [];
    const out: any[] = [];
    try {
      const dialogs = await this.client.getDialogs({ limit: 200 });
      for (const d of dialogs) {
        if (!(d.isChannel || d.isGroup)) continue;
        out.push({ id: String(d.id), title: d.title ?? d.name ?? '', username: d.entity?.username, isChannel: !!d.isChannel });
      }
    } catch (e: any) { this.logger.warn(`[TG] dialogs: ${e?.message?.slice(0, 60)}`); }
    return out;
  }

  async listRecentMessages(limitPerDialog = 3): Promise<IncomingMessage[]> {
    if (!this.connected || !this.client) return [];
    const out: IncomingMessage[] = [];
    try {
      const dialogs = await this.client.getDialogs({ limit: 200 });
      for (const d of dialogs) {
        if (!(d.isChannel || d.isGroup)) continue;
        let messages: any[] = [];
        try { messages = await this.client.getMessages(d.entity, { limit: limitPerDialog }); } catch { continue; }
        for (const msg of messages.reverse()) {
          const text = String(msg?.message ?? '').trim();
          if (!text) continue;
          out.push({
            channelId: String(d.id),
            messageId: String(msg?.id ?? ''),
            text,
            title: d.title ?? d.name ?? msg?.chat?.title,
          });
        }
      }
    } catch (e: any) { this.logger.warn(`[TG] recent messages: ${e?.message?.slice(0, 60)}`); }
    return out;
  }
}
