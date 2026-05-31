import { Controller, Get, Post, Patch, Query, Body } from '@nestjs/common';
import { FundingArbService } from './funding-arb.service';

@Controller('funding-arb')
export class FundingArbController {
  constructor(private readonly svc: FundingArbService) {}

  @Get('dashboard')  getDashboard()                                      { return this.svc.getDashboard(); }
  @Get('rates')      getRates(@Query('limit') l?: string)               { return this.svc.getTopRates(l ? Number(l) : 50); }
  @Get('positive')   getPositive()                                       { return this.svc.getPositiveRates(); }
  @Get('negative')   getNegative()                                       { return this.svc.getNegativeRates(); }
  @Get('status')     getStatus()                                         { return this.svc.getStatus(); }
  @Get('config')     getConfig()                                         { return this.svc.getConfig(); }
  @Get('positions')  getPositions()                                      { return this.svc.getPositions(); }
  @Get('analytics')  getAnalytics()                                      { return this.svc.getAnalytics(); }
  @Get('equity')     getEquity()                                         { return this.svc.getEquity(); }
  @Get('projection') getProjection(@Query('symbol') sym: string, @Query('capital') cap: string, @Query('leverage') lev?: string) {
    return this.svc.calcProjection(sym, Number(cap || 100), Number(lev || 1));
  }
  @Post('enter')            enterPosition(@Body() b: any) { return this.svc.enterPosition(b.symbol, b.capitalUsdt, b.leverage); }
  @Patch('config')          updateConfig(@Body() b: any) { return this.svc.updateConfig(b); }
  @Post('close-all-spot')   closeAllSpot() { return this.svc.closeAllSpot(); }
  @Post('close-all-futures') closeAllFutures() { return this.svc.closeAllFutures(); }
  @Post('reset-all')        resetAll() { return this.svc.resetAll(); }
  @Post('clean-history')    cleanHistory() { return this.svc.cleanHistory(); }
  @Post('set-baseline')     setBaseline() { return this.svc.setBaseline(); }
}
