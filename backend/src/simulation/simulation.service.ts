import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import type { ScannerSignal } from '../scanner/scanner.service';
import { AiBrainService } from '../ai-brain/ai-brain.service';

const DEFAULT_TAKER_FEE = 0.00038; // 0.038% per leg — media effettiva account (maker+taker mix)

export interface SimAnalytics {
  startingCapital: number;
  currentCapital: number;
  totalPnl: number;
  totalPnlPct: number;
  totalGrossPnl: number;
  totalFeesPaid: number;
  feeRatePct: number;
  totalTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinEur: number;
  avgLossEur: number;
  profitFactor: number;
  maxDrawdownPct: number;
  bestTrade: any;
  worstTrade: any;
  byGrade: Record<string, { trades: number; wins: number; pnl: number; winRate: number }>;
  equityCurve: { date: string; capital: number }[];
  config: SimConfigData;
}

export interface SimConfigData {
  startingCapital: number;
  marginPerTrade: number;   // fixed USD margin per trade (e.g. $10)
  targetTP: string;
  maxConcurrent: number;
  autoEnter: boolean;
}

@Injectable()
export class SimulationService implements OnModuleInit {
  private readonly logger = new Logger(SimulationService.name);
  private exchange: ccxt.mexc;
  private takerFeePct = DEFAULT_TAKER_FEE; // aggiornato da loadActualFeeRate()

  constructor(
    private prisma: PrismaService,
    private events: EventsGateway,
    private config: ConfigService,
    private brain: AiBrainService,
  ) {}

  async onModuleInit() {
    // Exchange autenticato — SOLO per leggere fee reali e saldo futures. Nessun ordine.
    this.exchange = new ccxt.mexc({
      apiKey:        this.config.get<string>('MEXC_API_KEY'),
      secret:        this.config.get<string>('MEXC_API_SECRET'),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await Promise.all([this.loadActualFeeRate(), this.syncStartingCapital()]);
  }

  // Legge taker fee dall'account MEXC tramite fetchMyTrades o market info.
  // ccxt MEXC non supporta fetchTradingFees() — usiamo loadMarkets() che contiene
  // le fee statiche per tier, poi verifichiamo via privateGet se disponibile.
  private async loadActualFeeRate() {
    try {
      // Prova a leggere le fee dal profilo account via endpoint privato MEXC
      // /api/v3/account restituisce "makerCommission" e "takerCommission" (in basis points × 0.0001)
      const account = await (this.exchange as any).privateGetAccount?.() ?? null;
      if (account?.takerCommission != null) {
        // MEXC restituisce in basis points (es. 5 = 0.05%)
        this.takerFeePct = account.takerCommission / 10000;
        this.logger.log(
          `[SIM] Fee account MEXC (privato): taker=${(this.takerFeePct * 100).toFixed(4)}% maker=${(account.makerCommission / 10000 * 100).toFixed(4)}% | round-trip=${(this.takerFeePct * 200).toFixed(4)}%`,
        );
        return;
      }
    } catch { /* endpoint non disponibile — continua con fallback */ }

    // Fallback: fee confermate dallo screenshot account (MEXC futures standard tier)
    this.takerFeePct = DEFAULT_TAKER_FEE;
    this.logger.log(
      `[SIM] Fee MEXC (standard tier confermato): taker=${(DEFAULT_TAKER_FEE * 100).toFixed(3)}% | round-trip=${(DEFAULT_TAKER_FEE * 200).toFixed(3)}%`,
    );
  }

  // Legge il saldo USDT disponibile nel wallet futures e aggiorna startingCapital
  // Solo se la simulazione è vuota (nessun trade chiuso) o dopo un reset.
  async syncStartingCapital(force = false) {
    try {
      const tradeCount = await this.prisma.simulatedTrade.count();
      if (tradeCount > 0 && !force) return; // non alterare simulazione già avviata

      const balance = await this.exchange.fetchBalance({ type: 'swap' });
      const usdt = balance?.USDT?.free ?? balance?.['USDT']?.free ?? 0;
      if (usdt > 0) {
        await this.prisma.simConfig.upsert({
          where:  { id: 1 },
          create: { id: 1, startingCapital: usdt, marginPerTrade: 10, targetTP: 'TP2', maxConcurrent: 3, autoEnter: true },
          update: { startingCapital: usdt },
        });
        this.logger.log(`[SIM] Saldo futures MEXC sincronizzato: $${usdt.toFixed(2)} USDT`);
      }
    } catch (e) {
      this.logger.warn(`[SIM] fetchBalance fallito, startingCapital invariato: ${e?.message}`);
    }
  }

  // ─── Configurazione ───────────────────────────────────────────────────────

  async getConfig(): Promise<SimConfigData> {
    let cfg = await this.prisma.simConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.simConfig.create({
        data: { id: 1, startingCapital: 1000, marginPerTrade: 10, targetTP: 'TP2', maxConcurrent: 3, autoEnter: true },
      });
    }
    return {
      startingCapital: cfg.startingCapital,
      marginPerTrade:  cfg.marginPerTrade,
      targetTP:        cfg.targetTP,
      maxConcurrent:   cfg.maxConcurrent,
      autoEnter:       cfg.autoEnter,
    };
  }

  async updateConfig(data: Partial<SimConfigData>) {
    return this.prisma.simConfig.upsert({
      where:  { id: 1 },
      create: { id: 1, startingCapital: 1000, marginPerTrade: 10, targetTP: 'TP2', maxConcurrent: 3, autoEnter: true, ...data } as any,
      update: data,
    });
  }

  // ─── Capitale corrente ────────────────────────────────────────────────────

  private async currentCapital(): Promise<number> {
    const cfg = await this.getConfig();
    const closed = await this.prisma.simulatedTrade.findMany({ where: { status: { not: 'open' } } });
    // pnl è già NETTO (grossPnl - fees) — non sottrarre fees di nuovo
    return closed.reduce((cap, t) => cap + (t.pnl ?? 0), cfg.startingCapital);
  }

  // ─── Entra in un trade simulato quando il scanner emette un segnale ───────

  async getOpenSymbols(): Promise<Set<string>> {
    const open = await this.prisma.simulatedTrade.findMany({
      where:  { status: 'open' },
      select: { symbol: true },
    });
    return new Set(open.map((t) => t.symbol));
  }

  async enterTrade(signal: ScannerSignal) {
    const cfg = await this.getConfig();
    if (!cfg.autoEnter) return;

    // Grade ammessi — determinati dal brain (default A+,A; in crisi solo A+)
    const brainParams = await this.brain.getParams();
    const allowedGrades = brainParams.enterGrades.split(',').map((s) => s.trim());
    if (!allowedGrades.includes(signal.grade)) return;

    // Max concurrent trades check
    const openCount = await this.prisma.simulatedTrade.count({ where: { status: 'open' } });
    if (openCount >= cfg.maxConcurrent) return;

    // Non entrare sulla stessa coppia già aperta
    const already = await this.prisma.simulatedTrade.findFirst({
      where: { symbol: signal.symbol, status: 'open' },
    });
    if (already) return;

    const capital      = await this.currentCapital();
    const marginEur    = cfg.marginPerTrade;                          // fixed $10 margin
    const positionSize = marginEur * signal.suggestedLeverage;        // leveraged position
    const riskEur      = positionSize * (signal.slPct / 100);         // actual $ at risk
    const fees         = positionSize * this.takerFeePct * 2;         // round-trip fees

    const targetTP = cfg.targetTP === 'TP2' ? signal.takeProfit2 : signal.takeProfit1;
    const tpPct    = cfg.targetTP === 'TP2' ? signal.tp2Pct       : signal.tp1Pct;

    const trade = await this.prisma.simulatedTrade.create({
      data: {
        id:           `${signal.symbol}_${Date.now()}`,
        symbol:       signal.symbol,
        direction:    signal.direction,
        entry:        signal.entry,
        stopLoss:     signal.stopLoss,
        takeProfit1:  signal.takeProfit1,
        takeProfit2:  signal.takeProfit2,
        leverage:     signal.suggestedLeverage,
        riskEur:      parseFloat(riskEur.toFixed(4)),
        positionSize: parseFloat(positionSize.toFixed(4)),
        marginEur:    parseFloat(marginEur.toFixed(4)),
        grade:        signal.grade,
        score:        signal.score,
        targetTP:     cfg.targetTP,
        fees:         parseFloat(fees.toFixed(4)),
        capitalBefore: parseFloat(capital.toFixed(4)),
        status:       'open',
      },
    });

    // Notify frontend immediately so open trade appears in the UI
    this.events.emitSimTrade(trade);

    this.logger.log(
      `[SIM] Entered ${signal.direction} ${signal.symbol} | risk €${riskEur.toFixed(2)} | sz €${positionSize.toFixed(2)} | leva ${signal.suggestedLeverage}× | grade ${signal.grade}`,
    );
  }

  // ─── Controlla le posizioni aperte ogni 3s via ticker batch ─────────────────
  // Una singola chiamata fetchTickers([...symbols]) anziché N chiamate OHLCV
  // separate: latenza ~200ms totali invece di N×(300ms+200ms).
  // Il prezzo "last" del ticker è il tick più recente — rilevamento SL/TP accurato.

  @Cron('*/2 * * * * *')
  async checkOpenPositions() {
    const openTrades = await this.prisma.simulatedTrade.findMany({ where: { status: 'open' } });
    if (!openTrades.length) return;

    // Batch fetch: una sola chiamata per tutti i simboli aperti
    let tickers: Record<string, ccxt.Ticker>;
    try {
      tickers = await this.exchange.fetchTickers(openTrades.map((t) => t.symbol));
    } catch { return; }

    const updates: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[] = [];

    for (const trade of openTrades) {
      try {
        const ticker = tickers[trade.symbol];
        if (!ticker?.last) continue;

        const currentPrice = ticker.last;
        const isLong       = trade.direction === 'LONG';
        const tp           = trade.targetTP === 'TP2' ? trade.takeProfit2 : trade.takeProfit1;

        // SL / TP check sul prezzo live
        if (isLong) {
          if (currentPrice <= trade.stopLoss) { await this.closeTrade(trade, trade.stopLoss, 'sl'); continue; }
          if (currentPrice >= tp)             { await this.closeTrade(trade, tp, trade.targetTP === 'TP2' ? 'tp2' : 'tp1'); continue; }
        } else {
          if (currentPrice >= trade.stopLoss) { await this.closeTrade(trade, trade.stopLoss, 'sl'); continue; }
          if (currentPrice <= tp)             { await this.closeTrade(trade, tp, trade.targetTP === 'TP2' ? 'tp2' : 'tp1'); continue; }
        }

        // Ancora aperto — PnL non realizzato
        const priceDiff       = isLong
          ? (currentPrice - trade.entry) / trade.entry
          : (trade.entry - currentPrice) / trade.entry;
        const unrealizedPnl    = trade.positionSize * priceDiff - trade.fees;
        const unrealizedPnlPct = (unrealizedPnl / trade.capitalBefore) * 100;

        updates.push({
          id:               trade.id,
          currentPrice:     parseFloat(currentPrice.toPrecision(8)),
          unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(4)),
          unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
        });
      } catch { /* ticker non disponibile per questo simbolo */ }
    }

    if (updates.length) this.events.emitSimPositions(updates);
  }

  private async closeTrade(trade: any, closePrice: number, status: string) {
    const isLong = trade.direction === 'LONG';
    const priceDiff = isLong
      ? (closePrice - trade.entry) / trade.entry
      : (trade.entry - closePrice) / trade.entry;

    const grossPnl  = trade.positionSize * priceDiff;
    const pnl       = grossPnl - trade.fees;
    const capital   = trade.capitalBefore;
    const pnlCapPct = (pnl / capital) * 100;
    const capitalAfter = capital + pnl;

    await this.prisma.simulatedTrade.update({
      where: { id: trade.id },
      data: {
        status,
        closePrice: parseFloat(closePrice.toFixed(8)),
        pnl:        parseFloat(pnl.toFixed(4)),
        pnlCapPct:  parseFloat(pnlCapPct.toFixed(3)),
        capitalAfter: parseFloat(capitalAfter.toFixed(4)),
        closedAt:   new Date(),
      },
    });

    const icon = status.startsWith('tp') ? '✅' : status === 'timeout' ? '⏱️' : '❌';
    this.logger.log(
      `[SIM] ${icon} Close ${trade.direction} ${trade.symbol} @ ${status.toUpperCase()} | PnL €${pnl.toFixed(2)} (${pnlCapPct.toFixed(2)}%) | cap €${capitalAfter.toFixed(2)}`,
    );

    this.events.emitSimTrade({
      ...trade, closePrice, status, pnl, pnlCapPct, capitalAfter,
    });
  }

  // ─── Analytics complete ───────────────────────────────────────────────────

  async getAnalytics(): Promise<SimAnalytics> {
    const cfg    = await this.getConfig();
    const closed = await this.prisma.simulatedTrade.findMany({
      where:   { status: { not: 'open' } },
      orderBy: { closedAt: 'asc' },
    });
    const open = await this.prisma.simulatedTrade.findMany({ where: { status: 'open' } });

    const capital = await this.currentCapital();
    const totalNetPnl   = closed.reduce((s, t) => s + (t.pnl  ?? 0), 0);
    const totalFeesPaid = closed.reduce((s, t) => s + (t.fees ?? 0), 0);
    const totalGrossPnl = totalNetPnl + totalFeesPaid;

    const totalPnl    = capital - cfg.startingCapital;
    const totalPnlPct = (totalPnl / cfg.startingCapital) * 100;

    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const avgWinEur  = wins.length   > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length   : 0;
    const avgLossEur = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0) / losses.length : 0;

    const totalWins   = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalLosses = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;

    // Max drawdown
    let peak = cfg.startingCapital;
    let maxDD = 0;
    let runCap = cfg.startingCapital;
    const equityCurve: { date: string; capital: number }[] = [
      { date: new Date(Date.now() - 86400000).toISOString(), capital: cfg.startingCapital },
    ];
    for (const t of closed) {
      runCap += (t.pnl ?? 0); // pnl è già netto
      if (runCap > peak) peak = runCap;
      const dd = ((peak - runCap) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      equityCurve.push({ date: (t.closedAt ?? new Date()).toISOString(), capital: parseFloat(runCap.toFixed(4)) });
    }

    // By grade
    const byGrade: Record<string, any> = {};
    for (const t of closed) {
      if (!byGrade[t.grade]) byGrade[t.grade] = { trades: 0, wins: 0, pnl: 0, winRate: 0 };
      byGrade[t.grade].trades++;
      byGrade[t.grade].pnl += t.pnl ?? 0;
      if ((t.pnl ?? 0) > 0) byGrade[t.grade].wins++;
    }
    Object.keys(byGrade).forEach((g) => {
      byGrade[g].winRate = byGrade[g].trades > 0 ? (byGrade[g].wins / byGrade[g].trades) * 100 : 0;
      byGrade[g].pnl = parseFloat(byGrade[g].pnl.toFixed(4));
    });

    const sortedClosed = [...closed].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));

    return {
      startingCapital: cfg.startingCapital,
      currentCapital:  parseFloat(capital.toFixed(4)),
      totalPnl:        parseFloat(totalPnl.toFixed(4)),
      totalPnlPct:     parseFloat(totalPnlPct.toFixed(2)),
      totalGrossPnl:   parseFloat(totalGrossPnl.toFixed(4)),
      totalFeesPaid:   parseFloat(totalFeesPaid.toFixed(4)),
      feeRatePct:      parseFloat((this.takerFeePct * 200).toFixed(4)), // taker%×2 legs = round-trip%
      totalTrades:     closed.length,
      openTrades:      open.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         parseFloat(winRate.toFixed(1)),
      avgWinEur:       parseFloat(avgWinEur.toFixed(4)),
      avgLossEur:      parseFloat(avgLossEur.toFixed(4)),
      profitFactor:    parseFloat(Math.min(profitFactor, 999).toFixed(2)),
      maxDrawdownPct:  parseFloat(maxDD.toFixed(2)),
      bestTrade:       sortedClosed[0] ?? null,
      worstTrade:      sortedClosed[sortedClosed.length - 1] ?? null,
      byGrade,
      equityCurve,
      config: cfg,
    };
  }

  async getTrades(limit = 100) {
    return this.prisma.simulatedTrade.findMany({
      orderBy: { openedAt: 'desc' },
      take:    limit,
    });
  }

  async resetSimulation() {
    await this.prisma.simulatedTrade.deleteMany();
    // Dopo reset risincronizza il capitale con il saldo futures reale
    await this.syncStartingCapital(true);
    this.logger.log('[SIM] Simulation reset');
  }

  async closeManual(id: string) {
    const trade = await this.prisma.simulatedTrade.findUnique({ where: { id } });
    if (!trade || trade.status !== 'open') return;
    const ticker = await this.exchange.fetchTicker(trade.symbol);
    await this.closeTrade(trade, ticker.last, 'manual');
  }
}
