import { Controller, Get, Patch, Post, Body, Query } from '@nestjs/common';
import { InstScanner15mService } from './inst-scanner-15m.service';

@Controller('inst-scanner-15m')
export class InstScanner15mController {
  constructor(private readonly svc: InstScanner15mService) {}

  @Get('analytics')
  getAnalytics() { return this.svc.getAnalytics(); }

  @Get('trades')
  getTrades(@Query('limit') limit?: string) {
    return this.svc.getTrades(limit ? parseInt(limit) : 100);
  }

  @Patch('config')
  updateConfig(@Body() body: any) { return this.svc.updateConfig(body); }

  @Post('reset')
  reset() { return this.svc.resetSim(); }
}
