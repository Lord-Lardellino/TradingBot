import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { FibScannerService } from './fib-scanner.service';

@Controller('fib-scanner')
export class FibScannerController {
  constructor(private readonly svc: FibScannerService) {}

  @Get('analytics')        getAnalytics()                              { return this.svc.getAnalytics(); }
  @Get('signals')          getSignals(@Query('limit') l?: string)      { return this.svc.getSignals(l ? +l : 100); }
  @Get('status')           getStatus()                                 { return this.svc.getStatus(); }
  @Get('trades')           getTrades(@Query('limit') l?: string)       { return this.svc.getTrades(l ? +l : 200); }
  @Get('candles/:symbol')  getCandles(@Param('symbol') sym: string, @Query('limit') l?: string) {
    return this.svc.getCandles(decodeURIComponent(sym), l ? +l : 120);
  }
  @Patch('config')  updateConfig(@Body() body: any) { return this.svc.updateConfig(body); }
  @Post('reset')    reset()                         { return this.svc.resetSim(); }
}
