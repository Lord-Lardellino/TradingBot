import { Controller, Get, Put, Post, Body, Param, Query } from '@nestjs/common';
import { LiveService } from './live.service';
import { LiveTradingService } from './live-trading.service';

@Controller('live')
export class LiveController {
  constructor(
    private live: LiveService,
    private liveTrading: LiveTradingService,
  ) {}

  @Get('debug-raw')
  debugRaw() { return this.live.getRawBalance(); }

  // ── Read-only account & positions ─────────────────────────────────────────

  @Get('account')
  account() { return this.live.getAccount(); }

  @Get('positions')
  positions() { return this.live.getPositions(); }

  @Get('orders')
  orders() { return this.live.getOrders(); }

  // ── Live trading ──────────────────────────────────────────────────────────

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.liveTrading.getTrades(limit ? parseInt(limit) : 100);
  }

  @Get('analytics')
  analytics() { return this.liveTrading.getAnalytics(); }

  @Get('config')
  config() { return this.liveTrading.getConfig(); }

  @Put('config')
  updateConfig(@Body() body: any) { return this.liveTrading.updateConfig(body); }

  @Post('close/:id')
  closeManual(@Param('id') id: string) { return this.liveTrading.closeManual(id); }
}
