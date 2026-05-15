import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TradesService } from '../trades/trades.service';
import { MexcService } from '../mexc/mexc.service';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private prisma: PrismaService,
    private trades: TradesService,
    private mexc: MexcService,
  ) {}

  @Get()
  async summary() {
    const [tradeSummary, botsCount, signalsToday, balance] = await Promise.all([
      this.trades.summary(),
      this.prisma.bot.groupBy({ by: ['status'], _count: true }),
      this.prisma.signal.count({
        where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
      this.mexc.getBalance(),
    ]);

    const botStatusMap = botsCount.reduce((acc, b) => {
      acc[b.status] = b._count;
      return acc;
    }, {} as Record<string, number>);

    return {
      bots: {
        total: Object.values(botStatusMap).reduce((a, b) => a + b, 0),
        running: botStatusMap['running'] ?? 0,
        stopped: botStatusMap['stopped'] ?? 0,
      },
      trades: tradeSummary,
      signalsToday,
      balance,
    };
  }

  @Get('pnl-chart')
  async pnlChart() {
    const trades = await this.prisma.trade.findMany({
      where: { status: 'closed' },
      orderBy: { closedAt: 'asc' },
      select: { closedAt: true, pnl: true, pnlPct: true, symbol: true },
      take: 200,
    });

    let cumulative = 0;
    return trades.map((t) => {
      cumulative += t.pnl ?? 0;
      return {
        date: t.closedAt,
        pnl: t.pnl,
        cumulative: parseFloat(cumulative.toFixed(4)),
        symbol: t.symbol,
      };
    });
  }
}
