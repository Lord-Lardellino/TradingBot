import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';
import { MtfScalperController } from './mtf-scalper.controller';
import { MtfScalperService } from './mtf-scalper.service';

@Module({
  imports: [EventsModule, LiveModule],
  controllers: [MtfScalperController],
  providers: [MtfScalperService],
})
export class MtfScalperModule {}
