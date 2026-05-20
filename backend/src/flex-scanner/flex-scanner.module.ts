import { Module } from '@nestjs/common';
import { FlexScannerService } from './flex-scanner.service';
import { FlexScannerController } from './flex-scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [IndicatorsModule, EventsModule],
  providers:   [FlexScannerService],
  controllers: [FlexScannerController],
})
export class FlexScannerModule {}
