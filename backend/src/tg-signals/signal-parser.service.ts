import { Injectable, Logger } from '@nestjs/common';
import { GemmaService } from '../gemma/gemma.service';

// Output strutturato dell'interpretazione di un messaggio di segnale.
export interface ParsedSignal {
  type: 'NEW' | 'UPDATE' | 'CLOSE' | 'RUMORE';
  symbol: string | null;       // base grezza, es. "BTC" (normalizzata poi dall'executor)
  side: 'long' | 'short' | null;
  entryType: 'market' | 'limit';
  entryPrice: number | null;
  entryLow: number | null;     // estremo basso della zona d'entrata (se range)
  entryHigh: number | null;    // estremo alto della zona d'entrata (se range)
  sl: number | null;
  tps: number[];               // 0..n take-profit
  leverage: number | null;
  confidence: number;          // 0..1
  // per UPDATE: cosa cambiare
  newSl?: number | null;       // sposta SL (es. break-even)
  closePct?: number | null;    // chiusura parziale %
}

export interface NewsAnalysis {
  kind: 'NEWS' | 'COMMENTO' | 'PROMO' | 'RUMORE';
  relevant: boolean;
  symbols: string[];
  summary: string | null;
  marketBias: 'bullish' | 'bearish' | 'mixed' | 'neutral';
  promptMemory: string;
  confidence: number;
}

export interface ParseContext {
  riskPct?: number;
  leverageMax?: number;
}

const PROMPT = `Sei un parser di segnali di trading futures crypto. Ricevi UN messaggio
grezzo (in qualsiasi lingua, spesso informale) da un canale Telegram di segnali e
ritorni SOLO un oggetto JSON valido, senza testo prima o dopo, senza markdown.

Classifica il messaggio in "type":
- "NEW": nuovo segnale di ingresso (ha symbol + direzione, di solito entry/SL/TP).
- "UPDATE": aggiornamento di un trade già dato (sposta SL a BE, chiusura parziale, alza TP).
- "CLOSE": ordine di chiudere tutto / uscire ora.
- "RUMORE": news, commenti macro, chiacchiere, promo, risultati/VIP, niente di operabile.

Estrai (usa null se assente):
- "symbol": ticker base, es "BTC", "ETH", "SOL" (solo la base, senza /USDT).
- "side": "long" o "short". "buy/long/compra" = long; "sell/short/vendi" = short.
- "entryType": "market" se dice di entrare ORA / a mercato / "market"; "limit" se dà un prezzo di ingresso preciso da aspettare. Se ambiguo ma c'è un prezzo entry → "limit", altrimenti "market".
- "entryPrice": prezzo di ingresso numerico (se è una zona/range, la media; null se a mercato senza prezzo).
- "entryLow"/"entryHigh": se l'entrata è una ZONA/RANGE (es "64000-64500" o "64000 / 64500"), gli estremi basso e alto. Se entrata singola, lascia entrambi null.
- "sl": prezzo stop loss.
- "tps": array di prezzi take-profit in ordine (può essere vuoto).
- "leverage": leva consigliata come numero. Per NEW scegli una leva anche se non e' scritta nel messaggio:
  considera volatilita' dell'asset, distanza entry-SL, rischio/budget indicati nel contesto e qualita' del segnale.
  Usa leva piu' bassa su meme/alt illiquide o SL stretto, piu' alta solo su asset liquidi e setup chiaro.
  Non superare "leverageMax" se presente nel contesto. Usa null solo per UPDATE/CLOSE/RUMORE.
- "confidence": 0..1, quanto sei sicuro dell'interpretazione (testo chiaro e completo = alto).
- per "UPDATE": "newSl" (nuovo SL/BE) e "closePct" (% da chiudere) se presenti.

Rispondi SOLO con il JSON. Esempio:
{"type":"NEW","symbol":"BTC","side":"long","entryType":"limit","entryPrice":64250,"entryLow":64000,"entryHigh":64500,"sl":63200,"tps":[65000,66000,67500],"leverage":10,"confidence":0.86,"newSl":null,"closePct":null}`;

const NEWS_PROMPT = `Sei un analista di contesto per trading futures crypto.
Ricevi un messaggio Telegram che NON e' un segnale operativo. Devi capire se contiene
notizie, rumor, sentiment, update macro o informazioni utili per interpretare i prossimi
segnali del canale.

Hai anche una memoria corrente. Aggiornala in modo compatto, senza superare 1800 caratteri.
Mantieni solo informazioni utili per i prossimi segnali: asset citati, bias, catalyst,
rischi, eventi imminenti. Scarta sempre:
- risultati del canale VIP, screenshot profit, "TP hit", "VIP closed", report performance;
- inviti VIP, promo, sconti, referral, call to action;
- flex di trade passati, testimonianze, classifiche, pubblicita';
- chiacchiere senza impatto su mercato o asset.

Rispondi SOLO JSON valido:
{
  "kind": "NEWS" | "COMMENTO" | "PROMO" | "RUMORE",
  "relevant": true | false,
  "symbols": ["BTC","ETH"],
  "summary": "riassunto breve della nuova informazione oppure null",
  "marketBias": "bullish" | "bearish" | "mixed" | "neutral",
  "promptMemory": "memoria aggiornata compatta",
  "confidence": 0.0
}`;

@Injectable()
export class SignalParserService {
  private readonly logger = new Logger(SignalParserService.name);

  constructor(private gemma: GemmaService) {}

  async parse(rawText: string, promptMemory = '', context: ParseContext = {}): Promise<ParsedSignal> {
    const fallback: ParsedSignal = { type: 'RUMORE', symbol: null, side: null, entryType: 'market', entryPrice: null, entryLow: null, entryHigh: null, sl: null, tps: [], leverage: null, confidence: 0 };
    if (!rawText || !rawText.trim()) return fallback;
    const ruleBased = this.parseStructuredSignal(rawText);
    if (ruleBased) return ruleBased;

    try {
      const systemPrompt = this.withPromptMemory(this.withParseContext(PROMPT, context), promptMemory);
      const res = await this.gemma.callApi({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: rawText.slice(0, 4000) }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 512, responseMimeType: 'application/json' },
      });
      if (!res.ok) { this.logger.warn(`[PARSE] API ${res.status}`); return fallback; }
      const data = (await res.json()) as any;
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
      return this.coerce(text, fallback);
    } catch (e: any) {
      this.logger.warn(`[PARSE] ${e?.message?.slice(0, 80)}`);
      return fallback;
    }
  }

  async analyzeNews(rawText: string, currentMemory = '', sourceLabel = ''): Promise<NewsAnalysis> {
    const fallback: NewsAnalysis = {
      kind: 'RUMORE',
      relevant: false,
      symbols: [],
      summary: null,
      marketBias: 'neutral',
      promptMemory: currentMemory,
      confidence: 0,
    };
    if (!rawText || !rawText.trim()) return fallback;

    try {
      const res = await this.gemma.callApi({
        systemInstruction: { parts: [{ text: NEWS_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [{ text: `MEMORIA CORRENTE:\n${currentMemory || '(vuota)'}\n\nFONTE CANALE:\n${sourceLabel || '(sconosciuta)'}\n\nNUOVO MESSAGGIO:\n${rawText.slice(0, 4000)}` }],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 768, responseMimeType: 'application/json' },
      });
      if (!res.ok) { this.logger.warn(`[NEWS] API ${res.status}`); return fallback; }
      const data = (await res.json()) as any;
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
      return this.coerceNews(text, fallback);
    } catch (e: any) {
      this.logger.warn(`[NEWS] ${e?.message?.slice(0, 80)}`);
      return fallback;
    }
  }

  // Estrae e valida il JSON dalla risposta (tollerante a eventuali code-fence).
  private coerce(text: string, fallback: ParsedSignal): ParsedSignal {
    let raw = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1];
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    let obj: any;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return fallback; }

    const type = ['NEW', 'UPDATE', 'CLOSE', 'RUMORE'].includes(obj.type) ? obj.type : 'RUMORE';
    const side = obj.side === 'long' || obj.side === 'short' ? obj.side : null;
    const num = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : (v != null && isFinite(Number(v)) ? Number(v) : null));
    const tps = Array.isArray(obj.tps) ? obj.tps.map(num).filter((x: number | null): x is number => x != null) : [];
    return {
      type,
      symbol: obj.symbol ? String(obj.symbol).toUpperCase().replace(/[^A-Z0-9]/g, '') : null,
      side,
      entryType: obj.entryType === 'limit' ? 'limit' : 'market',
      entryPrice: num(obj.entryPrice),
      entryLow: num(obj.entryLow),
      entryHigh: num(obj.entryHigh),
      sl: num(obj.sl),
      tps,
      leverage: num(obj.leverage),
      confidence: Math.max(0, Math.min(1, num(obj.confidence) ?? 0)),
      newSl: num(obj.newSl),
      closePct: num(obj.closePct),
    };
  }

  private coerceNews(text: string, fallback: NewsAnalysis): NewsAnalysis {
    let raw = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1];
    const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return fallback;
    let obj: any;
    try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return fallback; }

    const kind = ['NEWS', 'COMMENTO', 'PROMO', 'RUMORE'].includes(obj.kind) ? obj.kind : 'RUMORE';
    const bias = ['bullish', 'bearish', 'mixed', 'neutral'].includes(obj.marketBias) ? obj.marketBias : 'neutral';
    const num = (v: any): number | null => (typeof v === 'number' && isFinite(v) ? v : (v != null && isFinite(Number(v)) ? Number(v) : null));
    const symbols = Array.isArray(obj.symbols)
      ? obj.symbols.map((x: any) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).slice(0, 12)
      : [];
    const promptMemory = String(obj.promptMemory ?? fallback.promptMemory ?? '').slice(0, 2400);

    return {
      kind,
      relevant: !!obj.relevant && !!promptMemory.trim() && (kind === 'NEWS' || kind === 'COMMENTO'),
      symbols,
      summary: obj.summary ? String(obj.summary).slice(0, 1000) : null,
      marketBias: bias,
      promptMemory,
      confidence: Math.max(0, Math.min(1, num(obj.confidence) ?? 0)),
    };
  }

  private parseStructuredSignal(rawText: string): ParsedSignal | null {
    const labeled = this.parseLabeledSignal(rawText);
    if (labeled) return labeled;

    const text = rawText
      .replace(/\u00a0/g, ' ')
      .replace(/\btake[\s_-]*profits?\b/gi, 'targets')
      .replace(/\bstop[\s_-]*loss\b/gi, 'stop loss');
    const compact = text.replace(/\s+/g, ' ').trim();
    const hasTradeShape = /(futures signal|trade\s*:|entry\s*:|targets?\s*:|stop\s*loss\s*:|leverage\s*:)/i.test(compact);
    if (!hasTradeShape || !/entry\s*:/i.test(compact) || !/(stop\s*loss|sl)\s*:/i.test(compact)) return null;

    const symbolMatch = compact.match(/#?\$?([A-Z0-9]{2,})(?:\s*\/\s*USDT|USDT)\b/i);
    const sideMatch = compact.match(/\b(LONG|SHORT)\b/i);
    if (!symbolMatch || !sideMatch) return null;

    const entryLine = compact.match(/entry\s*:\s*([^🏹❌⚠️\n\r]+)/i)?.[1] ?? '';
    const targetLine = compact.match(/targets?\s*:\s*([^❌⚠️\n\r]+)/i)?.[1] ?? '';
    const slLine = compact.match(/(?:stop\s*loss|sl)\s*:\s*([^⚠️\n\r]+)/i)?.[1] ?? '';
    const leverageLine = compact.match(/leverage\s*:\s*([^.\n\r]+)/i)?.[1] ?? '';

    const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((x) => Number.isFinite(x));
    const entries = nums(entryLine);
    const tps = nums(targetLine);
    const sl = nums(slLine)[0] ?? null;
    const leverage = nums(leverageLine)[0] ?? null;
    if (!entries.length || !tps.length || sl == null || leverage == null) return null;

    const entryPrice = entries.reduce((sum, x) => sum + x, 0) / entries.length;
    const entryLow = entries.length > 1 ? Math.min(...entries) : null;
    const entryHigh = entries.length > 1 ? Math.max(...entries) : null;

    return {
      type: 'NEW',
      symbol: symbolMatch[1].toUpperCase(),
      side: sideMatch[1].toLowerCase() as 'long' | 'short',
      entryType: 'limit',
      entryPrice,
      entryLow,
      entryHigh,
      sl,
      tps,
      leverage,
      confidence: 0.95,
      newSl: null,
      closePct: null,
    };
  }

  private parseLabeledSignal(rawText: string): ParsedSignal | null {
    const symbolMatch = rawText.match(/#?\$?([A-Z0-9]{2,})(?:\s*\/\s*USDT|USDT)\b/i);
    const sideMatch = rawText.match(/\b(LONG|SHORT)\b/i);
    if (!symbolMatch || !sideMatch) return null;

    const text = rawText
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '\n')
      .replace(/\btake[\s_-]*profits?\b/gi, 'TAKE_PROFIT')
      .replace(/\bstop[\s_-]*loss\b/gi, 'STOP_LOSS')
      .replace(/\bentry\s*price\b/gi, 'ENTRY')
      .replace(/\b\d+(?:st|nd|rd|th)\s+entry\b/gi, 'ENTRY')
      .replace(/\bleverage\b/gi, 'LEVERAGE');

    const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number).filter((x) => Number.isFinite(x));
    const entries: number[] = [];
    for (const m of text.matchAll(/\bENTRY\b\s*:?\s*([^\n]+)/gi)) entries.push(...nums(m[1]));

    const tpBlock = text.match(/\bTAKE_PROFIT\b\s*:?\s*([\s\S]*?)(?=\bSTOP_LOSS\b|\bLEVERAGE\b|\bENTRY\b|$)/i)?.[1] ?? '';
    const slBlock = text.match(/\bSTOP_LOSS\b\s*:?\s*([\s\S]*?)(?=\bTAKE_PROFIT\b|\bLEVERAGE\b|\bENTRY\b|$)/i)?.[1] ?? '';
    const leverageBlock = text.match(/\bLEVERAGE\b\s*:?\s*([^\n]+)/i)?.[1] ?? '';
    const tps = nums(tpBlock);
    const sl = nums(slBlock)[0] ?? null;
    const leverage = nums(leverageBlock)[0] ?? null;
    if (!entries.length || !tps.length || sl == null || leverage == null) return null;

    const reference = this.median([sl, ...tps]);
    const normalizedEntries = entries.map((x) => this.normalizePriceScale(x, reference));
    const entryPrice = normalizedEntries.reduce((sum, x) => sum + x, 0) / normalizedEntries.length;
    const entryLow = normalizedEntries.length > 1 ? Math.min(...normalizedEntries) : null;
    const entryHigh = normalizedEntries.length > 1 ? Math.max(...normalizedEntries) : null;

    return {
      type: 'NEW',
      symbol: symbolMatch[1].toUpperCase(),
      side: sideMatch[1].toLowerCase() as 'long' | 'short',
      entryType: 'limit',
      entryPrice,
      entryLow,
      entryHigh,
      sl,
      tps,
      leverage,
      confidence: 0.95,
      newSl: null,
      closePct: null,
    };
  }

  private median(values: number[]) {
    const sorted = values.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  private normalizePriceScale(price: number, reference: number) {
    let out = price;
    if (!reference || !Number.isFinite(reference)) return out;
    while (out > 0 && out < reference / 3) out *= 10;
    while (out > reference * 3) out /= 10;
    return out;
  }

  private withPromptMemory(base: string, memory: string): string {
    const trimmed = (memory || '').trim();
    if (!trimmed) return base;
    return `${base}

--- CERVELLO GLOBALE NEWS / CONTESTO CANALI ---
Questa memoria e' costruita da Gemini leggendo tutti i canali monitorati. Usala come
contesto di mercato per disambiguare simboli, sentiment, catalyst e rischio.
Non usare questa memoria per inventare entry, stop loss o take profit se il messaggio
attuale non li contiene chiaramente. Risultati VIP, promo e performance passate sono
esclusi dalla memoria.

${trimmed}`;
  }

  private withParseContext(base: string, context: ParseContext): string {
    const lines: string[] = [];
    if (context.riskPct != null) lines.push(`riskPct=${context.riskPct}`);
    if (context.leverageMax != null) lines.push(`leverageMax=${context.leverageMax}`);
    if (!lines.length) return base;
    return `${base}

--- CONTESTO RISCHIO / BUDGET ---
${lines.join('\n')}
Per i NEW, usa questo contesto per scegliere "leverage". La leva non aumenta il rischio
massimo del trade: il backend dimensiona la size su entry-SL e riskPct, poi applica la
leva scelta/cappata all'ordine di entrata.`;
  }
}
