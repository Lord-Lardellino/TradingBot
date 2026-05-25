import { Module } from '@nestjs/common';
import { InstScannerService } from './inst-scanner.service';
import { InstScannerController } from './inst-scanner.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';

@Module({
  imports: [PrismaModule, IndicatorsModule, EventsModule, LiveModule],
  providers: [InstScannerService],
  controllers: [InstScannerController],
})
export class InstScannerModule {}
