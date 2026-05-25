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
import { LiveModule } from './live/live.module';
import { AiBrainModule } from './ai-brain/ai-brain.module';
import { GemmaModule } from './gemma/gemma.module';
import { SmartScannerModule } from './smart-scanner/smart-scanner.module';
import { InstScannerModule } from './inst-scanner/inst-scanner.module';
import { InstScanner15mModule } from './inst-scanner-15m/inst-scanner-15m.module';
import { InstScanner1hModule } from './inst-scanner-1h/inst-scanner-1h.module';

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
    LiveModule,
    AiBrainModule,
    GemmaModule,
    SmartScannerModule,
    InstScannerModule,
    InstScanner15mModule,
    InstScanner1hModule,
  ],
})
export class AppModule {}
