import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TradesService {
  constructor(private prisma: PrismaService) {}

  async findAll(botId?: number, status?: string, limit = 50) {
    return this.prisma.trade.findMany({
      where: {
        ...(botId && { botId }),
        ...(status && { status }),
      },
      orderBy: { openedAt: 'desc' },
      take: limit,
      include: { bot: { select: { name: true, strategy: true } } },
    });
  }

  async findOne(id: number) {
    return this.prisma.trade.findUnique({ where: { id } });
  }

  async summary() {
    const trades = await this.prisma.trade.findMany({ where: { status: 'closed' } });
    const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;
    const losses = trades.filter((t) => (t.pnl ?? 0) < 0).length;
    const openTrades = await this.prisma.trade.count({ where: { status: 'open' } });
    return {
      totalTrades: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      totalPnl,
      openTrades,
    };
  }
}
