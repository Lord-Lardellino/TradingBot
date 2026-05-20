import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SolScannerService } from './sol-scanner.service';

@Controller('sol-scanner')
export class SolScannerController {
  constructor(private svc: SolScannerService) {}

  @Get('signals')
  getSignals(@Query('limit') limit?: string) {
    return this.svc.getRecentSignals(limit ? parseInt(limit) : 50);
  }

  @Get('status')
  getStatus() { return this.svc.getStatus(); }

  @Get('analytics')
  getAnalytics() { return this.svc.getAnalytics(); }

  @Get('trades/open')
  getOpenTrades() { return this.svc.getOpenTrades(); }

  @Get('trades/closed')
  getClosedTrades(@Query('limit') limit?: string) {
    return this.svc.getClosedTrades(limit ? parseInt(limit) : 100);
  }

  @Post('config')
  updateConfig(@Body() body: any) { return this.svc.updateConfig(body); }

  @Post('reset')
  reset() { return this.svc.resetSim(); }

  @Post('close/:id')
  closeManual(@Param('id') id: string) { return this.svc.closeManual(id); }
}
