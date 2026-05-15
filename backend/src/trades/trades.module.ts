import { Module } from '@nestjs/common';
import { TradesService } from './trades.service';
import { TradesController } from './trades.controller';

@Module({
  providers: [TradesService],
  controllers: [TradesController],
  exports: [TradesService],
})
export class TradesModule {}
