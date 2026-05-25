import { Module } from '@nestjs/common';
import { InstScanner1hService } from './inst-scanner-1h.service';
import { InstScanner1hController } from './inst-scanner-1h.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';

@Module({
  imports: [PrismaModule, IndicatorsModule, EventsModule, LiveModule],
  providers: [InstScanner1hService],
  controllers: [InstScanner1hController],
})
export class InstScanner1hModule {}
