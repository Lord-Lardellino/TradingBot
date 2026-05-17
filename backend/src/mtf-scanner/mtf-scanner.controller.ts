import { Controller, Get, Post, Body, Query, Param } from '@nestjs/common';
import { MtfScannerService } from './mtf-scanner.service';

const VALID_TFS = ['5m', '15m', '1h'];
const validateTf = (tf: string) => VALID_TFS.includes(tf) ? tf : '5m';

@Controller('mtf-scanner')
export class MtfScannerController {
  constructor(private readonly svc: MtfScannerService) {}

  @Get('signals')
  getSignals(@Query('tf') tf: string, @Query('limit') limit?: string) {
    return this.svc.getRecentSignals(validateTf(tf), limit ? parseInt(limit) : 50);
  }

  @Get('status')
  getStatus(@Query('tf') tf: string) {
    return this.svc.getStatus(validateTf(tf));
  }

  @Get('debug')
  getDebug(@Query('tf') tf: string) {
    return this.svc.getDebug(validateTf(tf));
  }

  @Get('analytics')
  getAnalytics(@Query('tf') tf: string) {
    return this.svc.getAnalytics(validateTf(tf));
  }

  @Get('trades/open')
  getOpenTrades(@Query('tf') tf: string) {
    return this.svc.getOpenTrades(validateTf(tf));
  }

  @Get('trades/closed')
  getClosedTrades(@Query('tf') tf: string, @Query('limit') limit?: string) {
    return this.svc.getClosedTrades(validateTf(tf), limit ? parseInt(limit) : 100);
  }

  @Get('config')
  getConfig(@Query('tf') tf: string) {
    return this.svc.getSimConfig(validateTf(tf));
  }

  @Post('config')
  updateConfig(@Query('tf') tf: string, @Body() body: any) {
    return this.svc.updateSimConfig(validateTf(tf), body);
  }

  @Post('reset')
  reset(@Query('tf') tf: string) {
    return this.svc.resetSim(validateTf(tf));
  }

  @Post('close/:id')
  closeManual(@Param('id') id: string) {
    return this.svc.closeManual(id);
  }
}
