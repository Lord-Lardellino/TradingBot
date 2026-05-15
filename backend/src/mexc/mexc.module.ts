import { Module } from '@nestjs/common';
import { MexcService } from './mexc.service';
import { MexcController } from './mexc.controller';

@Module({
  providers: [MexcService],
  controllers: [MexcController],
  exports: [MexcService],
})
export class MexcModule {}
