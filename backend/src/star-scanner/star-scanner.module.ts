import { Module } from '@nestjs/common';
import { StarScannerService } from './star-scanner.service';
import { StarScannerController } from './star-scanner.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';

@Module({
  imports:     [PrismaModule, EventsModule, LiveModule],
  providers:   [StarScannerService],
  controllers: [StarScannerController],
})
export class StarScannerModule {}
