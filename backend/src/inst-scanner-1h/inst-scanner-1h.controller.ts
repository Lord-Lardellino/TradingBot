import { Controller, Get, Patch, Post, Body, Query } from '@nestjs/common';
import { InstScanner1hService } from './inst-scanner-1h.service';

@Controller('inst-scanner-1h')
export class InstScanner1hController {
  constructor(private readonly svc: InstScanner1hService) {}

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
