import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';
export interface TradeSignal {
  symbol: string; direction: 'LONG' | 'SHORT'; grade: string;
  entry: number; slPct: number; tp1Pct: number; suggestedLeverage: number;
  score?: number;
}

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
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
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

  async enterTrade(signal: TradeSignal): Promise<void> {
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
      // Buffer +0.3% sul SL per evitare errore MEXC 5003. Il TP viene scalato
      // proporzionalmente per mantenere il RR configurato (es. 1:1.5).
      const isLong    = signal.direction === 'LONG';
      const slFrac      = signal.slPct / 100;
      const SL_BUFFER   = 0.003; // 0.3% extra
      const TP_RR       = 1.5;   // fisso 1:1.5 sempre
      const totalSlFrac = slFrac + SL_BUFFER;
      const totalTpFrac = totalSlFrac * TP_RR;
      const adjSL = isLong
        ? filled * (1 - totalSlFrac)
        : filled * (1 + totalSlFrac);
      const adjTP = isLong
        ? filled * (1 + totalTpFrac)
        : filled * (1 - totalTpFrac);

      const slPrice    = parseFloat(this.exchange.priceToPrecision(signal.symbol, adjSL));
      const tpPrice    = parseFloat(this.exchange.priceToPrecision(signal.symbol, adjTP));
      const mexcSymbol = this.markets[signal.symbol]?.id ?? signal.symbol.split('/')[0] + '_USDT';

      let slOrderId: string | undefined;
      let tpOrderId: string | undefined;

      try {
        // Attesa 1.5s: garantisce che MEXC abbia registrato la posizione e il mark price sia stabile
        await new Promise(r => setTimeout(r, 1500));
        const positions = await this.exchange.fetchPositions([signal.symbol]);
        const newPos = positions.find(p =>
          p.symbol === signal.symbol &&
          Math.abs(Number(p.contracts ?? 0)) > 0 &&
          (signal.direction === 'LONG' ? p.side === 'long' : p.side === 'short'),
        );

        if (newPos) {
          const positionId = newPos.info?.positionId;
          const posVol     = Math.abs(Number(newPos.contracts ?? 0));

          // Retry con buffer crescente se MEXC risponde 5003 (prezzo stop invalido)
          let placed = false;
          for (let attempt = 0; attempt < 3 && !placed; attempt++) {
            const extraBuf = attempt * 0.002; // 0%, +0.2%, +0.4% extra ad ogni retry
            const retrySL = isLong
              ? parseFloat(this.exchange.priceToPrecision(signal.symbol, adjSL * (1 - extraBuf)))
              : parseFloat(this.exchange.priceToPrecision(signal.symbol, adjSL * (1 + extraBuf)));
            try {
              const res: any = await (this.exchange as any).contractPrivatePostStoporderPlace({
                symbol:          mexcSymbol,
                positionId,
                vol:             posVol,
                stopLossPrice:   attempt === 0 ? slPrice : retrySL,
                takeProfitPrice: tpPrice,
              });
              slOrderId = String(res?.data ?? '');
              tpOrderId = slOrderId;
              placed = true;
              this.logger.log(`[LIVE] ✅ SL/TP set: SL @ ${attempt === 0 ? slPrice : retrySL} | TP @ ${tpPrice} | stopOrderId: ${slOrderId}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
            } catch (retryErr: any) {
              if (retryErr?.message?.includes('5003') && attempt < 2) {
                await new Promise(r => setTimeout(r, 800));
              } else {
                throw retryErr;
              }
            }
          }
        } else {
          this.logger.warn(`[LIVE] Position not found after open for ${signal.symbol} — SL/TP not set`);
        }
      } catch (e: any) {
        this.logger.warn(`[LIVE] SL/TP failed ${signal.symbol}: ${e?.message?.slice(0, 150)} — chiusura posizione immediata`);
        // SL/TP non impostato: chiudi subito la posizione per non lasciare rischio scoperto
        try {
          const closeSide = signal.direction === 'LONG' ? 'sell' : 'buy';
          await this.exchange.createOrder(signal.symbol, 'market', closeSide, amount, undefined, { reduceOnly: true });
          this.logger.warn(`[LIVE] ⚠️ ${signal.symbol} chiuso immediatamente — SL/TP non impostabile`);
        } catch (closeErr: any) {
          this.logger.error(`[LIVE] Chiusura emergenza fallita ${signal.symbol}: ${closeErr?.message}`);
        }
        return; // non salvare il trade nel DB come aperto
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
          score:        signal.score ?? 0,
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
      const isLongFallback = signal.direction === 'LONG';
      const slFallback = signal.entry * (isLongFallback ? (1 - signal.slPct / 100) : (1 + signal.slPct / 100));
      const tpFallback = signal.entry * (isLongFallback ? (1 + signal.tp1Pct / 100) : (1 - signal.tp1Pct / 100));
      await this.prisma.liveTrade.create({
        data: {
          id,
          symbol:       signal.symbol,
          direction:    signal.direction,
          entry:        signal.entry,
          stopLoss:     parseFloat(slFallback.toFixed(8)),
          takeProfit:   parseFloat(tpFallback.toFixed(8)),
          leverage:     signal.suggestedLeverage,
          marginEur:    cfg.marginPerTrade,
          positionSize: cfg.marginPerTrade * signal.suggestedLeverage,
          contracts:    0,
          grade:        signal.grade,
          score:        signal.score ?? 0,
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
    let pnl: number | null = null;

    const mexcSym    = this.markets[trade.symbol]?.id ?? trade.symbol.split('/')[0] + '_USDT';
    const since      = new Date(trade.openedAt).getTime();
    const entryRef   = Number(trade.entry);
    const posType    = trade.direction === 'LONG' ? 1 : 2;

    // Primary: MEXC position history — returns closeAvgPrice + realised PnL for SL/TP native closes
    let resolvedFromHistory = false;
    try {
      const res: any = await (this.exchange as any).contractPrivateGetPositionListHistoryPositions({
        symbol:   mexcSym,
        pageNum:  1,
        pageSize: 10,
      });
      const list: any[] = res?.data?.resultList ?? (Array.isArray(res?.data) ? res.data : []);

      const hist = list.find(p => {
        if (Number(p.positionType) !== posType) return false;
        const t = Number(p.updateTime ?? p.createTime ?? 0);
        if (t > 0 && t < since) return false;
        const avg = Number(p.openAvgPrice ?? 0);
        return avg === 0 || entryRef === 0 || Math.abs(avg - entryRef) / entryRef < 0.01;
      });

      if (hist) {
        const cp = Number(hist.closeAvgPrice ?? 0);
        if (cp > 0) {
          closePrice          = cp;
          pnl                 = parseFloat(Number(hist.realised ?? hist.realizedPnl ?? 0).toFixed(4));
          feesClose           = parseFloat((trade.positionSize * 0.00038).toFixed(6));
          resolvedFromHistory = true;
          this.logger.log(`[LIVE] positionHistory OK ${trade.symbol}: close=${cp} realised=${hist.realised ?? hist.realizedPnl}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`[LIVE] positionHistory ${trade.symbol}: ${e?.message?.slice(0, 80)}`);
    }

    // Fallback: fetchMyTrades (may not return SL/TP fills on MEXC swap)
    if (!resolvedFromHistory) {
      try {
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
    }

    // Determine reason from closePrice proximity to SL/TP
    if (closePrice > 0) {
      const slDist = Math.abs(closePrice - Number(trade.stopLoss))   / Number(trade.stopLoss);
      const tpDist = Math.abs(closePrice - Number(trade.takeProfit)) / Number(trade.takeProfit);
      if      (slDist <= 0.008) reason = 'sl';
      else if (tpDist <= 0.008) reason = 'tp';
    }

    // Cancel remaining native SL/TP stop orders
    if (trade.slOrderId) {
      try {
        await (this.exchange as any).contractPrivatePostStoporderCancel({
          symbol:      mexcSym,
          stopOrderId: trade.slOrderId,
        });
      } catch {}
    }

    // Compute PnL from price diff if not already obtained from realised
    if (pnl === null && closePrice > 0) {
      const priceDiff = trade.direction === 'LONG'
        ? (closePrice - entryRef) / entryRef
        : (entryRef - closePrice) / entryRef;
      const fc = feesClose ?? (trade.positionSize * 0.00038);
      pnl       = parseFloat((trade.positionSize * priceDiff - (trade.feesOpen ?? 0) - fc).toFixed(4));
      feesClose = parseFloat((feesClose ?? (trade.positionSize * 0.00038)).toFixed(6));
    }

    await this.prisma.liveTrade.update({
      where: { id: trade.id },
      data: {
        status:   reason,
        closedAt: new Date(),
        ...(closePrice > 0     ? { closePrice: parseFloat(closePrice.toFixed(8)) } : {}),
        ...(pnl !== null       ? { pnl }                                           : {}),
        ...(feesClose !== null ? { feesClose }                                     : {}),
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

    // Solo trade con PnL reale (non null) contano per Win Rate e PnL totale
    const withPnl  = closed.filter(t => t.pnl !== null);
    const wins     = withPnl.filter(t => (t.pnl ?? 0) > 0);

    const totalPnl = withPnl.length > 0
      ? withPnl.reduce((s, t) => s + (t.pnl ?? 0), 0)
      : null;

    const winRate = withPnl.length > 0
      ? wins.length / withPnl.length * 100
      : null;

    // Fee: usiamo tutto il closed per feesOpen (sempre presente), solo withFeesClose per la media close
    const totalFees  = closed.reduce((s, t) => s + (t.feesOpen ?? 0) + (t.feesClose ?? 0), 0);
    const avgFeeOpen = closed.length > 0
      ? closed.reduce((s, t) => s + (t.feesOpen ?? 0), 0) / closed.length
      : 0;

    const withFeesClose = closed.filter(t => t.feesClose !== null);
    const avgFeeClose   = withFeesClose.length > 0
      ? withFeesClose.reduce((s, t) => s + (t.feesClose ?? 0), 0) / withFeesClose.length
      : null;

    // Fee RT% solo sui trade con dati completi
    const totalNotional = withPnl.reduce((s, t) => s + t.positionSize, 0);
    const feesOnWithPnl = withPnl.reduce((s, t) => s + (t.feesOpen ?? 0) + (t.feesClose ?? 0), 0);
    const feeRatePct    = totalNotional > 0 ? feesOnWithPnl / totalNotional * 100 : null;

    return {
      totalTrades:   closed.length,
      tradesWithPnl: withPnl.length,
      openTrades:    open.length,
      totalPnl:      totalPnl !== null ? parseFloat(totalPnl.toFixed(4)) : null,
      totalFees:     parseFloat(totalFees.toFixed(4)),
      winRate:       winRate !== null ? parseFloat(winRate.toFixed(1)) : null,
      avgFeeOpen:    parseFloat(avgFeeOpen.toFixed(6)),
      avgFeeClose:   avgFeeClose !== null ? parseFloat(avgFeeClose.toFixed(6)) : null,
      feeRatePct:    feeRatePct !== null ? parseFloat(feeRatePct.toFixed(4)) : null,
    };
  }
}
