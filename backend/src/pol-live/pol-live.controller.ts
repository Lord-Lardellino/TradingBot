import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { PolLiveService } from './pol-live.service';

@Controller('pol-live')
export class PolLiveController {
  constructor(private readonly svc: PolLiveService) {}

  @Get('status')
  getStatus() {
    return this.svc.getStatus();
  }

  @Get('signals')
  getSignals(@Query('limit') limit?: string) {
    return this.svc.getSignals(limit ? parseInt(limit) : 50);
  }

  @Get('trades')
  getTrades(@Query('limit') limit?: string) {
    return this.svc.getTrades(limit ? parseInt(limit) : 100);
  }

  @Get('analytics')
  getAnalytics() {
    return this.svc.getAnalytics();
  }

  @Get('candles/:symbol')
  getCandles(@Param('symbol') sym: string, @Query('limit') l?: string) {
    return this.svc.getCandles(decodeURIComponent(sym), l ? +l : 120);
  }

  @Patch('config')
  updateConfig(@Body() body: any) {
    return this.svc.updateConfig(body);
  }
}
