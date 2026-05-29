import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Ema34ScannerService } from './ema34-scanner.service';

@Controller('ema34-scanner')
export class Ema34ScannerController {
  constructor(private readonly svc: Ema34ScannerService) {}

  @Get('analytics')        getAnalytics()                              { return this.svc.getAnalytics(); }
  @Get('signals')          getSignals(@Query('limit') l?: string)      { return this.svc.getSignals(l ? +l : 100); }
  @Get('status')           getStatus()                                 { return this.svc.getStatus(); }
  @Get('trades')           getTrades(@Query('limit') l?: string)       { return this.svc.getTrades(l ? +l : 200); }
  @Get('candles/:symbol')  getCandles(
    @Param('symbol') sym: string,
    @Query('limit') l?: string,
    @Query('from') from?: string,
    @Query('live') live?: string,
  ) {
    return this.svc.getCandles(
      decodeURIComponent(sym),
      l ? +l : 120,
      from ? +from : undefined,
      live === '1' || live === 'true',
    );
  }
  @Patch('config')  updateConfig(@Body() body: any) { return this.svc.updateConfig(body); }
  @Post('reset')    reset()                         { return this.svc.resetSim(); }
}
