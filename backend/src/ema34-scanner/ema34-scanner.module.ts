import { Module } from '@nestjs/common';
import { Ema34ScannerService } from './ema34-scanner.service';
import { Ema34ScannerController } from './ema34-scanner.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';

@Module({
  imports:     [PrismaModule, EventsModule, LiveModule],
  providers:   [Ema34ScannerService],
  controllers: [Ema34ScannerController],
})
export class Ema34ScannerModule {}
