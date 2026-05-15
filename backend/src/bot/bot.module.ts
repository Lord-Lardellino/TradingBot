import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { MexcModule } from '../mexc/mexc.module';
import { IndicatorsModule } from '../indicators/indicators.module';
import { StrategiesModule } from '../strategies/strategies.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [MexcModule, IndicatorsModule, StrategiesModule, EventsModule],
  providers: [BotService],
  controllers: [BotController],
  exports: [BotService],
})
export class BotModule {}
