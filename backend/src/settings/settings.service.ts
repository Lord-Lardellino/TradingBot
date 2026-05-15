import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SettingsService {
  constructor(private prisma: PrismaService) {}

  async get() {
    let settings = await this.prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings) {
      settings = await this.prisma.settings.create({
        data: {
          id: 1,
          apiKey: '',
          apiSecret: '',
          testMode: true,
          maxOpenTrades: 3,
          stakeAmount: 10,
          stopLossPct: 0.5,
          takeProfitPct: 1.0,
        },
      });
    }
    // Mask API secret in response
    return { ...settings, apiSecret: settings.apiSecret ? '••••••••' : '' };
  }

  async update(data: Partial<{
    apiKey: string;
    apiSecret: string;
    testMode: boolean;
    maxOpenTrades: number;
    stakeAmount: number;
    stopLossPct: number;
    takeProfitPct: number;
  }>) {
    return this.prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1, ...data } as any,
      update: data,
    });
  }
}
