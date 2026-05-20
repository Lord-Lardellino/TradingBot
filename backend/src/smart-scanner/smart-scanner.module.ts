import { Module } from '@nestjs/common';
import { SmartScannerService } from './smart-scanner.service';
import { SmartScannerController } from './smart-scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LiveModule } from '../live/live.module';
import { GemmaModule } from '../gemma/gemma.module';

@Module({
  imports: [IndicatorsModule, EventsModule, PrismaModule, LiveModule, GemmaModule],
  providers: [SmartScannerService],
  controllers: [SmartScannerController],
})
export class SmartScannerModule {}
