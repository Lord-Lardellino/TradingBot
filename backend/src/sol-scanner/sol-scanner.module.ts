import { Module } from '@nestjs/common';
import { SolScannerService } from './sol-scanner.service';
import { SolScannerController } from './sol-scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [IndicatorsModule, EventsModule],
  providers:   [SolScannerService],
  controllers: [SolScannerController],
})
export class SolScannerModule {}
