import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { TradesService } from './trades.service';

@Controller('trades')
export class TradesController {
  constructor(private tradesService: TradesService) {}

  @Get()
  findAll(
    @Query('botId') botId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.tradesService.findAll(
      botId ? parseInt(botId) : undefined,
      status,
      limit ? parseInt(limit) : 50,
    );
  }

  @Get('summary')
  summary() {
    return this.tradesService.summary();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.tradesService.findOne(id);
  }
}
