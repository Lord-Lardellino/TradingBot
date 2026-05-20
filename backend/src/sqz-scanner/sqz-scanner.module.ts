import { Module } from '@nestjs/common';
import { SqzScannerService } from './sqz-scanner.service';
import { SqzScannerController } from './sqz-scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [IndicatorsModule, EventsModule],
  providers: [SqzScannerService],
  controllers: [SqzScannerController],
})
export class SqzScannerModule {}
