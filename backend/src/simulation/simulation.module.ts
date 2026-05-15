import { Module } from '@nestjs/common';
import { SimulationService } from './simulation.service';
import { SimulationController } from './simulation.controller';
import { EventsModule } from '../events/events.module';
import { AiBrainModule } from '../ai-brain/ai-brain.module';

@Module({
  imports: [EventsModule, AiBrainModule],
  providers: [SimulationService],
  controllers: [SimulationController],
  exports: [SimulationService],
})
export class SimulationModule {}
