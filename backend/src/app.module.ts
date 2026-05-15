import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { MexcModule } from './mexc/mexc.module';
import { IndicatorsModule } from './indicators/indicators.module';
import { StrategiesModule } from './strategies/strategies.module';
import { BotModule } from './bot/bot.module';
import { TradesModule } from './trades/trades.module';
import { SignalsModule } from './signals/signals.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { SettingsModule } from './settings/settings.module';
import { EventsModule } from './events/events.module';
import { ScannerModule } from './scanner/scanner.module';
import { SimulationModule } from './simulation/simulation.module';
import { LiveModule } from './live/live.module';
import { AiBrainModule } from './ai-brain/ai-brain.module';
import { IntraModule } from './intra/intra.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    MexcModule,
    IndicatorsModule,
    StrategiesModule,
    BotModule,
    TradesModule,
    SignalsModule,
    DashboardModule,
    SettingsModule,
    EventsModule,
    ScannerModule,
    SimulationModule,
    LiveModule,
    AiBrainModule,
    IntraModule,
  ],
})
export class AppModule {}
