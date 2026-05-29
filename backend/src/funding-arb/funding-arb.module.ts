import { Module } from '@nestjs/common';
import { FundingArbService } from './funding-arb.service';
import { FundingArbController } from './funding-arb.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports:     [PrismaModule, EventsModule],
  providers:   [FundingArbService],
  controllers: [FundingArbController],
})
export class FundingArbModule {}
