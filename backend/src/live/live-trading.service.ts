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
  stopLossPrice?: number;   // prezzo SL assoluto calcolato dallo scanner
  takeProfitPrice?: number; // prezzo TP assoluto calcolato dallo scanner
}

export interface LiveConfigData {
  enabled:        boolean;
  autoClose:      boolean;
  marginPerTrade: number;
  minGrade:       string;
  maxConcurrent:  number;
  orderType:      string;
  tpRr:           number;
  liveStrategy:   string;
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
        data: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2, orderType: 'limit', tpRr: 3.0 } as any,
      });
    }
  }

  async getConfig(): Promise<LiveConfigData> {
    let cfg = await this.prisma.liveConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.liveConfig.create({
        data: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2, orderType: 'limit', tpRr: 3.0 } as any,
      });
    }
    return {
      enabled:        cfg.enabled,
      autoClose:      cfg.autoClose,
      marginPerTrade: cfg.marginPerTrade,
      minGrade:       cfg.minGrade,
      maxConcurrent:  cfg.maxConcurrent,
      orderType:      cfg.orderType ?? 'limit',
      tpRr:           (cfg as any).tpRr ?? 3.0,
      liveStrategy:   (cfg as any).liveStrategy ?? 'smart',
    };
  }

  async updateConfig(data: Partial<LiveConfigData>) {
    return this.prisma.liveConfig.upsert({
      where:  { id: 1 },
      create: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A+', maxConcurrent: 2, tpRr: 3.0, ...data } as any,
      update: data,
    });
  }

  // ─── Entry ───────────────────────────────────────────────────────────────────
  // orderType='limit': GTC a signal.entry, scade dopo 10 min
  // orderType='market': entra subito, SL/TP piazzati immediatamente

  async enterTrade(signal: TradeSignal): Promise<void> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return;

    const gradeOrder = ['A+', 'A', 'B', 'C'];
    if (gradeOrder.indexOf(signal.grade) > gradeOrder.indexOf(cfg.minGrade)) return;

    const activeCount = await this.prisma.liveTrade.count({ where: { status: { in: ['open', 'pending'] } } });
    if (activeCount >= cfg.maxConcurrent) return;

    const already = await this.prisma.liveTrade.findFirst({
      where: { symbol: signal.symbol, status: { in: ['open', 'pending'] } },
    });
    if (already) return;

    const id           = `live_${signal.symbol}_${Date.now()}`;
    const market       = this.markets[signal.symbol];
    const leverage     = signal.suggestedLeverage;
    const margin       = cfg.marginPerTrade;
    const notional     = margin * leverage;
    const contractSize = market?.contractSize ?? 1;
    const isLong       = signal.direction === 'LONG';
    const side         = isLong ? 'buy' : 'sell';
    const mexcSymbol   = market?.id ?? signal.symbol.split('/')[0] + '_USDT';

    const totalSlFrac = signal.slPct / 100;
    const totalTpFrac = signal.tp1Pct / 100;
    // Usa prezzi assoluti dallo scanner se disponibili (SL = apertura candela trigger, perfetto)
    const adjSL = signal.stopLossPrice  ?? (isLong ? signal.entry * (1 - totalSlFrac) : signal.entry * (1 + totalSlFrac));
    const adjTP = signal.takeProfitPrice ?? (isLong ? signal.entry * (1 + totalTpFrac) : signal.entry * (1 - totalTpFrac));
    const slPrice = parseFloat(this.exchange.priceToPrecision(signal.symbol, adjSL));
    const tpPrice = parseFloat(this.exchange.priceToPrecision(signal.symbol, adjTP));

    try {
      let amount = notional / (signal.entry * contractSize);
      const minAmount = market?.limits?.amount?.min ?? 0;
      if (minAmount > 0 && amount < minAmount) {
        this.logger.warn(`[LIVE] ${signal.symbol}: amount ${amount.toFixed(6)} < min ${minAmount} — skip`);
        return;
      }
      amount = parseFloat(this.exchange.amountToPrecision(signal.symbol, amount));

      await Promise.allSettled([
        this.exchange.setMarginMode('isolated', signal.symbol),
        this.exchange.setLeverage(leverage, signal.symbol),
      ]);

      const feesEst = notional * 0.00038;

      if (cfg.orderType === 'market') {
        // ── MARKET: entra subito, poi fetch position per positionId, poi SL/TP ──
        const order     = await this.exchange.createOrder(signal.symbol, 'market', side, amount);
        const fillPrice = Number(order.average ?? order.price ?? signal.entry);
        const orderId   = String(order.id ?? '');

        // Attendi posizione visibile (MEXC può avere delay ~1-2s)
        let pos: any = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise(r => setTimeout(r, 1000));
          const positions = await this.exchange.fetchPositions([signal.symbol]);
          pos = positions.find(p =>
            p.symbol === signal.symbol &&
            Math.abs(Number(p.contracts ?? 0)) > 0 &&
            (isLong ? p.side === 'long' : p.side === 'short'),
          );
          if (pos) break;
        }

        const positionId = pos?.info?.positionId;
        const posVol     = Math.abs(Number(pos?.contracts ?? amount));

        if (!positionId) {
          this.logger.warn(`[LIVE] positionId non trovato per ${signal.symbol} — SL/TP non piazzati`);
        }

        // Piazza SL/TP nativi con positionId
        let slOrderId: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const extraBuf = attempt * 0.002;
          const retrySL  = isLong
            ? parseFloat(this.exchange.priceToPrecision(signal.symbol, slPrice * (1 - extraBuf)))
            : parseFloat(this.exchange.priceToPrecision(signal.symbol, slPrice * (1 + extraBuf)));
          try {
            const res: any = await (this.exchange as any).contractPrivatePostStoporderPlace({
              symbol:          mexcSymbol,
              positionId,
              vol:             posVol,
              stopLossPrice:   attempt === 0 ? slPrice : retrySL,
              takeProfitPrice: tpPrice,
            });
            slOrderId = String(res?.data ?? '');
            this.logger.log(`[LIVE] 🚀 MARKET ${side.toUpperCase()} ${signal.symbol} @ ${fillPrice} | SL ${slPrice} | TP ${tpPrice} | posId ${positionId} | stopOrderId ${slOrderId}`);
            break;
          } catch (e: any) {
            if (attempt < 2) await new Promise(r => setTimeout(r, 800));
            else this.logger.warn(`[LIVE] SL/TP failed market ${signal.symbol}: ${e?.message?.slice(0, 100)}`);
          }
        }

        const trade = await this.prisma.liveTrade.create({
          data: {
            id, symbol: signal.symbol, direction: signal.direction,
            entry: parseFloat(fillPrice.toFixed(8)), stopLoss: slPrice, takeProfit: tpPrice,
            leverage, marginEur: parseFloat(margin.toFixed(4)),
            positionSize: parseFloat(notional.toFixed(4)), contracts: posVol,
            orderId, slOrderId, tpOrderId: slOrderId,
            grade: signal.grade, score: signal.score ?? 0,
            feesOpen: parseFloat(feesEst.toFixed(6)), status: 'open',
          },
        });
        this.events.emitLiveTrade(trade);

      } else {
        // ── LIMIT: GTC a signal.entry con SL/TP embedded nell'ordine ─────────
        // MEXC futures supporta stopLossPrice e takeProfitPrice direttamente
        // nell'ordine: SL/TP sono atomici, non servono chiamate successive.
        const limitPrice = parseFloat(this.exchange.priceToPrecision(signal.symbol, signal.entry));
        const order      = await this.exchange.createOrder(
          signal.symbol, 'limit', side, amount, limitPrice,
          { timeInForce: 'GTC', stopLossPrice: slPrice, takeProfitPrice: tpPrice },
        );
        this.logger.log(`[LIVE] order.id=${JSON.stringify(order.id)} info=${JSON.stringify(order.info)}`);
        const rawId        = order.info?.data ?? order.info?.orderId ?? order.info?.order_id ?? order.id;
        const limitOrderId = rawId != null && typeof rawId !== 'object' ? String(rawId) : String(order.id ?? '');

        const trade = await this.prisma.liveTrade.create({
          data: {
            id, symbol: signal.symbol, direction: signal.direction,
            entry: limitPrice, stopLoss: slPrice, takeProfit: tpPrice,
            leverage, marginEur: parseFloat(margin.toFixed(4)),
            positionSize: parseFloat(notional.toFixed(4)), contracts: amount,
            limitOrderId, orderId: limitOrderId,
            grade: signal.grade, score: signal.score ?? 0,
            feesOpen: parseFloat(feesEst.toFixed(6)), status: 'pending',
          },
        });
        this.logger.log(`[LIVE] ⏳ LIMIT ${side.toUpperCase()} ${signal.symbol} | ${amount} @ ${limitPrice} | SL ${slPrice} | TP ${tpPrice} | expire 10min`);
        this.events.emitLiveTrade(trade);
      }

    } catch (e: any) {
      this.logger.error(`[LIVE] enterTrade failed ${signal.symbol}: ${e?.message}`);
      await this.prisma.liveTrade.create({
        data: {
          id, symbol: signal.symbol, direction: signal.direction,
          entry: signal.entry, stopLoss: slPrice, takeProfit: tpPrice,
          leverage, marginEur: cfg.marginPerTrade,
          positionSize: cfg.marginPerTrade * leverage,
          contracts: 0, grade: signal.grade, score: signal.score ?? 0,
          status: 'error', note: e?.message?.slice(0, 200),
        },
      });
    }
  }

  // ─── Check pending limit orders ogni 15s ──────────────────────────────────────

  @Cron('*/15 * * * * *')
  async checkPendingOrders() {
    const pending = await this.prisma.liveTrade.findMany({ where: { status: 'pending' } });
    if (!pending.length) return;

    for (const trade of pending) {
      const age        = Date.now() - new Date(trade.openedAt).getTime();
      const mexcSymbol = this.markets[trade.symbol]?.id ?? trade.symbol.split('/')[0] + '_USDT';

      // Scaduto dopo 5 minuti → cancella ordine e marca expired
      if (age > 10 * 60 * 1000) {
        if (trade.limitOrderId) {
          try {
            await this.exchange.cancelOrder(trade.limitOrderId, trade.symbol);
            this.logger.log(`[LIVE] ⏰ EXPIRED ${trade.symbol} — limit non riempito in 5min`);
          } catch (e: any) {
            // 400/order already cancelled/filled — non è un errore fatale
            this.logger.warn(`[LIVE] Cancel ${trade.symbol}: ${e?.message?.slice(0, 80)}`);
          }
        }
        await this.prisma.liveTrade.update({ where: { id: trade.id }, data: { status: 'expired' } });
        this.events.emitLiveTrade({ ...trade, status: 'expired' });
        continue;
      }

      // Controlla se la posizione si è aperta (limit riempito)
      try {
        const positions = await this.exchange.fetchPositions([trade.symbol]);
        const isLong = trade.direction === 'LONG';
        const pos = positions.find(p =>
          p.symbol === trade.symbol &&
          Math.abs(Number(p.contracts ?? 0)) > 0 &&
          (isLong ? p.side === 'long' : p.side === 'short'),
        );
        if (!pos) continue; // non ancora riempito

        const posVol     = Math.abs(Number(pos.contracts ?? trade.contracts));
        const fillPrice  = Number(pos.entryPrice ?? pos.info?.openAvgPrice ?? trade.entry);
        const positionId = pos.info?.positionId;

        // Piazza SL/TP nativi con positionId
        let slOrderId: string | undefined;
        let placed = false;
        for (let attempt = 0; attempt < 3 && !placed; attempt++) {
          const extraBuf = attempt * 0.002;
          const retrySL = isLong
            ? parseFloat(this.exchange.priceToPrecision(trade.symbol, trade.stopLoss * (1 - extraBuf)))
            : parseFloat(this.exchange.priceToPrecision(trade.symbol, trade.stopLoss * (1 + extraBuf)));
          try {
            const res: any = await (this.exchange as any).contractPrivatePostStoporderPlace({
              symbol:          mexcSymbol,
              positionId,
              vol:             posVol,
              stopLossPrice:   attempt === 0 ? trade.stopLoss : retrySL,
              takeProfitPrice: trade.takeProfit,
            });
            slOrderId = String(res?.data ?? '');
            placed    = true;
            this.logger.log(`[LIVE] ✅ FILLED ${trade.symbol} @ ${fillPrice} | SL ${trade.stopLoss} | TP ${trade.takeProfit} | stopOrderId ${slOrderId}`);
          } catch (retryErr: any) {
            if (attempt < 2) {
              await new Promise(r => setTimeout(r, 800));
            } else {
              this.logger.warn(`[LIVE] SL/TP failed ${trade.symbol}: ${retryErr?.message?.slice(0, 100)}`);
            }
          }
        }

        const updated = await this.prisma.liveTrade.update({
          where: { id: trade.id },
          data: { status: 'open', entry: parseFloat(fillPrice.toFixed(8)), slOrderId, tpOrderId: slOrderId },
        });
        this.events.emitLiveTrade(updated);

      } catch (e: any) {
        this.logger.warn(`[LIVE] checkPending ${trade.symbol}: ${e?.message?.slice(0, 80)}`);
      }
    }
  }

  // ─── Reconciliation ogni 10s ─────────────────────────────────────────────────
  // Rileva chiusure native (SL/TP exchange) o esterne e aggiorna il DB

  @Cron('*/10 * * * * *')
  async checkOpenPositions() {
    const openTrades = await this.prisma.liveTrade.findMany({ where: { status: 'open' } });
    if (!openTrades.length) return;

    const MAX_HOLD_MS = 4 * 60 * 60 * 1000; // 4h max hold time

    // Chiudi forzatamente i trade troppo vecchi
    for (const trade of openTrades) {
      const age = Date.now() - new Date(trade.openedAt).getTime();
      if (age > MAX_HOLD_MS) {
        this.logger.log(`[LIVE] ⏰ MAX HOLD 4h — chiudo ${trade.direction} ${trade.symbol}`);
        try {
          await this.closeManual(trade.id);
        } catch (e: any) {
          this.logger.error(`[LIVE] Max hold close error ${trade.symbol}: ${e?.message}`);
        }
      }
    }

    // Fetch posizioni reali su MEXC
    let mexcPositions: any[];
    try {
      mexcPositions = await this.exchange.fetchPositions(openTrades.map(t => t.symbol));
    } catch { return; }

    for (const trade of openTrades) {
      const mexcPos = mexcPositions.find(
        p => p.symbol === trade.symbol && Math.abs(Number(p.contracts ?? 0)) > 0,
      );
      if (mexcPos) {
        // Break-Even automatico — 50% verso TP → SL si sposta a entry
        const markPrice = Number(mexcPos.markPrice ?? mexcPos.info?.markPrice ?? 0);
        if (markPrice > 0) {
          const isLong  = trade.direction === 'LONG';
          const tpDist  = Math.abs(trade.takeProfit - trade.entry);
          const bePrice = isLong ? trade.entry + tpDist * 0.5 : trade.entry - tpDist * 0.5;
          const beActive = isLong ? trade.stopLoss >= trade.entry * 0.9999 : trade.stopLoss <= trade.entry * 1.0001;
          if (!beActive && (isLong ? markPrice >= bePrice : markPrice <= bePrice)) {
            await this.triggerBreakEven(trade, mexcPos);
          }
        }
        continue; // posizione ancora aperta → nessuna azione
      }

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

  // ─── Break-Even automatico ──────────────────────────────────────────────────
  private async triggerBreakEven(trade: any, mexcPos: any) {
    const mexcSym    = this.markets[trade.symbol]?.id ?? trade.symbol.split('/')[0] + '_USDT';
    const positionId = mexcPos.info?.positionId;
    const posVol     = Math.abs(Number(mexcPos.contracts ?? trade.contracts));
    const newSl      = parseFloat(this.exchange.priceToPrecision(trade.symbol, trade.entry));
    const tpPrice    = parseFloat(this.exchange.priceToPrecision(trade.symbol, trade.takeProfit));

    try {
      if (trade.slOrderId) {
        try {
          await (this.exchange as any).contractPrivatePostStoporderCancel({ symbol: mexcSym, stopOrderId: trade.slOrderId });
        } catch {}
      }
      const res: any = await (this.exchange as any).contractPrivatePostStoporderPlace({
        symbol: mexcSym, positionId, vol: posVol,
        stopLossPrice: newSl, takeProfitPrice: tpPrice,
      });
      const newSlOrderId = String(res?.data ?? '');
      await this.prisma.liveTrade.update({
        where: { id: trade.id },
        data:  { stopLoss: trade.entry, slOrderId: newSlOrderId },
      });
      this.logger.log(`[LIVE BE] ⚡ ${trade.symbol} BE attivato — SL → entry ${newSl} | stopOrderId ${newSlOrderId}`);
      this.events.emitLiveTrade({ ...trade, stopLoss: trade.entry });
    } catch (e: any) {
      this.logger.warn(`[LIVE BE] ${trade.symbol}: ${e?.message?.slice(0, 100)}`);
    }
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
