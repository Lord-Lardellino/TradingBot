import { Module } from '@nestjs/common';
import { LiveService } from './live.service';
import { LiveTradingService } from './live-trading.service';
import { LiveController } from './live.controller';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [EventsModule],
  controllers: [LiveController],
  providers:   [LiveService, LiveTradingService],
  exports:     [LiveTradingService],
})
export class LiveModule {}
