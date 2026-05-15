import { Module } from '@nestjs/common';
import { ScalpingStrategy } from './scalping.strategy';
import { PumpStrategy } from './pump.strategy';
import { IndicatorsModule } from '../indicators/indicators.module';

@Module({
  imports: [IndicatorsModule],
  providers: [ScalpingStrategy, PumpStrategy],
  exports: [ScalpingStrategy, PumpStrategy],
})
export class StrategiesModule {}
