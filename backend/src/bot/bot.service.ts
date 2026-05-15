import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MexcService } from '../mexc/mexc.service';
import { IndicatorsService } from '../indicators/indicators.service';
import { ScalpingStrategy } from '../strategies/scalping.strategy';
import { PumpStrategy } from '../strategies/pump.strategy';
import { EventsGateway } from '../events/events.gateway';
import { CreateBotDto, UpdateBotDto } from './dto/create-bot.dto';

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  // Track open positions per bot: botId → { side, entryPrice, quantity, tradeId }
  private openPositions = new Map<number, any>();

  constructor(
    private prisma: PrismaService,
    private mexc: MexcService,
    private indicators: IndicatorsService,
    private scalping: ScalpingStrategy,
    private pump: PumpStrategy,
    private events: EventsGateway,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────────────────────

  async findAll() {
    return this.prisma.bot.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { trades: true, signals: true } },
      },
    });
  }

  async findOne(id: number) {
    const bot = await this.prisma.bot.findUnique({
      where: { id },
      include: { trades: { take: 10, orderBy: { openedAt: 'desc' } }, signals: { take: 20, orderBy: { createdAt: 'desc' } } },
    });
    if (!bot) throw new NotFoundException(`Bot #${id} not found`);
    return bot;
  }

  async create(dto: CreateBotDto) {
    return this.prisma.bot.create({
      data: {
        name: dto.name,
        strategy: dto.strategy,
        symbol: dto.symbol,
        timeframe: dto.timeframe,
        testMode: dto.testMode ?? true,
        config: JSON.stringify(dto.config ?? {}),
        status: 'stopped',
      },
    });
  }

  async update(id: number, dto: UpdateBotDto) {
    await this.findOne(id);
    return this.prisma.bot.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.symbol && { symbol: dto.symbol }),
        ...(dto.timeframe && { timeframe: dto.timeframe }),
        ...(dto.testMode !== undefined && { testMode: dto.testMode }),
        ...(dto.config && { config: JSON.stringify(dto.config) }),
      },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    this.openPositions.delete(id);
    return this.prisma.bot.delete({ where: { id } });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async start(id: number) {
    const bot = await this.findOne(id);
    if (bot.status === 'running') return bot;
    const updated = await this.prisma.bot.update({
      where: { id },
      data: { status: 'running' },
    });
    this.events.emitBotStatus(id, 'running');
    this.logger.log(`Bot #${id} "${bot.name}" started`);
    return updated;
  }

  async stop(id: number) {
    const bot = await this.findOne(id);
    const updated = await this.prisma.bot.update({
      where: { id },
      data: { status: 'stopped' },
    });
    this.openPositions.delete(id);
    this.events.emitBotStatus(id, 'stopped');
    this.logger.log(`Bot #${id} "${bot.name}" stopped`);
    return updated;
  }

  // ─── Main scheduler — runs every 30 seconds ───────────────────────────────

  @Cron('*/30 * * * * *')
  async tick() {
    const runningBots = await this.prisma.bot.findMany({
      where: { status: 'running' },
    });

    for (const bot of runningBots) {
      try {
        await this.processBotTick(bot);
      } catch (err) {
        this.logger.error(`Bot #${bot.id} tick error: ${err.message}`);
      }
    }
  }

  // ─── Per-bot tick ─────────────────────────────────────────────────────────

  private async processBotTick(bot: any) {
    const ohlcv = await this.mexc.getOHLCV(bot.symbol, bot.timeframe, 100);
    if (!ohlcv.length) return;

    const ticker = await this.mexc.getTicker(bot.symbol);
    if (ticker) this.events.emitPrice(bot.symbol, ticker.last, ticker.percentage);

    const config = JSON.parse(bot.config || '{}');

    if (bot.strategy === 'scalping') {
      await this.handleScalping(bot, ohlcv, config);
    } else if (bot.strategy === 'pump') {
      await this.handlePump(bot, ohlcv, config);
    }
  }

  private async handleScalping(bot: any, ohlcv: any[], config: any) {
    const indResult = this.indicators.computeAll(ohlcv);
    if (!indResult) return;

    const position = this.openPositions.get(bot.id);
    const signal = this.scalping.evaluate(
      indResult,
      position?.side === 'BUY',
      position?.side === 'SELL',
      config,
    );

    if (signal.type === 'HOLD') return;

    await this.saveSignal(bot.id, bot.symbol, signal.type, indResult, signal.reason);

    // Execute or paper-trade
    if (signal.type === 'BUY' || signal.type === 'SELL') {
      await this.openTrade(bot, signal, indResult.close);
    } else if (signal.type === 'CLOSE_LONG' || signal.type === 'CLOSE_SHORT') {
      await this.closeTrade(bot, indResult.close);
    }
  }

  private async handlePump(bot: any, ohlcv: any[], config: any) {
    const pumpSignal = this.pump.evaluate(ohlcv, config);
    if (pumpSignal.type === 'NEUTRAL') return;

    const ind = this.indicators.computeAll(ohlcv);
    await this.saveSignal(bot.id, bot.symbol, pumpSignal.type, ind, pumpSignal.reason, {
      volumeRatio: pumpSignal.volumeRatio,
    });

    const position = this.openPositions.get(bot.id);
    if (!position && pumpSignal.type === 'PUMP') {
      await this.openTrade(bot, { type: 'BUY', stopLoss: pumpSignal.stopLoss, takeProfit: pumpSignal.takeProfit }, pumpSignal.price);
    }
  }

  private async openTrade(bot: any, signal: any, currentPrice: number) {
    const settings = await this.prisma.settings.findUnique({ where: { id: 1 } });
    const stakeAmount = settings?.stakeAmount ?? 10;
    const quantity = stakeAmount / currentPrice;

    const order = await this.mexc.placeMarketOrder(
      bot.symbol,
      signal.type === 'BUY' ? 'buy' : 'sell',
      quantity,
    );
    if (!order) return;

    const actualPrice = order.price || currentPrice;
    const trade = await this.prisma.trade.create({
      data: {
        botId: bot.id,
        symbol: bot.symbol,
        side: signal.type === 'BUY' ? 'BUY' : 'SELL',
        quantity,
        entryPrice: actualPrice,
        total: quantity * actualPrice,
        status: 'open',
        orderId: order.id,
      },
    });

    this.openPositions.set(bot.id, { side: signal.type, entryPrice: actualPrice, quantity, tradeId: trade.id });
    this.events.emitTrade(bot.id, { ...trade, event: 'opened' });
    this.logger.log(`Bot #${bot.id}: opened ${signal.type} @ ${actualPrice}`);
  }

  private async closeTrade(bot: any, currentPrice: number) {
    const position = this.openPositions.get(bot.id);
    if (!position) return;

    const closeSide = position.side === 'BUY' ? 'sell' : 'buy';
    await this.mexc.placeMarketOrder(bot.symbol, closeSide, position.quantity);

    const pnl =
      position.side === 'BUY'
        ? (currentPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - currentPrice) * position.quantity;
    const pnlPct = (pnl / (position.entryPrice * position.quantity)) * 100;

    const trade = await this.prisma.trade.update({
      where: { id: position.tradeId },
      data: { exitPrice: currentPrice, pnl, pnlPct, status: 'closed', closedAt: new Date() },
    });

    this.openPositions.delete(bot.id);
    this.events.emitTrade(bot.id, { ...trade, event: 'closed' });
    this.logger.log(`Bot #${bot.id}: closed trade. PnL: ${pnl.toFixed(4)} (${pnlPct.toFixed(2)}%)`);
  }

  private async saveSignal(
    botId: number,
    symbol: string,
    type: string,
    ind: any,
    reason: string,
    extra: any = {},
  ) {
    const signal = await this.prisma.signal.create({
      data: {
        botId,
        symbol,
        type,
        price: ind?.close ?? 0,
        rsi: ind?.rsi,
        macd: ind?.macd,
        macdSignal: ind?.macdSignal,
        histogram: ind?.macdHistogram,
        ema9: ind?.ema9,
        ema21: ind?.ema21,
        bbUpper: ind?.bbUpper,
        bbLower: ind?.bbLower,
        volume: ind?.volume,
        volumeRatio: extra.volumeRatio ?? ind?.volumeRatio,
        executed: true,
      },
    });
    this.events.emitSignal(botId, { ...signal, reason });
  }

  async getStats(id: number) {
    const trades = await this.prisma.trade.findMany({
      where: { botId: id, status: 'closed' },
    });
    const totalTrades = trades.length;
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    return { totalTrades, wins, losses: totalTrades - wins, totalPnl, winRate };
  }
}
