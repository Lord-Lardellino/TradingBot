import { Module } from '@nestjs/common';
import { GemmaService } from './gemma.service';
import { GemmaController } from './gemma.controller';

@Module({
  providers:   [GemmaService],
  controllers: [GemmaController],
  exports:     [GemmaService],
})
export class GemmaModule {}
