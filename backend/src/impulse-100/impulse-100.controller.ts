import { Body, Controller, Get, Patch, Post, Query } from '@nestjs/common';
import { Impulse100Service } from './impulse-100.service';

@Controller('impulse-100')
export class Impulse100Controller {
  constructor(private readonly svc: Impulse100Service) {}

  @Get('analytics')
  getAnalytics() {
    return this.svc.getAnalytics();
  }

  @Get('signals')
  getSignals(@Query('limit') limit?: string) {
    return this.svc.getSignals(limit ? parseInt(limit) : 100);
  }

  @Get('status')
  getStatus() {
    return this.svc.getStatus();
  }

  @Get('trades')
  getTrades(@Query('limit') limit?: string) {
    return this.svc.getTrades(limit ? parseInt(limit) : 200);
  }

  @Patch('config')
  updateConfig(@Body() body: any) {
    return this.svc.updateConfig(body);
  }

  @Post('reset')
  reset() {
    return this.svc.resetSim();
  }
}
