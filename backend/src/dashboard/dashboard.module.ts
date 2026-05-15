import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { TradesModule } from '../trades/trades.module';
import { MexcModule } from '../mexc/mexc.module';

@Module({
  imports: [TradesModule, MexcModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
