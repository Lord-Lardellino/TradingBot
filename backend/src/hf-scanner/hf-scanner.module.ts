import { Module } from '@nestjs/common';
import { HfScannerService } from './hf-scanner.service';
import { HfScannerController } from './hf-scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [IndicatorsModule, EventsModule],
  providers:   [HfScannerService],
  controllers: [HfScannerController],
})
export class HfScannerModule {}
