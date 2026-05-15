import { Module } from '@nestjs/common';
import { AiBrainService } from './ai-brain.service';
import { AiBrainController } from './ai-brain.controller';

@Module({
  providers:   [AiBrainService],
  controllers: [AiBrainController],
  exports:     [AiBrainService],
})
export class AiBrainModule {}
