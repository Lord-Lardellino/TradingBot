import { Module } from '@nestjs/common';
import { FibScannerService } from './fib-scanner.service';
import { FibScannerController } from './fib-scanner.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [PrismaModule, EventsModule],
  providers:   [FibScannerService],
  controllers: [FibScannerController],
})
export class FibScannerModule {}
