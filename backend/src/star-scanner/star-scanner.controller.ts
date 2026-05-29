import { Controller, Get, Post, Patch, Body, Param, Query } from '@nestjs/common';
import { StarScannerService } from './star-scanner.service';

@Controller('star-scanner')
export class StarScannerController {
  constructor(private readonly svc: StarScannerService) {}

  @Get('analytics')          getAnalytics()                                      { return this.svc.getAnalytics(); }
  @Get('signals')            getSignals()                                        { return this.svc.getSignals(); }
  @Get('status')             getStatus()                                         { return this.svc.getStatus(); }
  @Get('candles/:symbol')    getCandles(@Param('symbol') sym: string, @Query('limit') limit?: string, @Query('from') from?: string, @Query('live') live?: string) {
    return this.svc.getCandles(sym, limit ? Number(limit) : 120, from ? Number(from) : undefined, live === '1');
  }
  @Patch('config')           updateConfig(@Body() b: any)                       { return this.svc.updateConfig(b); }
  @Post('reset')             resetSim()                                          { return this.svc.resetSim(); }
}
