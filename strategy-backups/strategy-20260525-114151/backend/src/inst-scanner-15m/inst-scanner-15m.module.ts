import { Module } from '@nestjs/common';
import { InstScanner15mService } from './inst-scanner-15m.service';
import { InstScanner15mController } from './inst-scanner-15m.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';

@Module({
  imports: [PrismaModule, IndicatorsModule, EventsModule, LiveModule],
  providers: [InstScanner15mService],
  controllers: [InstScanner15mController],
})
export class InstScanner15mModule {}
