import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';
import { SweepStarController } from './sweep-star.controller';
import { SweepStarService } from './sweep-star.service';

@Module({
  imports: [EventsModule, LiveModule],
  controllers: [SweepStarController],
  providers: [SweepStarService],
})
export class SweepStarModule {}
