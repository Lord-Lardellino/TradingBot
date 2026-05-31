import { Module } from '@nestjs/common';
import { GridScannerService } from './grid-scanner.service';
import { GridScannerController } from './grid-scanner.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [PrismaModule, EventsModule],
  providers:   [GridScannerService],
  controllers: [GridScannerController],
})
export class GridScannerModule {}
