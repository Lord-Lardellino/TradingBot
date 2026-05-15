import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

export interface BrainParams {
  enabled:           boolean;
  atrMultSl:         number;
  tp1Rr:             number;
  tp2Rr:             number;
  minSlPct:          number;
  minEma5mSlope:     number;
  minEmitScore:      number;
  minVolRatio:       number;
  enterGrades:       string;
  allowedDirections: string;  // 'LONG,SHORT' | 'LONG' | 'SHORT'
  mode:              string;  // aggressive | healthy | normal | conservative | crisis | paused
  consecutiveLosses: number;
  lastAnalysisAt?:   Date | null;
  lastWinRate?:      number | null;
  totalAnalyses:     number;
}

export const BRAIN_DEFAULTS: Omit<BrainParams, 'enabled' | 'lastAnalysisAt' | 'lastWinRate' | 'totalAnalyses'> = {
  atrMultSl:         1.5,
  tp1Rr:             1.8,   // TP1 = 1.8× SL — misurazione squeeze height
  tp2Rr:             3.0,
  minSlPct:          0.30,  // SL minimo 0.30% — VCB usa SL strutturale sotto squeeze zone
  minEma5mSlope:     0.001,
  minEmitScore:      30,    // soglia bassa: scoring VCB ha floor naturale ~31 pts
  minVolRatio:       1.0,
  enterGrades:       'A+,A,B',
  allowedDirections: 'LONG,SHORT',
  mode:              'normal',
  consecutiveLosses: 0,
};

// Bounds assoluti — il brain non può mai uscire da questi range
const BOUNDS = {
  atrMultSl:     { min: 0.8,  max: 2.0   },
  tp1Rr:         { min: 1.5,  max: 3.5   },
  tp2Rr:         { min: 2.0,  max: 5.0   },
  minSlPct:      { min: 0.20, max: 1.00  },
  minEma5mSlope: { min: 0.001,max: 0.015 },
  minEmitScore:  { min: 20,   max: 80    },
  minVolRatio:   { min: 0.6,  max: 3.0   },
};

// ── Soglie di modo ────────────────────────────────────────────────────────────
const MODE_THRESHOLDS = {
  paused:       { consec: 7 },
  crisis:       { wr10: 28, wr20: 35, drawdown: 10 },
  conservative: { wr20: 44, consec: 4, drawdown: 6  },
  healthy:      { wr20: 58, pf: 1.2  },
  aggressive:   { wr20: 70, pf: 1.8  },
};

@Injectable()
export class AiBrainService {
  private readonly logger = new Logger(AiBrainService.name);

  private cache: BrainParams | null = null;
  private cacheAt = 0;
  private readonly CACHE_TTL = 30_000;

  constructor(private prisma: PrismaService) {}

  // ── Lettura parametri (con cache 30s) ─────────────────────────────────────

  async getParams(): Promise<BrainParams> {
    if (this.cache && Date.now() - this.cacheAt < this.CACHE_TTL) return this.cache;
    let row = await this.prisma.aiParams.findUnique({ where: { id: 1 } });
    if (!row) {
      row = await this.prisma.aiParams.create({
        data: { id: 1, ...BRAIN_DEFAULTS, enabled: false },
      });
    }
    this.cache  = row as unknown as BrainParams;
    this.cacheAt = Date.now();
    return this.cache;
  }

  invalidateCache() { this.cache = null; }

  async toggle(enabled: boolean): Promise<BrainParams> {
    const row = await this.prisma.aiParams.upsert({
      where:  { id: 1 },
      create: { id: 1, ...BRAIN_DEFAULTS, enabled },
      update: { enabled },
    });
    this.invalidateCache();
    this.logger.log(`[Brain] ${enabled ? '🟢 ATTIVATO' : '🔴 DISATTIVATO'}`);
    return row as unknown as BrainParams;
  }

  async updateParams(data: Partial<BrainParams>): Promise<BrainParams> {
    const safe: any = {};
    for (const [k, v] of Object.entries(data)) {
      if (k in BOUNDS) {
        const b = BOUNDS[k as keyof typeof BOUNDS];
        safe[k] = Math.max(b.min, Math.min(b.max, Number(v)));
      } else {
        safe[k] = v;
      }
    }
    const row = await this.prisma.aiParams.upsert({
      where:  { id: 1 },
      create: { id: 1, ...BRAIN_DEFAULTS, enabled: false, ...safe },
      update: safe,
    });
    this.invalidateCache();
    return row as unknown as BrainParams;
  }

  async resetToDefaults(): Promise<BrainParams> {
    const row = await this.prisma.aiParams.upsert({
      where:  { id: 1 },
      create: { id: 1, ...BRAIN_DEFAULTS, enabled: false },
      update: { ...BRAIN_DEFAULTS },
    });
    this.invalidateCache();
    this.logger.log('[Brain] Reset ai parametri di default');
    return row as unknown as BrainParams;
  }

  async getLog(limit = 50) {
    return this.prisma.aiBrainLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANALISI AUTONOMA — ogni 5 minuti
  //
  // Il brain attraversa 4 fasi per ogni ciclo:
  //   1. LOAD     — raccoglie trade chiusi + stato simulazione
  //   2. METRICS  — calcola ~20 indicatori su finestre [5, 10, 20, 30] trade
  //   3. MODE     — classifica la situazione in uno dei 6 stati operativi
  //   4. ADJUST   — genera e applica le modifiche necessarie, con priorità
  // ══════════════════════════════════════════════════════════════════════════

  @Cron('0 */5 * * * *')
  async analyzeAndAdapt() {
    const params = await this.getParams();
    if (!params.enabled) return;

    // ── 1. LOAD ────────────────────────────────────────────────────────────
    const trades = await this.prisma.simulatedTrade.findMany({
      where:   { status: { not: 'open' } },
      orderBy: { closedAt: 'desc' },
      take:    50,
    });

    if (trades.length < 8) {
      this.logger.debug('[Brain] Dati insufficienti (< 8 trade chiusi)');
      return;
    }

    // ── 2. METRICS ────────────────────────────────────────────────────────
    const m = this.computeMetrics(trades);

    // ── 3. MODE ───────────────────────────────────────────────────────────
    const mode = this.determineMode(m);

    // ── 4. ADJUST ─────────────────────────────────────────────────────────
    const rawAdj  = this.buildAdjustments(m, mode, params);

    // Ordina per priorità, deduplicando per parametro (tiene solo il più prioritario)
    rawAdj.sort((a, b) => b.priority - a.priority);
    const seen    = new Set<string>();
    const allAdj  = rawAdj.filter(a => {
      if (seen.has(a.param) || a.from === a.to) return false;
      seen.add(a.param);
      return true;
    });

    // In crisi si applicano tutte le modifiche necessarie; in normale max 2
    const maxApply = (mode === 'crisis' || mode === 'paused') ? 6 : mode === 'conservative' ? 3 : 2;
    const toApply  = allAdj.slice(0, maxApply);

    // ── Costruisci l'aggiornamento ─────────────────────────────────────────
    const updateData: Record<string, any> = {
      lastAnalysisAt:    new Date(),
      lastWinRate:       +m.winRate20.toFixed(1),
      totalAnalyses:     params.totalAnalyses + 1,
      mode,
      consecutiveLosses: m.consecutiveLosses,
    };
    for (const adj of toApply) updateData[adj.param] = adj.to;

    // Emergenza: troppe perdite consecutive → pausa operativa
    if (mode === 'paused') {
      updateData.enabled = false;
      this.logger.warn(`[Brain] 🛑 EMERGENZA: ${m.consecutiveLosses} perdite consecutive — trading sospeso. Riattivare manualmente dopo analisi.`);
    }

    await this.prisma.aiParams.upsert({
      where:  { id: 1 },
      create: { id: 1, ...BRAIN_DEFAULTS, enabled: true, ...updateData },
      update: updateData,
    });

    if (toApply.length || mode !== params.mode) this.invalidateCache();

    // ── Log ───────────────────────────────────────────────────────────────
    const changeStr = toApply.map(a => `${a.param}: ${a.from}→${a.to}`).join(' | ');
    const summary   = toApply.length
      ? `[${mode.toUpperCase()}] WR ${m.winRate20.toFixed(0)}% (↑5m:${m.winRate5.toFixed(0)}%) → ${changeStr}`
      : `[${mode.toUpperCase()}] WR ${m.winRate20.toFixed(0)}% su ${m.window20} trade — nessuna modifica`;

    await this.prisma.aiBrainLog.create({
      data: {
        winRate:        +m.winRate20.toFixed(1),
        tradesAnalyzed: trades.length,
        changes:        JSON.stringify(toApply),
        summary,
        action:         mode,
        mode,
      },
    });

    const icon: Record<string, string> = {
      paused: '🛑', crisis: '🚨', conservative: '⚠️',
      normal: '🔧', healthy: '✅', aggressive: '🚀',
    };
    this.logger.log(`[Brain] ${icon[mode] ?? '?'} ${summary}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 2 — Calcolo metriche
  // ══════════════════════════════════════════════════════════════════════════

  private computeMetrics(trades: any[]) {
    const isWin = (t: any) => (t.pnl ?? 0) > 0;
    const wr    = (arr: any[]) => arr.filter(isWin).length / arr.length * 100;

    // Finestre analisi
    const r5  = trades.slice(0, Math.min(5,  trades.length));
    const r10 = trades.slice(0, Math.min(10, trades.length));
    const r20 = trades.slice(0, Math.min(20, trades.length));
    const r30 = trades.slice(0, Math.min(30, trades.length));

    const winRate5  = r5.length  >= 3 ? wr(r5)  : wr(r10);
    const winRate10 = r10.length >= 5 ? wr(r10) : wr(r20);
    const winRate20 = wr(r20);
    const winRate30 = r30.length >= 15 ? wr(r30) : winRate20;

    // Trend: differenza tra finestra breve e media (positivo = in miglioramento)
    const trend = r5.length >= 3 ? winRate5 - winRate20 : 0;

    // Perdite consecutive recenti
    let consecutiveLosses = 0;
    for (const t of trades) {
      if (!isWin(t)) consecutiveLosses++;
      else break;
    }

    // Analisi SL
    const slHits         = r20.filter(t => t.status === 'sl');
    const slHitRate      = slHits.length / r20.length;
    const avgSlPctLosses = slHits.length > 0
      ? slHits.reduce((s: number, t: any) =>
          s + Math.abs(t.stopLoss - t.entry) / t.entry * 100, 0) / slHits.length
      : 0;

    // Score dei vincenti vs perdenti
    const wins20   = r20.filter(isWin);
    const losses20 = r20.filter(t => !isWin(t));
    const avgScoreWins   = wins20.length   > 0 ? wins20.reduce((s: number, t: any)   => s + t.score, 0) / wins20.length   : 60;
    const avgScoreLosses = losses20.length > 0 ? losses20.reduce((s: number, t: any) => s + t.score, 0) / losses20.length : 60;

    // Bias direzionale
    const longs  = r20.filter(t => t.direction === 'LONG');
    const shorts = r20.filter(t => t.direction === 'SHORT');
    const longWR  = longs.length  >= 4 ? wr(longs)  : null;
    const shortWR = shorts.length >= 4 ? wr(shorts) : null;

    // Efficienza fee: % del profitto lordo mangiata dalle fee
    const winsWithFees = wins20.filter((t: any) => t.fees && t.pnl);
    const avgFeeRatio  = winsWithFees.length > 0
      ? winsWithFees.reduce((s: number, t: any) => {
          const gross = Math.abs(t.pnl) + Math.abs(t.fees);
          return s + (gross > 0 ? Math.abs(t.fees) / gross * 100 : 0);
        }, 0) / winsWithFees.length
      : 0;

    // Profit factor
    const totalWinEur  = wins20.reduce((s: number, t: any)   => s + (t.pnl ?? 0), 0);
    const totalLossEur = Math.abs(losses20.reduce((s: number, t: any) => s + (t.pnl ?? 0), 0));
    const profitFactor = totalLossEur > 0 ? totalWinEur / totalLossEur : (totalWinEur > 0 ? 99 : 0);

    // Drawdown dal massimo capitale storico
    const withCapital = trades.filter(t => t.capitalAfter != null);
    let drawdownPct = 0;
    if (withCapital.length >= 2) {
      const peak   = Math.max(...withCapital.map((t: any) => t.capitalAfter as number));
      const latest = withCapital[0].capitalAfter as number;
      drawdownPct  = peak > 0 ? Math.max(0, (peak - latest) / peak * 100) : 0;
    }

    // Volatilità media dei trade (ATR proxy: SL% sui vincenti)
    const avgSlPctWins = wins20.length > 0
      ? wins20.reduce((s: number, t: any) => s + Math.abs(t.stopLoss - t.entry) / t.entry * 100, 0) / wins20.length
      : 0;

    return {
      winRate5, winRate10, winRate20, winRate30, trend,
      consecutiveLosses,
      slHitRate, avgSlPctLosses,
      avgScoreWins, avgScoreLosses,
      longWR, shortWR,
      avgFeeRatio, profitFactor,
      drawdownPct,
      avgSlPctWins,
      window5: r5.length, window10: r10.length, window20: r20.length,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 3 — Determinazione modalità operativa
  // ══════════════════════════════════════════════════════════════════════════

  private determineMode(m: ReturnType<typeof this.computeMetrics>): string {
    const T = MODE_THRESHOLDS;

    // 🛑 PAUSED — emergenza massima: perdite seriali devastanti
    if (m.consecutiveLosses >= T.paused.consec) return 'paused';

    // 🚨 CRISIS — performance critica, rischio capitali
    if (
      m.winRate10 < T.crisis.wr10 ||
      (m.winRate20 < T.crisis.wr20 && m.trend < -10) ||
      m.drawdownPct > T.crisis.drawdown
    ) return 'crisis';

    // ⚠️ CONSERVATIVE — performance sotto la media
    if (
      m.winRate20 < T.conservative.wr20 ||
      m.consecutiveLosses >= T.conservative.consec ||
      m.drawdownPct > T.conservative.drawdown
    ) return 'conservative';

    // 🚀 AGGRESSIVE — eccellenza operativa
    if (
      m.winRate20 >= T.aggressive.wr20 &&
      m.consecutiveLosses === 0 &&
      m.trend >= -5 &&
      m.profitFactor >= T.aggressive.pf
    ) return 'aggressive';

    // ✅ HEALTHY — buone prestazioni
    if (m.winRate20 >= T.healthy.wr20 && m.profitFactor >= T.healthy.pf) return 'healthy';

    // 🔧 NORMAL — operatività standard
    return 'normal';
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FASE 4 — Generazione aggiustamenti
  //
  // Ogni regola ha una priorità. Le regole di emergenza hanno sempre priorità
  // sulle regole di modalità. Il brain applica le N più urgenti per evitare
  // oscillazioni, dove N dipende dalla modalità.
  // ══════════════════════════════════════════════════════════════════════════

  private buildAdjustments(
    m: ReturnType<typeof this.computeMetrics>,
    mode: string,
    p: BrainParams,
  ) {
    type Adj = { param: string; from: any; to: any; reason: string; priority: number };
    const adj: Adj[] = [];
    const clamp = (v: number, k: keyof typeof BOUNDS) =>
      Math.max(BOUNDS[k].min, Math.min(BOUNDS[k].max, +v.toFixed(3)));

    // ── REGOLE DI EMERGENZA (sempre ad alta priorità) ────────────────────

    // [E1] Perdite consecutive gravi: qualità entrata scadente
    if (m.consecutiveLosses >= 5) {
      if (p.enterGrades !== 'A+')
        adj.push({ param: 'enterGrades', from: p.enterGrades, to: 'A+',
          reason: `${m.consecutiveLosses} perdite di fila — solo A+`, priority: 980 });
      const s = clamp(p.minEmitScore + 5, 'minEmitScore');
      if (s > p.minEmitScore)
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: s,
          reason: `${m.consecutiveLosses} perdite di fila — alzare soglia qualità`, priority: 960 });
    }

    // [E2] Drawdown critico: preservare il capitale
    if (m.drawdownPct > 8) {
      if (p.enterGrades !== 'A+')
        adj.push({ param: 'enterGrades', from: p.enterGrades, to: 'A+',
          reason: `Drawdown ${m.drawdownPct.toFixed(1)}% — limitare esposizione`, priority: 920 });
      const s = clamp(p.minEmitScore + 4, 'minEmitScore');
      if (s > p.minEmitScore)
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: s,
          reason: `Drawdown ${m.drawdownPct.toFixed(1)}% — qualità massima`, priority: 900 });
    }

    // [E3] Fee efficiency: fee > 40% del profitto lordo → SL troppo stretto
    if (m.avgFeeRatio > 40) {
      const v = clamp(p.minSlPct + 0.10, 'minSlPct');
      if (v > p.minSlPct)
        adj.push({ param: 'minSlPct', from: p.minSlPct, to: v,
          reason: `Fee ${m.avgFeeRatio.toFixed(0)}% del profitto — allargare SL minimo`, priority: 500 });
    }

    // [E4] SL troppo stretto (hit rate alto, distanza media piccola)
    if (m.slHitRate > 0.55 && m.avgSlPctLosses < 1.0) {
      const inc = m.slHitRate > 0.75 ? 0.35 : 0.20;
      const v   = clamp(p.atrMultSl + inc, 'atrMultSl');
      if (v > p.atrMultSl)
        adj.push({ param: 'atrMultSl', from: p.atrMultSl, to: v,
          reason: `SL hit ${(m.slHitRate * 100).toFixed(0)}% con distanza media ${m.avgSlPctLosses.toFixed(2)}%`, priority: 460 });
    }

    // [E5] Score gap: perdenti sistematicamente sotto i vincenti
    if (m.avgScoreLosses < 60 && (m.avgScoreWins - m.avgScoreLosses) > 8) {
      const v = clamp(p.minEmitScore + 3, 'minEmitScore');
      if (v > p.minEmitScore)
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: v,
          reason: `Score: vincenti ${m.avgScoreWins.toFixed(0)} vs perdenti ${m.avgScoreLosses.toFixed(0)}`, priority: 420 });
    }

    // [E6] Bias direzionale severo: una direzione sistematicamente peggiore
    if (m.longWR !== null && m.shortWR !== null) {
      const gap   = Math.abs(m.longWR - m.shortWR);
      const minWR = Math.min(m.longWR, m.shortWR);
      if (gap > 30 && minWR < 35) {
        const winner = m.longWR > m.shortWR ? 'LONG' : 'SHORT';
        if (p.allowedDirections !== winner)
          adj.push({ param: 'allowedDirections', from: p.allowedDirections, to: winner,
            reason: `Bias direzionale: LONG ${m.longWR.toFixed(0)}% vs SHORT ${m.shortWR.toFixed(0)}% — solo ${winner}`, priority: 380 });
      }
    }

    // ── REGOLE PER MODALITÀ ───────────────────────────────────────────────

    if (mode === 'crisis') {
      if (p.enterGrades !== 'A+')
        adj.push({ param: 'enterGrades', from: p.enterGrades, to: 'A+',
          reason: 'CRISIS: solo trade A+', priority: 850 });
      const v1 = clamp(p.minEmitScore + 5, 'minEmitScore');
      if (v1 > p.minEmitScore)
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: v1,
          reason: 'CRISIS: innalzare soglia qualità', priority: 830 });
      const v2 = clamp(p.minSlPct + 0.10, 'minSlPct');
      if (v2 > p.minSlPct)
        adj.push({ param: 'minSlPct', from: p.minSlPct, to: v2,
          reason: 'CRISIS: SL più largo per ridurre fakeout', priority: 810 });
    }

    if (mode === 'conservative') {
      if (p.enterGrades.includes(','))
        adj.push({ param: 'enterGrades', from: p.enterGrades, to: 'A+',
          reason: 'Conservative: restringere a solo A+', priority: 350 });
      const v = clamp(p.minEmitScore + 2, 'minEmitScore');
      if (v > p.minEmitScore)
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: v,
          reason: 'Conservative: migliorare qualità entrate', priority: 200 });
    }

    if (mode === 'healthy') {
      // Riabilita grade A se solo A+
      if (!p.enterGrades.includes(','))
        adj.push({ param: 'enterGrades', from: p.enterGrades, to: 'A+,A',
          reason: 'Healthy: riabilitare grade A', priority: 180 });
      // Ripristina direzioni se limitate
      if (p.allowedDirections !== 'LONG,SHORT')
        adj.push({ param: 'allowedDirections', from: p.allowedDirections, to: 'LONG,SHORT',
          reason: 'Healthy: ripristino entrambe le direzioni', priority: 160 });
      // Rilassa score se era stato alzato
      if (p.minEmitScore > BRAIN_DEFAULTS.minEmitScore) {
        const v = clamp(p.minEmitScore - 2, 'minEmitScore');
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: v,
          reason: 'Healthy: normalizzare soglia qualità', priority: 120 });
      }
    }

    if (mode === 'aggressive') {
      if (p.enterGrades !== 'A+,A')
        adj.push({ param: 'enterGrades', from: p.enterGrades, to: 'A+,A',
          reason: 'Aggressive: piena operatività A+ e A', priority: 250 });
      if (p.allowedDirections !== 'LONG,SHORT')
        adj.push({ param: 'allowedDirections', from: p.allowedDirections, to: 'LONG,SHORT',
          reason: 'Aggressive: tutte le direzioni abilitate', priority: 230 });
      const vs = clamp(p.minEmitScore - 3, 'minEmitScore');
      if (vs < p.minEmitScore)
        adj.push({ param: 'minEmitScore', from: p.minEmitScore, to: vs,
          reason: 'Aggressive: allargare funnel segnali', priority: 180 });
      // Recupera SL ai default se era stato alzato eccessivamente
      if (p.minSlPct > BRAIN_DEFAULTS.minSlPct + 0.20) {
        const vsl = clamp(p.minSlPct - 0.10, 'minSlPct');
        adj.push({ param: 'minSlPct', from: p.minSlPct, to: vsl,
          reason: 'Aggressive: allentare SL minimo per più opportunità', priority: 150 });
      }
    }

    if (mode === 'normal') {
      // In modalità normale: solo micro-aggiustamenti mirati
      // Trend in recupero → riabilita grade A se era stato limitato
      if (m.trend > 15 && m.winRate5 >= 55 && p.enterGrades === 'A+')
        adj.push({ param: 'enterGrades', from: 'A+', to: 'A+,A',
          reason: `Trend in recupero (+${m.trend.toFixed(0)}%) — riabilitare grade A`, priority: 140 });
      // Ripristina direzioni se bias non è più evidente
      if (p.allowedDirections !== 'LONG,SHORT' &&
          (m.longWR === null || m.shortWR === null || Math.abs((m.longWR ?? 50) - (m.shortWR ?? 50)) < 20))
        adj.push({ param: 'allowedDirections', from: p.allowedDirections, to: 'LONG,SHORT',
          reason: 'Bias direzionale non più evidente — ripristino', priority: 130 });
    }

    return adj;
  }
}
