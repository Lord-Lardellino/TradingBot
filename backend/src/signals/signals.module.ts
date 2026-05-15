import { Module } from '@nestjs/common';
import { SignalsService } from './signals.service';
import { SignalsController } from './signals.controller';

@Module({
  providers: [SignalsService],
  controllers: [SignalsController],
  exports: [SignalsService],
})
export class SignalsModule {}
