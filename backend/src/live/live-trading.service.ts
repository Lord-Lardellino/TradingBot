import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../events/events.gateway';

const MAX_TRIGGER_FILL_MS = 15_000;
const MAX_WORSE_ENTRY_PCT = 0.25;
const MIN_LIVE_RR_FACTOR = 0.98;

export interface TradeSignal {
  symbol: string; direction: 'LONG' | 'SHORT'; grade: string;
  entry: number; slPct: number; tp1Pct: number; suggestedLeverage: number;
  score?: number;
  stopLossPrice?: number;   // prezzo SL assoluto calcolato dallo scanner
  takeProfitPrice?: number; // prezzo TP assoluto calcolato dallo scanner
  riskUsdt?: number;        // opzionale: rischio fisso in USDT per strategie dedicate
  feeRate?: number;         // fee stimata per lato; 0 per coppie zero-fee
  source?: string;          // tag separato per analytics/filtri live
  sourceMaxConcurrent?: number;
  bypassGlobalConfig?: boolean;
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
  // cache leverage per evitare chiamate API ripetute (TTL 30 min)
  private leverageCache = new Map<string, { leverage: number; ts: number }>();

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
        data: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A', maxConcurrent: 5, orderType: 'market', tpRr: 2.0 } as any,
      });
    }
  }

  async getConfig(): Promise<LiveConfigData> {
    let cfg = await this.prisma.liveConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.liveConfig.create({
        data: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A', maxConcurrent: 5, orderType: 'market', tpRr: 2.0 } as any,
      });
    }
    return {
      enabled:        cfg.enabled,
      autoClose:      cfg.autoClose,
      marginPerTrade: cfg.marginPerTrade,
      minGrade:       cfg.minGrade,
      maxConcurrent:  cfg.maxConcurrent,
      orderType:      'market',
      tpRr:           (cfg as any).tpRr ?? 2.0,
      liveStrategy:   (cfg as any).liveStrategy ?? 'smart',
    };
  }

  async updateConfig(data: Partial<LiveConfigData>) {
    return this.prisma.liveConfig.upsert({
      where:  { id: 1 },
      create: { id: 1, enabled: false, autoClose: true, marginPerTrade: 5, minGrade: 'A', maxConcurrent: 5, orderType: 'market', tpRr: 2.0, ...data } as any,
      update: data,
    });
  }

  // ─── Entry ───────────────────────────────────────────────────────────────────
  // orderType='limit': GTC a signal.entry, scade dopo 10 min
  // orderType='market': entra subito, SL/TP piazzati immediatamente

  private executionStats(direction: 'LONG' | 'SHORT', entry: number, stopLoss: number, takeProfit: number) {
    const slDist = direction === 'LONG' ? entry - stopLoss : stopLoss - entry;
    const tpDist = direction === 'LONG' ? takeProfit - entry : entry - takeProfit;
    return {
      slPct: entry > 0 ? slDist / entry * 100 : -1,
      tpPct: entry > 0 ? tpDist / entry * 100 : -1,
      rr:    slDist > 0 ? tpDist / slDist : -1,
    };
  }

  private feeRateForTrade(trade: any) {
    if (trade?.feeRate !== undefined && trade?.feeRate !== null) return Number(trade.feeRate);
    return String(trade?.note ?? '').startsWith('POL_ZERO') ? 0 : 0.00038;
  }

  private validateTriggerFill(signal: TradeSignal, fillPrice: number, stopLoss: number, takeProfit: number) {
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { ok: false, reason: 'fill_invalid' };

    const worsePct = signal.direction === 'LONG'
      ? (fillPrice - signal.entry) / signal.entry * 100
      : (signal.entry - fillPrice) / signal.entry * 100;
    if (worsePct > MAX_WORSE_ENTRY_PCT) return { ok: false, reason: `entry_slip_${worsePct.toFixed(4)}pct` };

    const stats = this.executionStats(signal.direction, fillPrice, stopLoss, takeProfit);
    const expectedRr = signal.slPct > 0 ? signal.tp1Pct / signal.slPct : 0;
    if (stats.slPct <= 0 || stats.tpPct <= 0 || stats.rr < expectedRr * MIN_LIVE_RR_FACTOR) {
      return { ok: false, reason: `rr_bad_live_${stats.rr.toFixed(3)}_expected_${expectedRr.toFixed(3)}` };
    }

    return { ok: true, reason: 'ok' };
  }

  private async closeRejectedFill(args: {
    id: string;
    signal: TradeSignal;
    fillPrice: number;
    stopLoss: number;
    takeProfit: number;
    leverage: number;
    margin: number;
    positionSize: number;
    contracts: number;
    orderId?: string;
    feesOpen: number;
    reason: string;
  }) {
    const side = args.signal.direction === 'LONG' ? 'sell' : 'buy';
    let status = 'bad_fill';
    let closePrice = args.fillPrice;
    let feesClose = args.positionSize * (args.signal.feeRate ?? 0.00038);
    let closedAt: Date | undefined = new Date();

    try {
      const order = await this.exchange.createOrder(args.signal.symbol, 'market', side, args.contracts, undefined, { reduceOnly: true });
      closePrice = Number(order.average ?? order.price ?? closePrice);
      feesClose = Number(order.fee?.cost ?? feesClose);
    } catch (e: any) {
      status = 'open';
      closedAt = undefined;
      this.logger.error(`[LIVE] BAD FILL close failed ${args.signal.symbol}: ${e?.message}`);
    }

    const priceDiff = args.signal.direction === 'LONG'
      ? (closePrice - args.fillPrice) / args.fillPrice
      : (args.fillPrice - closePrice) / args.fillPrice;
    const pnl = status === 'bad_fill'
      ? parseFloat((args.positionSize * priceDiff - args.feesOpen - feesClose).toFixed(4))
      : null;

    const createData: any = {
      id: args.id,
      symbol: args.signal.symbol,
      direction: args.signal.direction,
      entry: parseFloat(args.fillPrice.toFixed(8)),
      stopLoss: args.stopLoss,
      takeProfit: args.takeProfit,
      leverage: args.leverage,
      marginEur: parseFloat(args.margin.toFixed(4)),
      positionSize: parseFloat(args.positionSize.toFixed(4)),
      contracts: args.contracts,
      orderId: args.orderId,
      limitOrderId: args.orderId,
      grade: args.signal.grade,
      score: args.signal.score ?? 0,
      feeRate: args.signal.feeRate ?? 0.00038,
      feesOpen: parseFloat(args.feesOpen.toFixed(6)),
      feesClose: parseFloat(feesClose.toFixed(6)),
      closePrice: parseFloat(closePrice.toFixed(8)),
      pnl,
      status,
      note: args.signal.source ? `${args.signal.source}:${args.reason}` : args.reason,
      ...(closedAt ? { closedAt } : {}),
    };
    const { id: _id, ...updateData } = createData;

    const trade = await this.prisma.liveTrade.upsert({ where: { id: args.id }, create: createData, update: updateData });
    this.logger.warn(`[LIVE] BAD FILL ${args.signal.symbol}: ${args.reason} | fill=${args.fillPrice} entry=${args.signal.entry}`);
    this.events.emitLiveTrade(trade);
  }

  async enterTrade(signal: TradeSignal): Promise<void> {
    const cfg = await this.getConfig();
    if (!cfg.enabled && !signal.bypassGlobalConfig) return;

    const gradeOrder = ['A+', 'A', 'B', 'C'];
    if (!signal.bypassGlobalConfig && gradeOrder.indexOf(signal.grade) > gradeOrder.indexOf(cfg.minGrade)) return;

    if (signal.source) {
      const sourceOpen = await this.prisma.liveTrade.count({
        where: { note: { startsWith: signal.source }, status: { in: ['open', 'pending'] } },
      });
      if (sourceOpen >= (signal.sourceMaxConcurrent ?? 1)) return;
    } else {
      const activeCount = await this.prisma.liveTrade.count({ where: { status: { in: ['open', 'pending'] } } });
      if (activeCount >= cfg.maxConcurrent) return;
    }

    const already = await this.prisma.liveTrade.findFirst({
      where: { symbol: signal.symbol, status: { in: ['open', 'pending'] } },
    });
    if (already) return;

    const id           = `live_${signal.symbol}_${Date.now()}`;
    const market       = this.markets[signal.symbol];
    const riskUsdt     = signal.riskUsdt ?? 1.0;
    const feeRate      = signal.feeRate ?? 0.00038;
    // include fees: perdita a SL = notional*slPct + notional*2*feeRate = riskUsdt
    const sizedNotional = riskUsdt / (signal.slPct / 100 + 2 * feeRate);

    // leva dinamica: usa il balance USDT attuale
    let availUsdt = 10; // fallback
    try {
      const res  = await (this.exchange as any).contractPrivateGetAccountAssets();
      const data = res?.data;
      // MEXC ritorna array di valute — cerco USDT specificamente
      let raw: any = null;
      if (Array.isArray(data)) {
        raw = data.find((d: any) => d.currency === 'USDT') ?? null;
      } else if (data && typeof data === 'object') {
        raw = data['USDT'] ?? data;
      }
      if (raw) availUsdt = Number(raw.availableBalance ?? raw.available ?? 0) || 10;
    } catch { /* usa fallback */ }
    const maxConc      = signal.sourceMaxConcurrent ?? cfg.maxConcurrent ?? 3;
    const marginBudget = Math.max(0.5, availUsdt / (maxConc + 1));
    const maxLev       = Number(market?.limits?.leverage?.max ?? 125) || 125;
    // safeLev: SL deve scattare prima della liquidazione (buffer 20%)
    const safeLev      = Math.floor(0.8 / (signal.slPct / 100));
    const leverage     = Math.max(1, Math.min(Math.ceil(sizedNotional / marginBudget), safeLev, maxLev, 100));
    const margin       = sizedNotional / leverage;
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
      let amount = sizedNotional / (signal.entry * contractSize);
      const minAmount = market?.limits?.amount?.min ?? 0;
      if (minAmount > 0 && amount < minAmount) {
        this.logger.warn(`[LIVE] ${signal.symbol}: amount ${amount.toFixed(6)} < min ${minAmount} — skip`);
        return;
      }
      amount = parseFloat(this.exchange.amountToPrecision(signal.symbol, amount));

      // setMarginMode isolated — MEXC richiede leverage come parametro aggiuntivo
      const levCacheKey = `${signal.symbol}_${signal.direction}`;
      const levCached   = this.leverageCache.get(levCacheKey);
      const levTtl      = 30 * 60 * 1000;
      if (!levCached || levCached.leverage !== leverage || Date.now() - levCached.ts > levTtl) {
        try {
          await this.exchange.setMarginMode('isolated', signal.symbol, { leverage });
          this.logger.log(`[LIVE] setMarginMode isolated ${signal.symbol} leverage=${leverage}x`);
        } catch (e: any) {
          this.logger.warn(`[LIVE] setMarginMode ${signal.symbol}: ${e?.message?.slice(0, 80)}`);
          // fallback: setLeverage con openType isolated
          try {
            await this.exchange.setLeverage(leverage, signal.symbol, {
              openType: 1,
              positionType: isLong ? 1 : 2,
            });
          } catch { /* tollerato */ }
        }
        this.leverageCache.set(levCacheKey, { leverage, ts: Date.now() });
        this.logger.log(`[LIVE] leverage ${signal.symbol} → ${leverage}x isolated`);
      } else {
        this.logger.log(`[LIVE] leverage ${signal.symbol} → ${leverage}x (cached)`);
      }

      const feesEst = sizedNotional * feeRate;
      const effectiveOrderType = 'market';

      if (effectiveOrderType === 'market') {
        // ── MARKET: entra subito, poi fetch position per positionId, poi SL/TP ──
        const order     = await this.exchange.createOrder(signal.symbol, 'market', side, amount);
        let fillPrice = Number(order.average ?? order.price ?? signal.entry);
        const openFee = Number(order.fee?.cost ?? feesEst);
        const orderId   = String(order.id ?? '');
        let liveSlPrice = parseFloat(this.exchange.priceToPrecision(
          signal.symbol,
          isLong ? fillPrice * (1 - totalSlFrac) : fillPrice * (1 + totalSlFrac),
        ));
        let liveTpPrice = parseFloat(this.exchange.priceToPrecision(
          signal.symbol,
          isLong ? fillPrice * (1 + totalTpFrac) : fillPrice * (1 - totalTpFrac),
        ));

        // Attendi posizione visibile (MEXC può avere delay ~1-2s)
        let pos: any = null;
        for (let attempt = 0; attempt < 12; attempt++) {
          await new Promise(r => setTimeout(r, 250));
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
        const positionEntry = Number(pos?.entryPrice ?? pos?.info?.openAvgPrice ?? 0);
        if (Number.isFinite(positionEntry) && positionEntry > 0) {
          fillPrice = positionEntry;
          liveSlPrice = parseFloat(this.exchange.priceToPrecision(
            signal.symbol,
            isLong ? fillPrice * (1 - totalSlFrac) : fillPrice * (1 + totalSlFrac),
          ));
          liveTpPrice = parseFloat(this.exchange.priceToPrecision(
            signal.symbol,
            isLong ? fillPrice * (1 + totalTpFrac) : fillPrice * (1 - totalTpFrac),
          ));
        }

        if (!positionId) {
          this.logger.warn(`[LIVE] positionId non trovato per ${signal.symbol} — SL/TP non piazzati`);
          await this.closeRejectedFill({
            id, signal, fillPrice,
            stopLoss: liveSlPrice, takeProfit: liveTpPrice,
            leverage, margin, positionSize: sizedNotional,
            contracts: posVol, orderId, feesOpen: openFee,
            reason: 'position_id_missing',
          });
          return;
        }

        // Piazza SL/TP nativi con positionId
        const fillGuard = this.validateTriggerFill(signal, fillPrice, liveSlPrice, liveTpPrice);
        if (!fillGuard.ok) {
          await this.closeRejectedFill({
            id, signal, fillPrice,
            stopLoss: liveSlPrice, takeProfit: liveTpPrice,
            leverage, margin, positionSize: sizedNotional,
            contracts: posVol, orderId, feesOpen: openFee,
            reason: fillGuard.reason,
          });
          return;
        }

        let slOrderId: string | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          const extraBuf = attempt * 0.002;
          const retrySL  = isLong
            ? parseFloat(this.exchange.priceToPrecision(signal.symbol, liveSlPrice * (1 - extraBuf)))
            : parseFloat(this.exchange.priceToPrecision(signal.symbol, liveSlPrice * (1 + extraBuf)));
          try {
            const res: any = await (this.exchange as any).contractPrivatePostStoporderPlace({
              symbol:          mexcSymbol,
              positionId,
              vol:             posVol,
              stopLossPrice:   attempt === 0 ? liveSlPrice : retrySL,
              takeProfitPrice: liveTpPrice,
            });
            slOrderId = String(res?.data ?? '');
            this.logger.log(`[LIVE] MARKET ${side.toUpperCase()} ${signal.symbol} @ ${fillPrice} | SL ${liveSlPrice} | TP ${liveTpPrice} | posId ${positionId} | stopOrderId ${slOrderId}`);
            break;
          } catch (e: any) {
            if (attempt < 2) await new Promise(r => setTimeout(r, 800));
            else this.logger.warn(`[LIVE] SL/TP failed market ${signal.symbol}: ${e?.message?.slice(0, 100)}`);
          }
        }
        if (!slOrderId) {
          await this.closeRejectedFill({
            id, signal, fillPrice,
            stopLoss: liveSlPrice, takeProfit: liveTpPrice,
            leverage, margin, positionSize: sizedNotional,
            contracts: posVol, orderId, feesOpen: openFee,
            reason: 'protection_failed',
          });
          return;
        }

        const trade = await this.prisma.liveTrade.create({
          data: {
            id, symbol: signal.symbol, direction: signal.direction,
            entry: parseFloat(fillPrice.toFixed(8)), stopLoss: liveSlPrice, takeProfit: liveTpPrice,
            leverage, marginEur: parseFloat(margin.toFixed(4)),
            positionSize: parseFloat(sizedNotional.toFixed(4)), contracts: posVol,
            orderId, slOrderId, tpOrderId: slOrderId,
            grade: signal.grade, score: signal.score ?? 0,
            feeRate,
            feesOpen: parseFloat(openFee.toFixed(6)), status: 'open',
            ...(signal.source ? { note: signal.source } : {}),
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
          { timeInForce: 'IOC', stopLossPrice: slPrice, takeProfitPrice: tpPrice },
        );
        this.logger.log(`[LIVE] order.id=${JSON.stringify(order.id)} info=${JSON.stringify(order.info)}`);
        const rawId        = order.info?.data ?? order.info?.orderId ?? order.info?.order_id ?? order.id;
        const limitOrderId = rawId != null && typeof rawId !== 'object' ? String(rawId) : String(order.id ?? '');

        const trade = await this.prisma.liveTrade.create({
          data: {
            id, symbol: signal.symbol, direction: signal.direction,
            entry: limitPrice, stopLoss: slPrice, takeProfit: tpPrice,
            leverage, marginEur: parseFloat(margin.toFixed(4)),
            positionSize: parseFloat(sizedNotional.toFixed(4)), contracts: amount,
            limitOrderId, orderId: limitOrderId,
            grade: signal.grade, score: signal.score ?? 0,
            feeRate,
            feesOpen: parseFloat(feesEst.toFixed(6)), status: 'pending',
            ...(signal.source ? { note: signal.source } : {}),
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
          leverage, marginEur: parseFloat(margin.toFixed(4)),
          positionSize: parseFloat(sizedNotional.toFixed(4)),
          contracts: 0, grade: signal.grade, score: signal.score ?? 0,
          feeRate,
          status: 'error', note: signal.source ? `${signal.source}:${e?.message?.slice(0, 180)}` : e?.message?.slice(0, 200),
        },
      });
    }
  }

  // ─── Check pending limit orders ogni 15s ──────────────────────────────────────

  @Cron('*/5 * * * * *')
  async checkPendingOrders() {
    const pending = await this.prisma.liveTrade.findMany({ where: { status: 'pending' } });
    if (!pending.length) return;

    for (const trade of pending) {
      const age        = Date.now() - new Date(trade.openedAt).getTime();
      const mexcSymbol = this.markets[trade.symbol]?.id ?? trade.symbol.split('/')[0] + '_USDT';

      // Scaduto dopo 5 minuti → cancella ordine e marca expired
      if (false && age > 10 * 60 * 1000) {
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
        if (!pos) {
          if (age > MAX_TRIGGER_FILL_MS) {
            if (trade.limitOrderId) {
              try { await this.exchange.cancelOrder(trade.limitOrderId, trade.symbol); }
              catch (e: any) { this.logger.warn(`[LIVE] Cancel ${trade.symbol}: ${e?.message?.slice(0, 80)}`); }
            }
            const expired = await this.prisma.liveTrade.update({
              where: { id: trade.id },
              data: { status: 'expired', closedAt: new Date(), note: `no_fill_${MAX_TRIGGER_FILL_MS / 1000}s` },
            });
            this.events.emitLiveTrade(expired);
          }
          continue;
        }

        const posVol     = Math.abs(Number(pos.contracts ?? trade.contracts));
        const fillPrice  = Number(pos.entryPrice ?? pos.info?.openAvgPrice ?? trade.entry);
        const positionId = pos.info?.positionId;

        const signal: TradeSignal = {
          symbol: trade.symbol,
          direction: trade.direction as 'LONG' | 'SHORT',
          grade: trade.grade,
          entry: trade.entry,
          slPct: Math.abs((trade.entry - trade.stopLoss) / trade.entry * 100),
          tp1Pct: Math.abs((trade.takeProfit - trade.entry) / trade.entry * 100),
          suggestedLeverage: trade.leverage,
          score: trade.score,
        };
        const fillGuard = age <= MAX_TRIGGER_FILL_MS
          ? this.validateTriggerFill(signal, fillPrice, trade.stopLoss, trade.takeProfit)
          : { ok: false, reason: `late_fill_${Math.round(age / 1000)}s` };
        if (!fillGuard.ok) {
          await this.closeRejectedFill({
            id: trade.id, signal, fillPrice,
            stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
            leverage: trade.leverage, margin: trade.marginEur,
            positionSize: trade.positionSize, contracts: posVol,
            orderId: trade.limitOrderId ?? trade.orderId ?? undefined,
            feesOpen: trade.feesOpen ?? trade.positionSize * this.feeRateForTrade(trade),
            reason: fillGuard.reason,
          });
          continue;
        }

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
        continue; // RR fisso: SL/TP nativi restano quelli iniziali.
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
          feesClose           = parseFloat((trade.positionSize * this.feeRateForTrade(trade)).toFixed(6));
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
      const fc = feesClose ?? (trade.positionSize * this.feeRateForTrade(trade));
      pnl       = parseFloat((trade.positionSize * priceDiff - (trade.feesOpen ?? 0) - fc).toFixed(4));
      feesClose = parseFloat((feesClose ?? (trade.positionSize * this.feeRateForTrade(trade))).toFixed(6));
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
      const actualFee  = Number(order.fee?.cost ?? (trade.positionSize * this.feeRateForTrade(trade)));
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
