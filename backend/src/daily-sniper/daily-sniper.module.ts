import { Module } from '@nestjs/common';
import { DailySniperService } from './daily-sniper.service';
import { DailySniperController } from './daily-sniper.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports:     [PrismaModule],
  providers:   [DailySniperService],
  controllers: [DailySniperController],
})
export class DailySniperModule {}
