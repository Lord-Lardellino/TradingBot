import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SignalsService {
  constructor(private prisma: PrismaService) {}

  async findAll(botId?: number, type?: string, limit = 100) {
    return this.prisma.signal.findMany({
      where: {
        ...(botId && { botId }),
        ...(type && { type }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { bot: { select: { name: true, strategy: true } } },
    });
  }

  async countByType(botId?: number) {
    const signals = await this.prisma.signal.findMany({
      where: botId ? { botId } : undefined,
      select: { type: true },
    });
    return signals.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }
}
