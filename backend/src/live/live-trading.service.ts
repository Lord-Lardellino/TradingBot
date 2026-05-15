import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
import type { ScannerSignal } from '../scanner/scanner.service';

export interface LiveConfigData {
  enabled:        boolean;
  autoClose:      boolean;
  marginPerTrade: number;
  minGrade:       string;
  maxConcurrent:  number;
}

@Injectable()
export class LiveTradingService implements OnModuleInit {
  private readonly logger = new Logger(LiveTradingService.name);
  private exchange: ccxt.mexc;
  private markets: Record<string, any> = {};

  constructor(
    private prisma: PrismaService,
    private events: EventsGateway,
    private config: ConfigService,
  ) {}

  async onModuleInit() {
    this.exchange = new ccxt.mexc({
      apiKey:          this.config.get<string>('MEXC_API_KEY'),
      secret:          this.config.get<string>('MEXC_API_SECRET'),
      enableRateLimit: true,
      options:         { defaultType: 'swap' },
    });
    await this.ensureConfig();
    try {
      this.markets = await this.exchange.loadMarkets();
      this.logger.log(`[LIVE] Markets loaded: ${Object.keys(this.markets).length}`);
    } catch (e: any) {
      this.logger.warn(`[LIVE] Could not load markets: ${e?.message}`);
    }
  }

  private async ensureConfig() {
    const exists = await this.prisma.liveConfig.findUnique({ where: { id: 1 } });
    if (!exists) {
      await this.prisma.liveConfig.create({
        data: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2 },
      });
    }
  }

  async getConfig(): Promise<LiveConfigData> {
    let cfg = await this.prisma.liveConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.liveConfig.create({
        data: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2 },
      });
    }
    return {
      enabled:        cfg.enabled,
      autoClose:      cfg.autoClose,
      marginPerTrade: cfg.marginPerTrade,
      minGrade:       cfg.minGrade,
      maxConcurrent:  cfg.maxConcurrent,
    };
  }

  async updateConfig(data: Partial<LiveConfigData>) {
    return this.prisma.liveConfig.upsert({
      where:  { id: 1 },
      create: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2, ...data } as any,
      update: data,
    });
  }

  // ─── Entry ────────────────────────────────────────────────────────────────────

  async enterTrade(signal: ScannerSignal): Promise<void> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return;

    const gradeOrder = ['A+', 'A', 'B', 'C'];
    if (gradeOrder.indexOf(signal.grade) > gradeOrder.indexOf(cfg.minGrade)) return;

    const openCount = await this.prisma.liveTrade.count({ where: { status: 'open' } });
    if (openCount >= cfg.maxConcurrent) return;

    const already = await this.prisma.liveTrade.findFirst({
      where: { symbol: signal.symbol, status: 'open' },
    });
    if (already) return;

    const id = `live_${signal.symbol}_${Date.now()}`;
    try {
      const market       = this.markets[signal.symbol];
      const leverage     = signal.suggestedLeverage;
      const margin       = cfg.marginPerTrade;
      const notional     = margin * leverage;
      const price        = signal.entry;
      const contractSize = market?.contractSize ?? 1;

      let amount = notional / (price * contractSize);

      const minAmount = market?.limits?.amount?.min ?? 0;
      if (minAmount > 0 && amount < minAmount) {
        this.logger.warn(`[LIVE] ${signal.symbol}: amount ${amount.toFixed(6)} < min ${minAmount} — skip`);
        return;
      }
      amount = parseFloat(this.exchange.amountToPrecision(signal.symbol, amount));

      // Setup margine e leva in parallelo per ridurre latenza
      await Promise.allSettled([
        this.exchange.setMarginMode('isolated', signal.symbol),
        this.exchange.setLeverage(leverage, signal.symbol),
      ]);

      const side  = signal.direction === 'LONG' ? 'buy' : 'sell';
      const order = await this.exchange.createOrder(signal.symbol, 'market', side, amount);

      // Fill reale da MEXC (dealAvgPrice > average > price > signal.entry come fallback)
      const filled = Number(
        order.info?.dealAvgPrice ?? order.average ?? order.price ?? price,
      );
      const realNotional = amount * contractSize * filled;
      const feesEst      = realNotional * 0.00038;
      const actualFee = Number(order.fee?.cost ?? feesEst);
      const rawOrderId = order.info?.orderId ?? order.info?.order_id ?? order.id;
      const orderId   = typeof rawOrderId === 'number' ? String(rawOrderId) : (typeof rawOrderId === 'string' ? rawOrderId : '');

      // ── SL/TP aggiustati al fill reale usando le % già calcolate dal scanner ──
      const isLong = signal.direction === 'LONG';
      const slFrac = signal.slPct  / 100;   // es. 0.64% → 0.0064
      const tpFrac = signal.tp1Pct / 100;   // es. 1.15% → 0.0115
      const adjSL  = isLong ? filled * (1 - slFrac) : filled * (1 + slFrac);
      const adjTP  = isLong ? filled * (1 + tpFrac) : filled * (1 - tpFrac);

      const slPrice    = parseFloat(this.exchange.priceToPrecision(signal.symbol, adjSL));
      const tpPrice    = parseFloat(this.exchange.priceToPrecision(signal.symbol, adjTP));
      const mexcSymbol = this.markets[signal.symbol]?.id ?? signal.symbol.split('/')[0] + '_USDT';

      let slOrderId: string | undefined;
      let tpOrderId: string | undefined;

      try {
        // Fetch position per ottenere positionId (richiesto da MEXC stoporder/place)
        await new Promise(r => setTimeout(r, 600)); // breve attesa affinché la posizione sia registrata
        const positions = await this.exchange.fetchPositions([signal.symbol]);
        const newPos = positions.find(p =>
          p.symbol === signal.symbol &&
          Math.abs(Number(p.contracts ?? 0)) > 0 &&
          (signal.direction === 'LONG' ? p.side === 'long' : p.side === 'short'),
        );

        if (newPos) {
          const positionId = newPos.info?.positionId;
          const posVol     = Math.abs(Number(newPos.contracts ?? 0));
          const res: any   = await (this.exchange as any).contractPrivatePostStoporderPlace({
            symbol:          mexcSymbol,
            positionId,
            vol:             posVol,
            stopLossPrice:   slPrice,
            takeProfitPrice: tpPrice,
          });
          slOrderId = String(res?.data ?? '');
          tpOrderId = slOrderId; // MEXC usa un unico stopOrderId per la coppia SL+TP
          this.logger.log(`[LIVE] ✅ SL/TP set: SL @ ${slPrice} | TP @ ${tpPrice} | stopOrderId: ${slOrderId}`);
        } else {
          this.logger.warn(`[LIVE] Position not found after open for ${signal.symbol} — SL/TP not set`);
        }
      } catch (e: any) {
        this.logger.warn(`[LIVE] SL/TP failed ${signal.symbol}: ${e?.message?.slice(0, 150)}`);
      }

      const trade = await this.prisma.liveTrade.create({
        data: {
          id,
          symbol:       signal.symbol,
          direction:    signal.direction,
          entry:        parseFloat(filled.toFixed(8)),
          stopLoss:     slPrice,
          takeProfit:   tpPrice,
          leverage,
          marginEur:    parseFloat(margin.toFixed(4)),
          positionSize: parseFloat(realNotional.toFixed(4)),
          contracts:    parseFloat(amount.toFixed(8)),
          orderId,
          slOrderId,
          tpOrderId,
          grade:        signal.grade,
          score:        signal.score,
          feesOpen:     parseFloat(actualFee.toFixed(6)),
          status:       'open',
        },
      });

      this.logger.log(
        `[LIVE] ✅ ${signal.direction} ${signal.symbol} | ${amount} contracts @ ${filled} | SL ${slPrice} | TP ${tpPrice} | notional $${realNotional.toFixed(2)} | fee $${actualFee.toFixed(4)}`,
      );
      this.events.emitLiveTrade(trade);

    } catch (e: any) {
      this.logger.error(`[LIVE] Order failed ${signal.symbol}: ${e?.message}`);
      await this.prisma.liveTrade.create({
        data: {
          id,
          symbol:       signal.symbol,
          direction:    signal.direction,
          entry:        signal.entry,
          stopLoss:     signal.stopLoss,
          takeProfit:   signal.takeProfit1,
          leverage:     signal.suggestedLeverage,
          marginEur:    cfg.marginPerTrade,
          positionSize: cfg.marginPerTrade * signal.suggestedLeverage,
          contracts:    0,
          grade:        signal.grade,
          score:        signal.score,
          status:       'error',
          note:         e?.message?.slice(0, 200),
        },
      });
    }
  }

  // ─── Reconciliation ogni 10s ─────────────────────────────────────────────────
  // Rileva chiusure native (SL/TP exchange) o esterne e aggiorna il DB

  @Cron('*/10 * * * * *')
  async checkOpenPositions() {
    const openTrades = await this.prisma.liveTrade.findMany({ where: { status: 'open' } });
    if (!openTrades.length) return;

    // Fetch posizioni reali su MEXC
    let mexcPositions: any[];
    try {
      mexcPositions = await this.exchange.fetchPositions(openTrades.map(t => t.symbol));
    } catch { return; }

    for (const trade of openTrades) {
      const mexcPos = mexcPositions.find(
        p => p.symbol === trade.symbol && Math.abs(Number(p.contracts ?? 0)) > 0,
      );
      if (mexcPos) continue; // posizione ancora aperta → nessuna azione

      // Posizione non trovata su MEXC → è stata chiusa (SL nativo, TP nativo, liquidazione, manuale)
      await this.handleExternalClose(trade);
    }
  }

  private async handleExternalClose(trade: any) {
    let reason     = 'manual';
    let closePrice = 0;
    let feesClose: number | null = null;

    // Get actual closing fills via trade history
    try {
      const since    = new Date(trade.openedAt).getTime();
      const closeDir = trade.direction === 'LONG' ? 'sell' : 'buy';
      const myTrades = await this.exchange.fetchMyTrades(trade.symbol, since, 20);
      const closers  = myTrades
        .filter(t => t.side === closeDir && t.timestamp >= since)
        .sort((a, b) => b.timestamp - a.timestamp);
      if (closers.length > 0) {
        closePrice = Number(closers[0].price ?? 0);
        feesClose  = closers.reduce((s, t) => s + Number(t.fee?.cost ?? 0), 0);
      }
    } catch (e: any) {
      this.logger.warn(`[LIVE] fetchMyTrades ${trade.symbol}: ${e?.message?.slice(0, 80)}`);
    }

    // Determine reason from closePrice proximity to SL/TP
    if (closePrice > 0) {
      const slDist = Math.abs(closePrice - trade.stopLoss)   / trade.stopLoss;
      const tpDist = Math.abs(closePrice - trade.takeProfit) / trade.takeProfit;
      if      (slDist <= 0.008) reason = 'sl';
      else if (tpDist <= 0.008) reason = 'tp';
    }

    // Cancel remaining native SL/TP stop orders
    const mexcSym = this.markets[trade.symbol]?.id ?? trade.symbol.split('/')[0] + '_USDT';
    if (trade.slOrderId) {
      try {
        await (this.exchange as any).contractPrivatePostStoporderCancel({
          symbol:      mexcSym,
          stopOrderId: trade.slOrderId,
        });
      } catch {}
    }

    // Calculate PnL
    let pnl: number | null = null;
    if (closePrice > 0) {
      const priceDiff = trade.direction === 'LONG'
        ? (closePrice - trade.entry) / trade.entry
        : (trade.entry - closePrice) / trade.entry;
      const fc = feesClose ?? (trade.positionSize * 0.00038);
      pnl       = parseFloat((trade.positionSize * priceDiff - (trade.feesOpen ?? 0) - fc).toFixed(4));
      feesClose = parseFloat((feesClose ?? (trade.positionSize * 0.00038)).toFixed(6));
    }

    await this.prisma.liveTrade.update({
      where: { id: trade.id },
      data: {
        status:   reason,
        closedAt: new Date(),
        ...(closePrice > 0    ? { closePrice: parseFloat(closePrice.toFixed(8)) } : {}),
        ...(pnl !== null      ? { pnl }                                           : {}),
        ...(feesClose !== null ? { feesClose }                                    : {}),
      },
    });

    const icon = reason === 'tp' ? '✅' : reason === 'sl' ? '🛑' : '🔒';
    this.logger.log(`[LIVE] ${icon} ${reason.toUpperCase()} ${trade.symbol} | close @ ${closePrice} | PnL ${pnl ?? '?'}`);
    this.events.emitLiveTrade({ ...trade, status: reason, closePrice, pnl });
  }

  // ─── Chiusura manuale (da UI) ────────────────────────────────────────────────

  async closeManual(id: string) {
    const trade = await this.prisma.liveTrade.findUnique({ where: { id } });
    if (!trade || trade.status !== 'open') return;

    // Cancella SL/TP nativi prima di chiudere
    const mexcSym = this.markets[trade.symbol]?.id ?? trade.symbol.split('/')[0] + '_USDT';
    if (trade.slOrderId) {
      try {
        await (this.exchange as any).contractPrivatePostStoporderCancel({
          symbol:      mexcSym,
          stopOrderId: trade.slOrderId,
        });
      } catch { /* già cancellato o non esistente */ }
    } else {
      try { await (this.exchange as any).contractPrivatePostStoporderCancelAll({ symbol: mexcSym }); } catch {}
    }

    // Chiudi la posizione con ordine market reduce-only
    try {
      const side  = trade.direction === 'LONG' ? 'sell' : 'buy';
      const order = await this.exchange.createOrder(
        trade.symbol, 'market', side, trade.contracts,
        undefined, { reduceOnly: true },
      );

      const closePrice = Number(order.average ?? order.price ?? 0);
      const actualFee  = Number(order.fee?.cost ?? (trade.positionSize * 0.00038));
      const priceDiff  = trade.direction === 'LONG'
        ? (closePrice - trade.entry) / trade.entry
        : (trade.entry - closePrice) / trade.entry;
      const pnl = parseFloat((trade.positionSize * priceDiff - (trade.feesOpen ?? 0) - actualFee).toFixed(4));

      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data: {
          status:     'manual',
          closePrice: parseFloat(closePrice.toFixed(8)),
          pnl,
          feesClose:  parseFloat(actualFee.toFixed(6)),
          closedAt:   new Date(),
        },
      });

      this.logger.log(`[LIVE] 🔒 MANUAL ${trade.symbol} | close @ ${closePrice} | PnL $${pnl}`);
      this.events.emitLiveTrade({ ...trade, status: 'manual', closePrice, pnl, feesClose: actualFee });

    } catch (e: any) {
      this.logger.error(`[LIVE] Manual close failed ${trade.symbol}: ${e?.message}`);
      // Se la posizione non esiste più su MEXC, aggiorna il DB comunque
      if (e?.message?.toLowerCase().includes('position') || e?.message?.toLowerCase().includes('reduce')) {
        await this.prisma.liveTrade.update({
          where: { id: trade.id },
          data:  { status: 'manual', closedAt: new Date() },
        });
        this.events.emitLiveTrade({ ...trade, status: 'manual' });
      }
    }
  }

  async getTrades(limit = 100) {
    return this.prisma.liveTrade.findMany({
      orderBy: { openedAt: 'desc' },
      take:    limit,
    });
  }

  async getAnalytics() {
    const closed = await this.prisma.liveTrade.findMany({
      where:   { status: { notIn: ['open', 'error'] } },
      orderBy: { closedAt: 'asc' },
    });
    const open = await this.prisma.liveTrade.findMany({ where: { status: 'open' } });

    const totalPnl    = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees   = closed.reduce((s, t) => s + (t.feesOpen ?? 0) + (t.feesClose ?? 0), 0);
    const wins        = closed.filter(t => (t.pnl ?? 0) > 0);
    const winRate     = closed.length > 0 ? wins.length / closed.length * 100 : 0;
    const avgFeeOpen  = closed.length > 0 ? closed.reduce((s, t) => s + (t.feesOpen ?? 0), 0) / closed.length : 0;
    const avgFeeClose = closed.length > 0 ? closed.reduce((s, t) => s + (t.feesClose ?? 0), 0) / closed.length : 0;
    const totalNotional = closed.reduce((s, t) => s + t.positionSize, 0);

    return {
      totalTrades:  closed.length,
      openTrades:   open.length,
      totalPnl:     parseFloat(totalPnl.toFixed(4)),
      totalFees:    parseFloat(totalFees.toFixed(4)),
      winRate:      parseFloat(winRate.toFixed(1)),
      avgFeeOpen:   parseFloat(avgFeeOpen.toFixed(6)),
      avgFeeClose:  parseFloat(avgFeeClose.toFixed(6)),
      feeRatePct:   totalNotional > 0 ? parseFloat((totalFees / totalNotional * 100).toFixed(4)) : 0,
    };
  }
}
