import { Module } from '@nestjs/common';
import { MtfScannerService } from './mtf-scanner.service';
import { MtfScannerController } from './mtf-scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [IndicatorsModule, EventsModule, PrismaModule],
  providers: [MtfScannerService],
  controllers: [MtfScannerController],
  exports: [MtfScannerService],
})
export class MtfScannerModule {}
