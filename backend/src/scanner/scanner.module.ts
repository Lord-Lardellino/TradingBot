import { Module } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { ScannerController } from './scanner.controller';
import { IndicatorsModule } from '../indicators/indicators.module';
import { EventsModule } from '../events/events.module';
import { SimulationModule } from '../simulation/simulation.module';
import { AiBrainModule } from '../ai-brain/ai-brain.module';
import { LiveModule } from '../live/live.module';

@Module({
  imports: [IndicatorsModule, EventsModule, SimulationModule, AiBrainModule, LiveModule],
  providers: [ScannerService],
  controllers: [ScannerController],
})
export class ScannerModule {}
