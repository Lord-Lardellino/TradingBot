import { Controller, Get, Put, Post, Delete, Body, Param, Query } from '@nestjs/common';
import { SimulationService } from './simulation.service';

@Controller('simulation')
export class SimulationController {
  constructor(private sim: SimulationService) {}

  @Get('analytics')
  analytics() {
    return this.sim.getAnalytics();
  }

  @Get('trades')
  trades(@Query('limit') limit?: string) {
    return this.sim.getTrades(limit ? parseInt(limit) : 100);
  }

  @Get('config')
  config() {
    return this.sim.getConfig();
  }

  @Put('config')
  updateConfig(@Body() body: any) {
    return this.sim.updateConfig(body);
  }

  @Post('reset')
  reset() {
    return this.sim.resetSimulation();
  }

  @Post('sync-capital')
  syncCapital() {
    return this.sim.syncStartingCapital(true);
  }

  @Post('close/:id')
  closeManual(@Param('id') id: string) {
    return this.sim.closeManual(id);
  }
}
