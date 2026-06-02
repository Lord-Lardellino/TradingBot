import { Module } from '@nestjs/common';
import { EmaScalperService } from './ema-scalper.service';
import { EmaScalperController } from './ema-scalper.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  providers:   [EmaScalperService],
  controllers: [EmaScalperController],
})
export class EmaScalperModule {}
