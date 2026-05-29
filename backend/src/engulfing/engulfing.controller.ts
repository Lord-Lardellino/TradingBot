import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EngulfingService } from './engulfing.service';

@Controller('engulfing')
export class EngulfingController {
  constructor(private readonly svc: EngulfingService) {}

  @Get('analytics')
  getAnalytics() { return this.svc.getAnalytics(); }

  @Get('signals')
  getSignals(@Query('limit') limit?: string) {
    return this.svc.getSignals(limit ? parseInt(limit) : 100);
  }

  @Get('status')
  getStatus() { return this.svc.getStatus(); }

  @Get('trades')
  getTrades(@Query('limit') limit?: string) {
    return this.svc.getTrades(limit ? parseInt(limit) : 200);
  }

  @Get('candles/:symbol')
  getCandles(@Param('symbol') sym: string, @Query('limit') l?: string) {
    return this.svc.getCandles(decodeURIComponent(sym), l ? +l : 120);
  }

  @Patch('config')
  updateConfig(@Body() body: any) { return this.svc.updateConfig(body); }

  @Post('reset')
  reset() { return this.svc.resetSim(); }
}
