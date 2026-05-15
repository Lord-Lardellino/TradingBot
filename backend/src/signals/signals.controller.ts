import { Controller, Get, Query } from '@nestjs/common';
import { SignalsService } from './signals.service';

@Controller('signals')
export class SignalsController {
  constructor(private signalsService: SignalsService) {}

  @Get()
  findAll(
    @Query('botId') botId?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
  ) {
    return this.signalsService.findAll(
      botId ? parseInt(botId) : undefined,
      type,
      limit ? parseInt(limit) : 100,
    );
  }

  @Get('count-by-type')
  countByType(@Query('botId') botId?: string) {
    return this.signalsService.countByType(botId ? parseInt(botId) : undefined);
  }
}
