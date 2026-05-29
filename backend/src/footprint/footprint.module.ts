import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';
import { FootprintController } from './footprint.controller';
import { FootprintService } from './footprint.service';

@Module({
  imports: [EventsModule, LiveModule],
  controllers: [FootprintController],
  providers: [FootprintService],
})
export class FootprintModule {}
