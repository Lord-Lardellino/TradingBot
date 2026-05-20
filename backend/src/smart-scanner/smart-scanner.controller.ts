import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { SmartScannerService } from './smart-scanner.service';

@Controller('smart-scanner')
export class SmartScannerController {
  constructor(private svc: SmartScannerService) {}

  @Get('signals')  signals(@Query('limit') limit?: string) { return this.svc.getRecentSignals(limit ? +limit : 100); }
  @Get('status')   status()    { return this.svc.getStatus(); }
  @Get('debug')    debug()     { return this.svc.getDebug(); }
  @Get('analytics') analytics() { return this.svc.getAnalytics(); }
  @Get('trades/open')   openTrades()  { return this.svc.getOpenTrades(); }
  @Get('trades/closed') closedTrades(@Query('limit') limit?: string) { return this.svc.getClosedTrades(limit ? +limit : 200); }
  @Get('opt-logs') optLogs() { return this.svc.getOptLogs(); }

  @Post('config')   updateConfig(@Body() body: any)  { return this.svc.updateConfig(body); }
  @Post('reset')    reset()    { return this.svc.resetSim(); }
  @Post('optimize') optimize() { return this.svc.triggerOptimize(); }
}
