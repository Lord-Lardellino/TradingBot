import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { LiveModule } from '../live/live.module';
import { Impulse100Controller } from './impulse-100.controller';
import { Impulse100Service } from './impulse-100.service';

@Module({
  imports: [EventsModule, LiveModule],
  controllers: [Impulse100Controller],
  providers: [Impulse100Service],
})
export class Impulse100Module {}
