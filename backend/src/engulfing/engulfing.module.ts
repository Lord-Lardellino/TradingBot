import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';
import { EngulfingController } from './engulfing.controller';
import { EngulfingService } from './engulfing.service';

@Module({
  imports: [EventsModule, LiveModule],
  controllers: [EngulfingController],
  providers: [EngulfingService],
})
export class EngulfingModule {}
