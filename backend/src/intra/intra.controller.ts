import { Controller, Get, Put, Post, Body, Param, Query } from '@nestjs/common';
import { IntraScannerService } from './intra-scanner.service';
import { IntraSimulationService } from './intra-simulation.service';

@Controller('intra')
export class IntraController {
  constructor(
    private scanner: IntraScannerService,
    private simulation: IntraSimulationService,
  ) {}

  @Get('signals')
  getSignals(@Query('limit') limit?: string) {
    return this.scanner.getRecentSignals(limit ? parseInt(limit) : 50);
  }

  @Get('status')
  getStatus() {
    return this.scanner.getStatus();
  }

  @Get('analytics')
  analytics() {
    return this.simulation.getAnalytics();
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.simulation.getTrades(limit ? parseInt(limit) : 100);
  }

  @Get('config')
  config() {
    return this.simulation.getConfig();
  }

  @Put('config')
  updateConfig(@Body() body: any) {
    return this.simulation.updateConfig(body);
  }

  @Post('reset')
  reset() {
    return this.simulation.resetSimulation();
  }

  @Post('sync-capital')
  syncCapital() {
    return this.simulation.syncStartingCapital(true);
  }

  @Post('close/:id')
  closeManual(@Param('id') id: string) {
    return this.simulation.closeManual(id);
  }
}
