import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GemmaModule } from '../gemma/gemma.module';
import { TgSignalsController } from './tg-signals.controller';
import { TgSignalsService } from './tg-signals.service';
import { TelegramClientService } from './telegram-client.service';
import { SignalParserService } from './signal-parser.service';
import { OrderExecutorService } from './order-executor.service';

@Module({
  imports: [PrismaModule, GemmaModule],
  controllers: [TgSignalsController],
  providers: [TgSignalsService, TelegramClientService, SignalParserService, OrderExecutorService],
})
export class TgSignalsModule {}
