import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';
import { GemmaService } from '../gemma/gemma.service';

const TOP_CANDIDATES  = 500;
const CANDLES         = 260;   // 260 candles per misurare estensione swing su 200+ barre
const TIMEFRAME       = '1m';
const MAX_SL_PCT      = 1.50;
const SIGNAL_COOLDOWN = 60_000;     // 1 min cooldown per symbol
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 0.50;
const MAX_PER_CYCLE   = 1;          // at most 1 LONG + 1 SHORT per scan (2 total)
const MIN_VOLUME_24H  = 500_000;
const GEMMA_TIMEOUT   = 25_000;

export interface SmartSignal {
  id: string; symbol: string; direction: 'LONG' | 'SHORT';
  patternType: 1; patternName: string;
  entry: number; stopLoss: number; takeProfit: number;
  slPct: number; tpPct: number; suggestedLeverage: number;
  volumeRatio: number; rsi3: number; atrPct: number;
  score: number; grade: 'A+' | 'A' | 'B' | 'C';
  reasons: string[]; timestamp: string; mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
  ema9spark: number[]; ema21spark: number[];
}

@Injectable()
export class SmartScannerService implements OnModuleInit {
  private readonly logger = new Logger(SmartScannerService.name);
  private exchange: ccxt.mexc;
  private validSymbols = new Set<string>();
  private recentSignals: SmartSignal[] = [];
  private isScanning = false;
  private lastScanAt: string | null = null;
  private scannedCount = 0;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private lastCandidatesCount = 0;
  private lastPoolSize = 0;
  private dbg: Record<string, number> = {};
  private cooldowns = new Map<string, number>();
  private readonly sessionStart = new Date();

  constructor(
    private config: ConfigService,
    private indicators: IndicatorsService,
    private events: EventsGateway,
    private prisma: PrismaService,
    private liveTrading: LiveTradingService,
    private gemmaService: GemmaService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get('MEXC_API_KEY', '');
    const secret = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await this.loadMarkets();
    this.logger.log(`SmartScanner: ${this.validSymbols.size} coppie, TOP_CANDIDATES=${TOP_CANDIDATES}, TF=1m, MAX_PER_CYCLE=${MAX_PER_CYCLE}`);
    await this.initConfig();
  }

  @Cron('0 0 * * * *')
  async loadMarkets() {
    try {
      const markets = await this.exchange.loadMarkets(true);
      this.validSymbols = new Set(Object.keys(markets).filter((s) => s.endsWith('/USDT:USDT')));
    } catch (err: any) { this.logger.error(`loadMarkets: ${err.message}`); }
  }

  @Cron('20 */1 * * * *')
  async scan() {
    if (this.isScanning || this.validSymbols.size === 0) return;
    this.isScanning = true;
    try {
      const cfg = await this.getConfig();
      const tickers = await this.exchange.fetchTickers([...this.validSymbols]);
      const openSymbols = await this.getOpenSymbolsSet();

      const pool = Object.values(tickers).filter(
        (t) => this.validSymbols.has(t.symbol) && (t.quoteVolume ?? 0) >= MIN_VOLUME_24H && !openSymbols.has(t.symbol),
      );
      const candidates = pool.slice().sort(() => Math.random() - 0.5).slice(0, TOP_CANDIDATES);
      this.lastPoolSize = pool.length;
      this.lastCandidatesCount = candidates.length;
      this.scannedCount = this.validSymbols.size;
      this.dbg = {};

      // C) Fetch BTC 5m bias once per cycle — filtra trade contro BTC
      const btcBias = await this.getBtcBias();
      this.logger.log(`[SMART] BTC bias: ${btcBias}`);

      const cycleSignals: SmartSignal[] = [];
      for (const ticker of candidates) {
        const sig = await this.analyzePair(ticker, cfg, btcBias);
        if (sig) cycleSignals.push(sig);
        await new Promise((r) => setTimeout(r, 40));
      }
      this.lastRawSignals = cycleSignals.length;

      // Pick the single best LONG and single best SHORT from this cycle
      const bestLong  = cycleSignals.filter((s) => s.direction === 'LONG').sort((a, b) => b.score - a.score)[0];
      const bestShort = cycleSignals.filter((s) => s.direction === 'SHORT').sort((a, b) => b.score - a.score)[0];
      const best = [bestLong, bestShort].filter(Boolean) as SmartSignal[];

      // Se il maxConcurrent è già pieno non chiamare Gemma — risparmia token
      const openCount = await this.prisma.smartSimulatedTrade.count({ where: { status: 'open', openedAt: { gte: this.sessionStart } } });
      const cfg2 = cfg; // alias per chiarezza
      if (openCount >= cfg2.maxConcurrent) {
        this.lastScanAt = new Date().toISOString();
        this.events.server.emit('smart:status', {
          lastScanAt: this.lastScanAt, scannedPairs: this.scannedCount,
          candidates: candidates.length, rawSignals: this.lastRawSignals,
          emitted: 0, isScanning: false, debug: { ...this.dbg, maxConcurrent: 1 },
          config: { minScore: cfg.minScore, minBodyPct: cfg.minBodyPct, atrSlMult: cfg.atrSlMult, tpRr: cfg.tpRr },
        });
        return;
      }

      // Apply cooldown filter
      const toProcess = best.filter((sig) => {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        return Date.now() - last >= SIGNAL_COOLDOWN;
      });
      for (const sig of toProcess) this.cooldowns.set(sig.symbol, Date.now());

      // Sequential Gemma evaluation — small gap between calls to avoid rate limit
      let emitted = 0;
      let gemmaCallCount = 0;
      for (const sig of toProcess) {
        let verdict: { enter: boolean; reason: string };
        if (!cfg.gemmaEnabled) {
          verdict = { enter: true, reason: 'gemma-disabled' };
        } else {
          if (gemmaCallCount > 0) await new Promise((r) => setTimeout(r, 1500));
          verdict = await this.gemmaFilterSignal(sig).catch(() => ({ enter: false, reason: 'timeout' }));
          gemmaCallCount++;
        }
        const sigWithVerdict = { ...sig, gemmaApproved: verdict.enter, gemmaReason: verdict.reason };
        this.recentSignals.unshift(sigWithVerdict as any);
        if (this.recentSignals.length > 300) this.recentSignals.pop();
        this.events.server.emit('smart:signal', sigWithVerdict);
        if (verdict.enter) {
          await this.enterSimTrade(sig, cfg).catch(() => {});
          if (cfg.liveEnabled) {
            await this.liveTrading.enterTrade({
              symbol: sig.symbol, direction: sig.direction, grade: 'A+',
              entry: sig.entry, slPct: sig.slPct, tp1Pct: sig.tpPct,
              suggestedLeverage: sig.suggestedLeverage, score: sig.score,
            }).catch((err) => this.logger.error(`[SMART LIVE] ${err.message}`));
          }
          emitted++;
          this.logger.log(`[SMART ✅] ${sig.direction} ${sig.symbol} ${sig.patternName} score=${sig.score} — ${verdict.reason}`);
        } else {
          this.logger.log(`[SMART ❌] ${sig.direction} ${sig.symbol} ${sig.patternName} score=${sig.score} — RIFIUTATO: ${verdict.reason}`);
        }
      }
      this.lastEmitted = emitted;
      this.lastScanAt = new Date().toISOString();
      this.events.server.emit('smart:status', {
        lastScanAt: this.lastScanAt, scannedPairs: this.scannedCount,
        candidates: candidates.length, rawSignals: this.lastRawSignals,
        emitted, isScanning: false, debug: { ...this.dbg },
        config: { minScore: cfg.minScore, minBodyPct: cfg.minBodyPct, atrSlMult: cfg.atrSlMult, tpRr: cfg.tpRr },
      });
    } catch (err: any) { this.logger.error(`SmartScan: ${err.message}`); }
    finally { this.isScanning = false; }
  }

  @Cron('*/15 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.smartSimulatedTrade.findMany({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (!open.length) return;
      const cfg = await this.getConfig();

      for (const t of open) {
        try {
          const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 3);
          if (!ohlcv.length) continue;
          const curr   = ohlcv.at(-1)![4] as number;
          const isLong = t.direction === 'LONG';
          const uPnl   = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const uPct   = (curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100;
          this.events.server.emit('smart:positions', [{
            id: t.id, currentPrice: curr,
            unrealizedPnl: parseFloat(uPnl.toFixed(4)),
            unrealizedPnlPct: parseFloat(uPct.toFixed(3)),
          }]);

          const hitSL = isLong ? curr <= t.stopLoss    : curr >= t.stopLoss;
          const hitTP = isLong ? curr >= t.takeProfit1 : curr <= t.takeProfit1;
          if (!hitSL && !hitTP) continue;

          const status     = hitTP ? 'tp1' : 'sl';
          const closePrice = hitTP ? t.takeProfit1 : t.stopLoss;
          const pnlRaw     = (closePrice - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const exitFee    = t.positionSize * TAKER_FEE;
          const totalFees  = (t.fees ?? 0) + exitFee;  // entry fee (already stored) + exit fee
          const pnl        = pnlRaw - totalFees;
          const capitalAfter = t.capitalBefore + pnl;

          await this.prisma.smartSimulatedTrade.update({
            where: { id: t.id },
            data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(totalFees.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
          });
          if (cfg.autoEnter) {
            await this.prisma.smartSimConfig.update({ where: { id: 1 }, data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) } });
          }
          const updated = await this.prisma.smartSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.server.emit('smart:trade', updated);
          this.logger.log(`[SMART CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err: any) { this.logger.error(`Smart checkOpenTrades: ${err.message}`); }
  }

  // ─── GEMMA SIGNAL FILTER ─────────────────────────────────────────────────
  private async gemmaFilterSignal(sig: SmartSignal): Promise<{ enter: boolean; reason: string }> {
    if (!this.gemmaService.currentModel) return { enter: false, reason: 'no-api-key' };

    const chart = this._asciiChart(sig);
    const pair  = sig.symbol.replace('/USDT:USDT', '');
    const prompt = `Trader futures MEXC 1m. Valuta se entrare.

${pair} ${sig.direction} | ${sig.patternName} | Score ${sig.score} (${sig.grade})
Entry ${sig.entry} SL -${sig.slPct}% TP +${sig.tpPct}% | RSI ${sig.rsi3} Vol ${sig.volumeRatio}x
${sig.reasons.join(', ')}

${chart}
Chart live: ${sig.mexcUrl}

JSON su una riga, nient'altro: {"enter":true,"reason":"max 12 parole"}`;

    const apiBody = {
      systemInstruction: { parts: [{ text: 'Rispondi esclusivamente con JSON valido su una riga. Niente markdown, niente testo extra.' }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 60 },
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMMA_TIMEOUT);
      try {
        const res = await Promise.race([
          this.gemmaService.callApi(apiBody),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), GEMMA_TIMEOUT)),
        ]);
        clearTimeout(timeout);
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        if (!res.ok) {
          if (attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
          // Fallback su errori 5xx: se score alto i filtri tecnici sono già ok
          if (res.status >= 500 && sig.score >= 55) {
            return { enter: true, reason: `auto-approved score=${sig.score} (Gemma ${res.status})` };
          }
          return { enter: false, reason: `api-${res.status}` };
        }
        const data = await res.json() as any;
        const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
        const raw = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('')
          .replace(/```[\w]*\n?/g, '').trim();  // strip markdown fences
        const match = raw.match(/\{[^}]*\}/);   // flat JSON only
        if (!match) {
          // Try to extract intent from plain text as fallback
          const lower = raw.toLowerCase();
          if (lower.includes('non entrare') || lower.includes('rifiut') || lower.includes('evita')) {
            return { enter: false, reason: raw.slice(0, 60) };
          }
          if (attempt === 0) continue;
          return { enter: false, reason: 'parse-error' };
        }
        const parsed = JSON.parse(match[0]);
        return { enter: parsed.enter !== false, reason: String(parsed.reason ?? '').slice(0, 80) };
      } catch {
        clearTimeout(timeout);
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        return { enter: false, reason: 'timeout' };
      }
    }
    return { enter: false, reason: 'gemma-fail' };
  }

  // ─── GEMMA OPTIMIZER — ogni 5 minuti ─────────────────────────────────────
  @Interval(300_000)
  async gemmaOptimize() {
    const cfg = await this.getConfig();
    if (!cfg.autoOptimize) return;

    const closed = await this.prisma.smartSimulatedTrade.findMany({
      where: { status: { not: 'open' }, openedAt: { gte: this.sessionStart } },
      orderBy: { closedAt: 'desc' }, take: 50,
    });
    if (closed.length < 8) {
      this.logger.log(`[SMART OPT] Skip — solo ${closed.length} trade chiusi`);
      return;
    }

    const wins   = closed.filter((t) => t.status === 'tp1');
    const losses = closed.filter((t) => t.status === 'sl');
    const winRate = closed.length > 0 ? (wins.length / closed.length * 100).toFixed(1) : '0';

    const patNames: Record<number, string> = { 1: 'TREND_BURST' };
    const byPattern = [1].map((pt) => {
      const label = patNames[pt];
      const group = closed.filter((t) => t.patternType === pt);
      const gWins = group.filter((t) => t.status === 'tp1').length;
      const avgScore = group.length ? (group.reduce((s, t) => s + t.score, 0) / group.length).toFixed(1) : 'n/a';
      return `  - ${label}: ${gWins}W/${group.length - gWins}L su ${group.length} trade, score medio ${avgScore}`;
    }).join('\n');

    const avgSlWin  = wins.length  ? (wins.reduce((s, t) => s + Math.abs((t.entry - t.stopLoss) / t.entry * 100), 0) / wins.length).toFixed(3) : 'n/a';
    const avgSlLoss = losses.length ? (losses.reduce((s, t) => s + Math.abs((t.entry - t.stopLoss) / t.entry * 100), 0) / losses.length).toFixed(3) : 'n/a';
    const avgScoreWin  = wins.length  ? (wins.reduce((s, t) => s + t.score, 0) / wins.length).toFixed(1) : 'n/a';
    const avgScoreLoss = losses.length ? (losses.reduce((s, t) => s + t.score, 0) / losses.length).toFixed(1) : 'n/a';

    const prompt = `Stai ottimizzando un bot di trading su MEXC Futures su candele 1 minuto.
Il bot usa 4 pattern istituzionali: ORDER_BLOCK (zona di ordine istituzionale con retest), FVG (Fair Value Gap retest), LIQ_SWEEP (liquidity sweep + reversal), RANGE_BRK (breakout da consolidazione).
Ogni trade apre con rischio fisso €0.50, SL strutturale + ATR, TP a rapporto ${cfg.tpRr}:1.

═══ STATISTICHE ULTIMI ${closed.length} TRADE CHIUSI ═══
Win rate: ${winRate}% — ${wins.length} TP colpiti / ${losses.length} SL colpiti

Breakdown per pattern:
${byPattern}

Confronto vincitori vs perdenti:
• Trade che hanno preso TP → SL medio: ${avgSlWin}% | score medio: ${avgScoreWin}
• Trade che hanno preso SL → SL medio: ${avgSlLoss}% | score medio: ${avgScoreLoss}

═══ PARAMETRI CORRENTI ═══
• minScore = ${cfg.minScore}      → soglia minima per emettere un segnale
• minBodyPct = ${cfg.minBodyPct}  → corpo minimo della candela imbalance (0.35 = 35%)
• atrSlMult = ${cfg.atrSlMult}   → moltiplicatore ATR per stop loss
• tpRr = ${cfg.tpRr}            → rapporto rischio/rendimento del TP

═══ ISTRUZIONI ═══
Analizza se i trade persi hanno caratteristiche comuni (SL troppo stretto? score basso? pattern specifico debole?).
Proponi modifiche mirate per ridurre le perdite mantenendo i segnali profittevoli.
Rispondi SOLO con JSON valido:
{"analysis":"analisi in italiano (max 3 frasi)","changes":{"minScore":42,"minBodyPct":0.35,"atrSlMult":1.2,"tpRr":2.0},"reason":"spiegazione modifiche (1-2 frasi)"}

LIMITI: minScore[28-70] minBodyPct[0.25-0.60] atrSlMult[0.8-2.5] tpRr[1.5-4.0]`;

    try {
      const res = await this.gemmaService.callApi({
        systemInstruction: { parts: [{ text: 'Sei un ottimizzatore di parametri per trading bot. Rispondi SOLO con JSON valido.' }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 512 },
      });

      if (!res.ok) { this.logger.error(`Gemma opt error ${res.status}`); return; }

      const data = await res.json() as any;
      const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      const raw = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();

      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) { this.logger.warn(`[SMART OPT] No JSON: ${raw.slice(0, 200)}`); return; }

      const parsed = JSON.parse(jsonMatch[0]);
      const ch = parsed.changes ?? {};

      const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
      const newCfg: any = {};
      if (typeof ch.minScore   === 'number') newCfg.minScore   = clamp(Math.round(ch.minScore), 28, 70);
      if (typeof ch.minBodyPct === 'number') newCfg.minBodyPct = parseFloat(clamp(ch.minBodyPct, 0.25, 0.60).toFixed(2));
      if (typeof ch.atrSlMult  === 'number') newCfg.atrSlMult  = parseFloat(clamp(ch.atrSlMult,  0.8,  2.5).toFixed(2));
      if (typeof ch.tpRr       === 'number') newCfg.tpRr       = parseFloat(clamp(ch.tpRr,       1.5,  4.0).toFixed(2));

      if (Object.keys(newCfg).length) {
        await this.prisma.smartSimConfig.update({ where: { id: 1 }, data: newCfg });
      }

      const log = await this.prisma.smartOptLog.create({
        data: {
          tradesAnalyzed: closed.length,
          analysis: parsed.analysis ?? '',
          changes: JSON.stringify(newCfg),
          reason: parsed.reason ?? '',
          applied: Object.keys(newCfg).length > 0,
        },
      });

      this.logger.log(`[SMART OPT] Applied: ${JSON.stringify(newCfg)} — ${parsed.reason}`);
      this.events.server.emit('smart:opt-log', log);
    } catch (err: any) { this.logger.error(`gemmaOptimize: ${err.message}`); }
  }

  // ─── BTC BIAS — una volta per ciclo ──────────────────────────────────────
  private async getBtcBias(): Promise<'bullish' | 'bearish' | 'neutral'> {
    try {
      const raw = await this.exchange.fetchOHLCV('BTC/USDT:USDT', '5m', undefined, 20);
      if (raw.length < 10) return 'neutral';
      const closes  = raw.map((c) => c[4] as number);
      const ema9btc = this.indicators.emaArray(closes, 9);
      if (ema9btc.length < 5) return 'neutral';
      const slope = (ema9btc.at(-1)! - ema9btc.at(-5)!) / ema9btc.at(-5)! * 100;
      return slope > 0.10 ? 'bullish' : slope < -0.10 ? 'bearish' : 'neutral';
    } catch { return 'neutral'; }
  }

  // ─── PATTERN ANALYSIS — TREND_BURST ──────────────────────────────────────
  // Unico pattern: entra quando il momentum è già visibile e confermato.
  // Macro trend (50c) + micro trend (EMA9/21) allineati + candela trigger grossa
  // con volume → SL sotto/sopra la candela stessa → risolve in 2-8 minuti.
  // A) Live candle confirmation: la candela in formazione deve confermare la direzione
  // C) BTC bias: solo LONG se BTC bullish, solo SHORT se BTC bearish (neutral = skip)
  private async analyzePair(ticker: ccxt.Ticker, cfg: any, btcBias: 'bullish' | 'bearish' | 'neutral'): Promise<SmartSignal | null> {
    const MIN_SCORE   = cfg.minScore;
    const ATR_SL_MULT = cfg.atrSlMult;
    const TP_RR       = cfg.tpRr;
    try {
      const sym = ticker.symbol;
      const raw = await this.exchange.fetchOHLCV(sym, TIMEFRAME, undefined, CANDLES);
      if (raw.length < 60) { this.dbg['L0_no_data'] = (this.dbg['L0_no_data'] ?? 0) + 1; return null; }

      const o1 = raw.map((c) => c[1] as number);
      const h1 = raw.map((c) => c[2] as number);
      const l1 = raw.map((c) => c[3] as number);
      const c1 = raw.map((c) => c[4] as number);
      const v1 = raw.map((c) => c[5] as number);
      const n  = c1.length;

      const ema9arr  = this.indicators.emaArray(c1, 9);
      const ema21arr = this.indicators.emaArray(c1, 21);
      const rsi3arr  = this.indicators.rsiArray(c1, 3);
      const atr14    = this.indicators.atr(h1, l1, c1, 14);

      if (ema21arr.length < 55 || rsi3arr.length < 5) { this.dbg['L0_ema_short'] = (this.dbg['L0_ema_short'] ?? 0) + 1; return null; }

      const ema21_1 = ema21arr.at(-1)!;
      const ema21_50 = ema21arr.at(-50)!;
      const rsi_1   = rsi3arr.at(-1)!;
      const entry   = c1[n - 2];
      if (!entry || entry <= 0) { this.dbg['L0_entry_null'] = (this.dbg['L0_entry_null'] ?? 0) + 1; return null; }

      const atrPct = atr14 / entry * 100;

      // Volume ratio (ultime 25 candele esclusa l'ultima chiusa)
      const refVols   = v1.slice(n - 25, n - 2);
      const refAvgVol = refVols.reduce((a, b) => a + b, 0) / refVols.length;
      const volR      = refAvgVol > 0 ? v1[n - 2] / refAvgVol : 1;

      // ── TREND_BURST ────────────────────────────────────────────────────────
      // 1) Macro trend: slope EMA21 su 50 candele (50 minuti di contesto)
      const macroSlope = (ema21_1 - ema21_50) / ema21_50 * 100;
      const macroUp    = macroSlope >  0.15;
      const macroDown  = macroSlope < -0.15;
      if (!macroUp && !macroDown) { this.dbg['F_macro_flat'] = (this.dbg['F_macro_flat'] ?? 0) + 1; return null; }

      const isLong = macroUp;

      // C) BTC bias: blocca solo se la direzione è OPPOSTA a BTC.
      // Neutral = BTC consolida, permettiamo segnali in entrambe le direzioni.
      if (isLong  && btcBias === 'bearish') { this.dbg['F_btc'] = (this.dbg['F_btc'] ?? 0) + 1; return null; }
      if (!isLong && btcBias === 'bullish') { this.dbg['F_btc'] = (this.dbg['F_btc'] ?? 0) + 1; return null; }

      // 3) Candela trigger: chiude in direzione trend
      const trigBullish = c1[n-2] > o1[n-2];
      const trigBearish = c1[n-2] < o1[n-2];
      if ((isLong && !trigBullish) || (!isLong && !trigBearish)) {
        this.dbg['F_dir'] = (this.dbg['F_dir'] ?? 0) + 1; return null;
      }

      // 4) Body della candela trigger ≥ 1.8× media delle ultime 10
      let totalBody = 0;
      for (let i = n - 12; i <= n - 3; i++) totalBody += Math.abs(c1[i] - o1[i]);
      const avgBody  = totalBody / 10;
      const trigBody = Math.abs(c1[n-2] - o1[n-2]);
      const bodyMult = avgBody > 0 ? trigBody / avgBody : 0;
      if (bodyMult < 1.3) { this.dbg['F_body'] = (this.dbg['F_body'] ?? 0) + 1; return null; }

      // 5) Volume trigger ≥ 1.3× media (conferma che qualcuno sta comprando/vendendo)
      if (volR < 1.3) { this.dbg['F_vol_burst'] = (this.dbg['F_vol_burst'] ?? 0) + 1; return null; }

      // 6) RSI nella zona giusta: non entrare a mercato già esausto
      const rsiOk = isLong ? (rsi_1 >= 45 && rsi_1 <= 65) : (rsi_1 >= 35 && rsi_1 <= 55);
      if (!rsiOk) { this.dbg['F_rsi'] = (this.dbg['F_rsi'] ?? 0) + 1; return null; }

      // A) Conferma live candle: la candela in formazione (n-1) deve essere
      // nella stessa direzione del burst — se già ritraccia non entriamo
      const liveOk = isLong ? c1[n-1] > o1[n-1] : c1[n-1] < o1[n-1];
      if (!liveOk) { this.dbg['F_live_retrace'] = (this.dbg['F_live_retrace'] ?? 0) + 1; return null; }

      // 7) SL sotto il minimo (LONG) / sopra il massimo (SHORT) della candela trigger
      const calcSlLong  = (s: number) => Math.min(s, entry - atr14 * ATR_SL_MULT);
      const calcSlShort = (s: number) => Math.max(s, entry + atr14 * ATR_SL_MULT);
      const slPctOf     = (sl: number, d: 'L' | 'S') => d === 'L' ? (entry - sl) / entry * 100 : (sl - entry) / entry * 100;

      const structSl = isLong ? l1[n-2] * 0.998 : h1[n-2] * 1.002;
      const slLevel  = isLong ? calcSlLong(structSl) : calcSlShort(structSl);
      const slPct    = Math.max(slPctOf(slLevel, isLong ? 'L' : 'S'), 0.05);
      if (slPct > MAX_SL_PCT) { this.dbg['F_sl_wide'] = (this.dbg['F_sl_wide'] ?? 0) + 1; return null; }

      // Score
      let score = 40; const reasons: string[] = ['Trend Burst'];
      if (bodyMult >= 3.0)      { score += 15; reasons.push(`Body ×${bodyMult.toFixed(1)}`); }
      else if (bodyMult >= 2.5) { score += 10; reasons.push(`Body ×${bodyMult.toFixed(1)}`); }
      else                      { score += 6;  reasons.push(`Body ×${bodyMult.toFixed(1)}`); }
      if (Math.abs(macroSlope) > 0.50)      { score += 12; reasons.push(`Macro ${macroSlope.toFixed(2)}%`); }
      else if (Math.abs(macroSlope) > 0.25) { score += 8;  reasons.push(`Macro ${macroSlope.toFixed(2)}%`); }
      else                                   { score += 4; }
      score += this._vb(volR, reasons) + this._rb(rsi_1, isLong, reasons);

      if (score < MIN_SCORE) { this.dbg['SCORE'] = (this.dbg['SCORE'] ?? 0) + 1; return null; }
      this.dbg['PRE_SIG'] = (this.dbg['PRE_SIG'] ?? 0) + 1;
      return this._sig(sym, isLong ? 'LONG' : 'SHORT', entry, slLevel, slPct, TP_RR, 1, 'TREND_BURST', score, volR, rsi_1, atrPct, reasons, raw, ema9arr, ema21arr);
    } catch { this.dbg['L0_error'] = (this.dbg['L0_error'] ?? 0) + 1; return null; }
  }

  private _asciiChart(sig: SmartSignal): string {
    const bars = sig.sparkline;
    if (bars.length < 8) return '';
    // Aggregate into ~60 chars regardless of input length (each char = N candles)
    const step  = Math.max(1, Math.ceil(bars.length / 60));
    const buckets: number[] = [];
    for (let i = 0; i < bars.length; i += step) {
      const slice = bars.slice(i, i + step);
      buckets.push(slice.reduce((s, b) => s + b.c, 0) / slice.length);
    }
    const min = Math.min(...buckets), max = Math.max(...buckets);
    const range = max - min || 1;
    const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    const line = buckets.map((p) => BLOCKS[Math.round((p - min) / range * 7)]).join('');
    const e9  = sig.ema9spark.at(-1) ?? 0;
    const e21 = sig.ema21spark.at(-1) ?? 0;
    const trend = e9 > e21 ? '↑ EMA9>EMA21 (bullish)' : '↓ EMA9<EMA21 (bearish)';
    const minutes = bars.length;
    return `Grafico prezzi ultimi ${minutes} min (1 char = ${step} candle):\n${line}\nMin=${min.toPrecision(6)} Max=${max.toPrecision(6)} Curr=${bars.at(-1)!.c.toPrecision(6)} | ${trend}`;
  }

  private _vb(volR: number, r: string[]) { if (volR >= 2.5) { r.push(`Vol ×${volR.toFixed(1)}`); return 12; } if (volR >= 1.5) { r.push(`Vol ×${volR.toFixed(1)}`); return 8; } if (volR >= 1.0) return 5; return 2; }
  private _rb(rsi: number, isLong: boolean, r: string[]) { if (isLong) { if (rsi < 35) { r.push(`RSI ${rsi.toFixed(0)}`); return 8; } if (rsi < 50) return 5; return 2; } else { if (rsi > 65) { r.push(`RSI ${rsi.toFixed(0)}`); return 8; } if (rsi > 50) return 5; return 2; } }

  private _sig(sym: string, dir: 'LONG' | 'SHORT', entry: number, slLevel: number, slPct: number, tpRr: number, pt: 1, pn: string, score: number, volR: number, rsi3: number, atrPct: number, reasons: string[], raw: number[][], e9: number[], e21: number[]): SmartSignal {
    const isLong = dir === 'LONG';
    const tpPct  = slPct * tpRr;
    const grade: SmartSignal['grade'] = score >= 70 ? 'A+' : score >= 56 ? 'A' : score >= 42 ? 'B' : 'C';
    return {
      id: `${sym}_${Date.now()}`, symbol: sym, direction: dir, patternType: pt, patternName: pn,
      entry, stopLoss: parseFloat(slLevel.toPrecision(6)),
      takeProfit: parseFloat((entry * (isLong ? 1 + tpPct / 100 : 1 - tpPct / 100)).toPrecision(6)),
      slPct: parseFloat(slPct.toFixed(3)), tpPct: parseFloat(tpPct.toFixed(3)),
      suggestedLeverage: Math.min(Math.round(5 / slPct), 50),
      volumeRatio: parseFloat(volR.toFixed(2)), rsi3: parseFloat(rsi3.toFixed(1)),
      atrPct: parseFloat(atrPct.toFixed(3)), score, grade, reasons,
      timestamp: new Date().toISOString(),
      mexcUrl: `https://futures.mexc.com/exchange/${sym.replace('/USDT:USDT', '_USDT')}`,
      sparkline: raw.slice(-90).map((c) => ({ t: c[0] as number, o: c[1] as number, h: c[2] as number, l: c[3] as number, c: c[4] as number })),
      ema9spark: e9.slice(-90), ema21spark: e21.slice(-90),
    };
  }

  private async enterSimTrade(sig: SmartSignal, cfg: any) {
    if (!cfg.autoEnter) return;
    const openCount = await this.prisma.smartSimulatedTrade.count({ where: { status: 'open', openedAt: { gte: this.sessionStart } } });
    if (openCount >= cfg.maxConcurrent) return;
    const id = `${sig.id}_smart`;
    const exists = await this.prisma.smartSimulatedTrade.findUnique({ where: { id } });
    if (exists) return;
    const pSize = RISK_EUR * 100 / sig.slPct;
    const trade = await this.prisma.smartSimulatedTrade.create({
      data: {
        id, symbol: sig.symbol, direction: sig.direction, patternType: sig.patternType,
        entry: sig.entry, stopLoss: sig.stopLoss,
        takeProfit1: sig.takeProfit, takeProfit2: sig.takeProfit,
        leverage: sig.suggestedLeverage, riskEur: RISK_EUR,
        positionSize: parseFloat(pSize.toFixed(4)),
        marginEur: parseFloat((pSize / sig.suggestedLeverage).toFixed(4)),
        grade: sig.grade, score: sig.score,
        fees: parseFloat((pSize * TAKER_FEE).toFixed(4)),
        capitalBefore: parseFloat(cfg.startingCapital.toFixed(4)),
        status: 'open',
      },
    });
    this.events.server.emit('smart:trade', trade);
  }

  private async initConfig() {
    await this.prisma.smartSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 45, minBodyPct: 0.40, atrSlMult: 1.5, tpRr: 2.5, autoOptimize: true, gemmaEnabled: true, liveEnabled: false },
      update: {},
    });
  }

  private async getConfig() { return this.prisma.smartSimConfig.findFirstOrThrow({ where: { id: 1 } }); }
  private async getOpenSymbolsSet() {
    const open = await this.prisma.smartSimulatedTrade.findMany({ where: { status: 'open', openedAt: { gte: this.sessionStart } }, select: { symbol: true } });
    return new Set(open.map((t) => t.symbol));
  }

  // ─── API ──────────────────────────────────────────────────────────────────
  getRecentSignals(limit = 50) { return this.recentSignals.slice(0, limit); }
  getDebug()  { return { ...this.dbg, timestamp: new Date().toISOString() }; }
  getStatus() { return { lastScanAt: this.lastScanAt, scannedPairs: this.scannedCount, poolSize: this.lastPoolSize, candidates: this.lastCandidatesCount, rawSignals: this.lastRawSignals, emitted: this.lastEmitted, isScanning: this.isScanning }; }

  async getAnalytics() {
    const cfg    = await this.getConfig();
    const all    = await this.prisma.smartSimulatedTrade.findMany({ where: { openedAt: { gte: this.sessionStart } }, orderBy: { openedAt: 'desc' } });
    const closed = all.filter((t) => t.status !== 'open');
    const open   = all.filter((t) => t.status === 'open');
    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0).length;
    const totalPnl  = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate   = closed.length > 0 ? wins / closed.length * 100 : 0;
    const avgWin    = wins > 0 ? closed.filter((t) => (t.pnl ?? 0) > 0).reduce((s, t) => s + (t.pnl ?? 0), 0) / wins : 0;
    const avgLoss   = losses > 0 ? Math.abs(closed.filter((t) => (t.pnl ?? 0) <= 0).reduce((s, t) => s + (t.pnl ?? 0), 0)) / losses : 0;
    let peak = cfg.startingCapital, maxDd = 0;
    for (const t of [...closed].reverse()) {
      const cap = t.capitalAfter ?? cfg.startingCapital;
      if (cap > peak) peak = cap;
      const dd = (peak - cap) / peak * 100; if (dd > maxDd) maxDd = dd;
    }
    return {
      totalTrades: all.length, openTrades: open.length, wins, losses,
      winRate: parseFloat(winRate.toFixed(1)), totalPnl: parseFloat(totalPnl.toFixed(3)),
      currentCapital: cfg.startingCapital,
      avgWinEur: parseFloat(avgWin.toFixed(3)), avgLossEur: parseFloat(avgLoss.toFixed(3)),
      profitFactor: avgLoss > 0 ? parseFloat((avgWin / avgLoss).toFixed(2)) : avgWin > 0 ? 99 : 0,
      maxDrawdownPct: parseFloat(maxDd.toFixed(1)),
      config: { startingCapital: cfg.startingCapital, maxConcurrent: cfg.maxConcurrent, autoEnter: cfg.autoEnter, minScore: cfg.minScore, minBodyPct: cfg.minBodyPct, atrSlMult: cfg.atrSlMult, tpRr: cfg.tpRr, autoOptimize: cfg.autoOptimize, gemmaEnabled: cfg.gemmaEnabled, liveEnabled: cfg.liveEnabled },
    };
  }

  async getOptLogs() { return this.prisma.smartOptLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }); }
  async getOpenTrades()  { return this.prisma.smartSimulatedTrade.findMany({ where: { status: 'open', openedAt: { gte: this.sessionStart } }, orderBy: { openedAt: 'desc' } }); }
  async getClosedTrades(limit = 100) { return this.prisma.smartSimulatedTrade.findMany({ where: { status: { not: 'open' }, openedAt: { gte: this.sessionStart } }, orderBy: { closedAt: 'desc' }, take: limit }); }

  async updateConfig(cfg: any) {
    await this.prisma.smartSimConfig.update({ where: { id: 1 }, data: cfg });
    const updated = await this.prisma.smartSimConfig.findFirstOrThrow({ where: { id: 1 } });
    this.events.server.emit('smart:config', { liveEnabled: updated.liveEnabled, autoOptimize: updated.autoOptimize });
    return { ok: true };
  }
  async resetSim() {
    await this.prisma.smartSimulatedTrade.deleteMany();
    await this.prisma.smartSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    return { ok: true };
  }
  async triggerOptimize() { await this.gemmaOptimize(); return { ok: true }; }
}
