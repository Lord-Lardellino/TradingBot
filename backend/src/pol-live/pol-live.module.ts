import { Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { PolLiveController } from './pol-live.controller';
import { PolLiveService } from './pol-live.service';

@Module({
  imports: [LiveModule],
  controllers: [PolLiveController],
  providers: [PolLiveService],
})
export class PolLiveModule {}
