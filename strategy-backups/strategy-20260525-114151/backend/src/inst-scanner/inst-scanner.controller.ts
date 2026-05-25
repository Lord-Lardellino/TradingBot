import { Controller, Get, Patch, Post, Body, Query } from '@nestjs/common';
import { InstScannerService } from './inst-scanner.service';

@Controller('inst-scanner')
export class InstScannerController {
  constructor(private readonly svc: InstScannerService) {}

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
