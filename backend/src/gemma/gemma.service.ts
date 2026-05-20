import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';

const BASE_URL  = 'https://generativelanguage.googleapis.com/v1beta/models';
const FILES_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
const GEMMA_MODELS = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it'];

const SYSTEM_PROMPT = `Sei un assistente professionale per il trading di futures crypto su MEXC.
Aiuti l'utente ad analizzare segnali, pattern e posizioni aperte per prendere decisioni migliori.

Strategie attive nel bot:
- ERB 1m: EMA34 4-candle bounce, body ≥40%, segnali pump/dump
- ERB Flex: variante EMA34 con body ≥35%, patternType 3/4
- HF Scanner: 300 coppie/ciclo — EMA_CROSS (EMA9×EMA21), FVG (Fair Value Gap retest), DBL_BTM/TOP (doppio minimo/massimo), RANGE_BRK (breakout consolidazione)
- SOL Scalper: singola coppia SOL/USDT su EMA34
- Multi-TF: ERB v7 su 5m / 15m / 1h

Modello di rischio: risk fisso €0.50/trade, leva calcolata da SL%, RR 1:2 (HF) o 1:2+1:3 (altri scanner).
Fee taker MEXC: 0.038%.

Sii conciso e diretto — ambiente di trading live. Rispondi nella stessa lingua dell'utente (italiano di default).
Non inventare prezzi o dati che non hai — usa solo il contesto fornito.`;

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface ChatDto {
  message: string;
  history: ChatMessage[];
  image?: { data: string; mimeType: string };
  context?: {
    openPositions?: { symbol: string; direction: string; entry: number; pnl?: number; grade?: string; scanner?: string }[];
    recentSignals?: { symbol: string; direction: string; pattern?: string; score?: number; grade?: string; scanner?: string }[];
    liveEnabled?: boolean;
    livePositionCount?: number;
  };
}

@Injectable()
export class GemmaService {
  private readonly logger = new Logger(GemmaService.name);
  private readonly apiKey: string;
  modelIdx = 0;   // public so smart-scanner can read current model

  constructor(private config: ConfigService) {
    this.apiKey = this.config.get<string>('GEMINI_API_KEY', '');
    if (!this.apiKey) this.logger.warn('GEMINI_API_KEY non impostata — chat Gemma disabilitata');
  }

  get currentModel() { return GEMMA_MODELS[this.modelIdx]; }

  @Cron('0 0 * * *')
  resetQuota() {
    if (this.modelIdx !== 0) {
      this.modelIdx = 0;
      this.logger.log(`[Gemma] Quota reset — ritorno a ${GEMMA_MODELS[0]}`);
    }
  }

  async callApi(body: object, retryOnQuota = true): Promise<Response> {
    const model = GEMMA_MODELS[this.modelIdx];
    const res = await fetch(`${BASE_URL}/${model}:generateContent?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status === 403) && retryOnQuota) {
      const text = await res.clone().text();
      if (text.includes('quota') || text.includes('RESOURCE_EXHAUSTED') || text.includes('rate')) {
        if (this.modelIdx < GEMMA_MODELS.length - 1) {
          this.modelIdx++;
          this.logger.warn(`[Gemma] Quota esaurita su ${model} → switch a ${GEMMA_MODELS[this.modelIdx]}`);
          return this.callApi(body, false);
        }
      }
    }
    return res;
  }

  async chat(dto: ChatDto): Promise<{ reply: string }> {
    if (!this.apiKey) return { reply: '⚠️ GEMINI_API_KEY non configurata sul server.' };

    const systemText = this.buildSystemPrompt(dto.context);

    const userParts: any[] = [];
    if (dto.image) {
      userParts.push({ inline_data: { mime_type: dto.image.mimeType, data: dto.image.data } });
    }
    userParts.push({ text: dto.message });

    const contents = [
      ...dto.history.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      { role: 'user', parts: userParts },
    ];

    try {
      const res = await this.callApi({
        systemInstruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      });

      if (!res.ok) {
        const err = await res.text();
        this.logger.error(`Gemma API error ${res.status}: ${err}`);
        return { reply: `⚠️ Errore API Gemma (${res.status}). Riprova.` };
      }

      const data = await res.json() as any;
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const reply = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim() || '(risposta vuota)';
      return { reply };
    } catch (err) {
      this.logger.error(`Gemma fetch error: ${err.message}`);
      return { reply: '⚠️ Impossibile raggiungere l\'API Gemma. Controlla la connessione.' };
    }
  }

  private async uploadFile(base64: string, mimeType: string): Promise<string | null> {
    try {
      const buffer = Buffer.from(base64, 'base64');
      this.logger.log(`Uploading file: ${mimeType}, ${buffer.length} bytes`);

      // Multipart upload
      const boundary = '----GeminiBoundary' + Date.now();
      const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ file: { display_name: 'screenshot' } })}\r\n`;
      const dataPart = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
      const endPart  = `\r\n--${boundary}--`;

      const metaBuf = Buffer.from(metaPart, 'utf-8');
      const dataBuf = Buffer.from(dataPart, 'utf-8');
      const endBuf  = Buffer.from(endPart, 'utf-8');
      const body    = Buffer.concat([metaBuf, dataBuf, buffer, endBuf]);

      const res = await fetch(`${FILES_URL}?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'X-Goog-Upload-Protocol': 'multipart',
        },
        body,
      });

      const raw = await res.text();
      if (!res.ok) {
        this.logger.error(`File upload error ${res.status}: ${raw}`);
        return null;
      }
      const data = JSON.parse(raw);
      const uri = data?.file?.uri ?? null;
      this.logger.log(`File uploaded: ${uri}`);
      return uri;
    } catch (err) {
      this.logger.error(`File upload failed: ${err.message}`);
      return null;
    }
  }

  private buildSystemPrompt(ctx?: ChatDto['context']): string {
    let prompt = SYSTEM_PROMPT;

    if (!ctx) return prompt;

    prompt += '\n\n--- CONTESTO ATTUALE ---';

    if (ctx.openPositions && ctx.openPositions.length > 0) {
      prompt += `\nPosizioni simulate aperte (${ctx.openPositions.length}):`;
      for (const p of ctx.openPositions.slice(0, 10)) {
        const pnlStr = p.pnl != null ? ` PnL: ${p.pnl >= 0 ? '+' : ''}€${p.pnl.toFixed(3)}` : '';
        prompt += `\n  - ${p.scanner ?? '?'} | ${p.direction} ${p.symbol.replace('/USDT:USDT', '')} @ ${p.entry}${pnlStr} [${p.grade ?? '?'}]`;
      }
    } else {
      prompt += '\nNessuna posizione simulata aperta.';
    }

    if (ctx.recentSignals && ctx.recentSignals.length > 0) {
      prompt += `\nUltimi segnali emessi:`;
      for (const s of ctx.recentSignals.slice(0, 5)) {
        const pat = s.pattern ? ` (${s.pattern})` : '';
        prompt += `\n  - ${s.scanner ?? '?'} | ${s.direction} ${s.symbol.replace('/USDT:USDT', '')}${pat} score ${s.score ?? '?'} [${s.grade ?? '?'}]`;
      }
    }

    if (ctx.liveEnabled != null) {
      prompt += `\nLive trading: ${ctx.liveEnabled ? `ATTIVO (${ctx.livePositionCount ?? 0} posizioni reali aperte)` : 'DISATTIVATO'}`;
    }

    return prompt;
  }
}
