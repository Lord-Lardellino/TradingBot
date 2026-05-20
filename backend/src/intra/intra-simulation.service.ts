import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import type { IntraSignal } from './intra-scanner.service';

const DEFAULT_TAKER_FEE = 0.00038;

export interface IntraConfigData {
  startingCapital: number;
  marginPerTrade:  number;
  leverage:        number;
  targetTP:        string;
  maxConcurrent:   number;
  autoEnter:       boolean;
  minGrade:        string;
}

@Injectable()
export class IntraSimulationService implements OnModuleInit {
  private readonly logger = new Logger(IntraSimulationService.name);
  private exchange: ccxt.mexc;
  private takerFeePct = DEFAULT_TAKER_FEE;

  constructor(
    private prisma: PrismaService,
    private events: EventsGateway,
    private config: ConfigService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    await this.ensureConfig();
    await this.syncStartingCapital();
  }

  private async ensureConfig() {
    const exists = await this.prisma.intraSimConfig.findUnique({ where: { id: 1 } });
    if (!exists) {
      await this.prisma.intraSimConfig.create({
        data: { id: 1, startingCapital: 1000, marginPerTrade: 10, leverage: 20, targetTP: 'TP2', maxConcurrent: 5, autoEnter: true, minGrade: 'B' },
      });
    }
  }

  async syncStartingCapital(force = false) {
    try {
      const tradeCount = await this.prisma.intraSimulatedTrade.count();
      if (tradeCount > 0 && !force) return;

      const balance = await this.exchange.fetchBalance({ type: 'swap' });
      const usdt = balance?.USDT?.free ?? balance?.['USDT']?.free ?? 0;
      if (usdt > 0) {
        await this.prisma.intraSimConfig.upsert({
          where:  { id: 1 },
          create: { id: 1, startingCapital: usdt, marginPerTrade: 10, leverage: 20, targetTP: 'TP2', maxConcurrent: 5, autoEnter: true, minGrade: 'B' },
          update: { startingCapital: usdt },
        });
        this.logger.log(`[INTRA-SIM] Capitale sincronizzato da MEXC futures: $${usdt.toFixed(2)} USDT`);
      }
    } catch (e: any) {
      this.logger.warn(`[INTRA-SIM] fetchBalance fallito, startingCapital invariato: ${e?.message}`);
    }
  }

  async getConfig(): Promise<IntraConfigData> {
    let cfg = await this.prisma.intraSimConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.intraSimConfig.create({
        data: { id: 1, startingCapital: 1000, marginPerTrade: 10, leverage: 20, targetTP: 'TP2', maxConcurrent: 5, autoEnter: true, minGrade: 'B' },
      });
    }
    return {
      startingCapital: cfg.startingCapital,
      marginPerTrade:  cfg.marginPerTrade,
      leverage:        (cfg as any).leverage ?? 20,
      targetTP:        cfg.targetTP,
      maxConcurrent:   cfg.maxConcurrent,
      autoEnter:       cfg.autoEnter,
      minGrade:        cfg.minGrade,
    };
  }

  async updateConfig(data: Partial<IntraConfigData>) {
    return this.prisma.intraSimConfig.upsert({
      where:  { id: 1 },
      create: { id: 1, startingCapital: 1000, marginPerTrade: 10, leverage: 20, targetTP: 'TP2', maxConcurrent: 5, autoEnter: true, minGrade: 'B', ...data } as any,
      update: data,
    });
  }

  private async currentCapital(): Promise<number> {
    const cfg    = await this.getConfig();
    const closed = await this.prisma.intraSimulatedTrade.findMany({ where: { status: { not: 'open' } } });
    return closed.reduce((cap, t) => cap + (t.pnl ?? 0), cfg.startingCapital);
  }

  // ─── Enter trade — leverage from config, liqPrice replaces SL ────────────

  async enterTrade(signal: IntraSignal) {
    const cfg = await this.getConfig();
    if (!cfg.autoEnter) return;

    const gradeOrder = ['A+', 'A', 'B', 'C'];
    const minIdx = gradeOrder.indexOf(cfg.minGrade);
    const sigIdx = gradeOrder.indexOf(signal.grade);
    if (sigIdx > minIdx) return;

    const openCount = await this.prisma.intraSimulatedTrade.count({ where: { status: 'open' } });
    if (openCount >= cfg.maxConcurrent) return;

    const already = await this.prisma.intraSimulatedTrade.findFirst({
      where: { symbol: signal.symbol, status: 'open' },
    });
    if (already) return;

    const capital      = await this.currentCapital();
    const marginEur    = cfg.marginPerTrade;
    const leverage     = cfg.leverage;
    const positionSize = marginEur * leverage;
    const fees         = positionSize * this.takerFeePct * 2;

    // No SL — liquidation price is where full margin is wiped
    // LONG: price drops by 1/leverage → margin = 0
    const liqPrice = signal.entry * (1 - 1 / leverage);

    // TP based on margin multiples: price must rise by N/leverage for N× margin return
    const tp1 = signal.entry * (1 + 2  / leverage);
    const tp2 = signal.entry * (1 + 5  / leverage);
    const tp3 = signal.entry * (1 + 10 / leverage);

    const targetPrice = cfg.targetTP === 'TP3' ? tp3 : cfg.targetTP === 'TP2' ? tp2 : tp1;

    const trade = await this.prisma.intraSimulatedTrade.create({
      data: {
        id:           `intra_${signal.symbol}_${Date.now()}`,
        symbol:       signal.symbol,
        direction:    'LONG',
        entry:        signal.entry,
        stopLoss:     parseFloat(liqPrice.toPrecision(8)),   // liqPrice stored as stopLoss
        takeProfit1:  parseFloat(tp1.toPrecision(8)),
        takeProfit2:  parseFloat(tp2.toPrecision(8)),
        takeProfit3:  parseFloat(tp3.toPrecision(8)),
        leverage:     leverage,
        slPct:        parseFloat((1 / leverage * 100).toFixed(3)), // % drop to liquidation
        marginEur:    parseFloat(marginEur.toFixed(4)),
        positionSize: parseFloat(positionSize.toFixed(4)),
        riskEur:      parseFloat(marginEur.toFixed(4)),       // max loss = full margin
        grade:        signal.grade,
        score:        signal.score,
        pumpPct:      signal.pumpCandle4hPct,
        distToEma34:  signal.distToEma34,
        targetTP:     cfg.targetTP,
        fees:         parseFloat(fees.toFixed(4)),
        capitalBefore: parseFloat(capital.toFixed(4)),
        status:       'open',
      },
    });

    this.events.emitIntraTrade(trade);
    this.logger.log(
      `[INTRA-SIM] Entered ${signal.symbol} ${signal.grade} | lev ${leverage}× | margin €${marginEur} | pump ${signal.pumpCandle4hPct.toFixed(1)}% | liq ${liqPrice.toPrecision(6)}`,
    );
  }

  // ─── Monitor positions every 30s — close on TP or liquidation ────────────

  @Cron('*/30 * * * * *')
  async checkOpenPositions() {
    const openTrades = await this.prisma.intraSimulatedTrade.findMany({ where: { status: 'open' } });
    if (!openTrades.length) return;

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

        const tp = trade.targetTP === 'TP3' ? trade.takeProfit3
                 : trade.targetTP === 'TP2' ? trade.takeProfit2
                 : trade.takeProfit1;

        // Liquidation: price dropped to liq level (stopLoss field = liqPrice)
        if (currentPrice <= trade.stopLoss) {
          await this.closeTrade(trade, trade.stopLoss, 'liq');
          continue;
        }
        // TP hit
        if (currentPrice >= tp) {
          await this.closeTrade(trade, tp, trade.targetTP.toLowerCase());
          continue;
        }

        // Still open — unrealized PnL
        const priceDiff       = (currentPrice - trade.entry) / trade.entry;
        const unrealizedPnl   = trade.positionSize * priceDiff - trade.fees;
        const unrealizedPnlPct = (unrealizedPnl / trade.capitalBefore) * 100;

        updates.push({
          id:               trade.id,
          currentPrice:     parseFloat(currentPrice.toPrecision(8)),
          unrealizedPnl:    parseFloat(unrealizedPnl.toFixed(4)),
          unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(3)),
        });
      } catch { /* skip */ }
    }

    if (updates.length) this.events.emitIntraPositions(updates);
  }

  private async closeTrade(trade: any, closePrice: number, status: string) {
    const priceDiff   = (closePrice - trade.entry) / trade.entry;
    const grossPnl    = trade.positionSize * priceDiff;
    const pnl         = grossPnl - trade.fees;
    const pnlCapPct   = (pnl / trade.capitalBefore) * 100;
    const capitalAfter = trade.capitalBefore + pnl;

    await this.prisma.intraSimulatedTrade.update({
      where: { id: trade.id },
      data: {
        status,
        closePrice:   parseFloat(closePrice.toFixed(8)),
        pnl:          parseFloat(pnl.toFixed(4)),
        pnlCapPct:    parseFloat(pnlCapPct.toFixed(3)),
        capitalAfter: parseFloat(capitalAfter.toFixed(4)),
        closedAt:     new Date(),
      },
    });

    const icon = status.startsWith('tp') ? '✅' : status === 'liq' ? '💥' : '❌';
    this.logger.log(
      `[INTRA-SIM] ${icon} ${trade.symbol} @ ${status.toUpperCase()} | PnL €${pnl.toFixed(2)} (${pnlCapPct.toFixed(2)}% cap)`,
    );

    this.events.emitIntraTrade({ ...trade, closePrice, status, pnl, pnlCapPct, capitalAfter });
  }

  async getAnalytics() {
    const cfg    = await this.getConfig();
    const closed = await this.prisma.intraSimulatedTrade.findMany({
      where:   { status: { not: 'open' } },
      orderBy: { closedAt: 'asc' },
    });
    const open = await this.prisma.intraSimulatedTrade.findMany({ where: { status: 'open' } });

    const capital     = await this.currentCapital();
    const totalFees   = closed.reduce((s, t) => s + (t.fees ?? 0), 0);
    const totalPnl    = capital - cfg.startingCapital;
    const totalPnlPct = (totalPnl / cfg.startingCapital) * 100;

    const wins   = closed.filter((t) => (t.pnl ?? 0) > 0);
    const losses = closed.filter((t) => (t.pnl ?? 0) <= 0);
    const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;

    const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + (t.pnl ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnl ?? 0), 0) / losses.length : 0;

    const totalW = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalL = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
    const pf     = totalL > 0 ? totalW / totalL : totalW > 0 ? 999 : 0;

    let peak = cfg.startingCapital, maxDD = 0, runCap = cfg.startingCapital;
    const equityCurve: { date: string; capital: number }[] = [
      { date: new Date(Date.now() - 86400000).toISOString(), capital: cfg.startingCapital },
    ];
    for (const t of closed) {
      runCap += (t.pnl ?? 0);
      if (runCap > peak) peak = runCap;
      const dd = ((peak - runCap) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      equityCurve.push({ date: (t.closedAt ?? new Date()).toISOString(), capital: parseFloat(runCap.toFixed(4)) });
    }

    return {
      startingCapital: cfg.startingCapital,
      currentCapital:  parseFloat(capital.toFixed(4)),
      totalPnl:        parseFloat(totalPnl.toFixed(4)),
      totalPnlPct:     parseFloat(totalPnlPct.toFixed(2)),
      totalFeesPaid:   parseFloat(totalFees.toFixed(4)),
      totalTrades:     closed.length,
      openTrades:      open.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         parseFloat(winRate.toFixed(1)),
      avgWinEur:       parseFloat(avgWin.toFixed(4)),
      avgLossEur:      parseFloat(avgLoss.toFixed(4)),
      profitFactor:    parseFloat(Math.min(pf, 999).toFixed(2)),
      maxDrawdownPct:  parseFloat(maxDD.toFixed(2)),
      equityCurve,
      config: cfg,
    };
  }

  async getTrades(limit = 100) {
    return this.prisma.intraSimulatedTrade.findMany({
      orderBy: { openedAt: 'desc' },
      take:    limit,
    });
  }

  async resetSimulation() {
    await this.prisma.intraSimulatedTrade.deleteMany();
    await this.syncStartingCapital(true);
    this.logger.log('[INTRA-SIM] Simulation reset');
  }

  async closeManual(id: string) {
    const trade = await this.prisma.intraSimulatedTrade.findUnique({ where: { id } });
    if (!trade || trade.status !== 'open') return;
    const ticker = await this.exchange.fetchTicker(trade.symbol);
    await this.closeTrade(trade, ticker.last, 'manual');
  }
}
