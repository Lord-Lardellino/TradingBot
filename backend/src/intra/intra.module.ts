import { Module } from '@nestjs/common';
import { IntraScannerService } from './intra-scanner.service';
import { IntraSimulationService } from './intra-simulation.service';
import { IntraController } from './intra.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [IndicatorsModule, EventsModule],
  providers: [IntraScannerService, IntraSimulationService],
  controllers: [IntraController],
})
export class IntraModule {}
