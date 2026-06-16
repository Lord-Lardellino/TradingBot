import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { TgSignalsService } from './tg-signals.service';

@Controller('tg-signals')
export class TgSignalsController {
  constructor(private readonly svc: TgSignalsService) {}

  @Get('dashboard') getDashboard() {
    return this.svc.getDashboard();
  }

  @Get('channels') getChannels() {
    return this.svc.getChannels();
  }

  @Get('dialogs') listDialogs() {
    return this.svc.listDialogs();
  }

  @Post('test-parse') testParse(@Body() body: any) {
    return this.svc.testParse(body);
  }

  @Post('channels') addChannel(@Body() body: any) {
    return this.svc.addChannel(body);
  }

  @Patch('channels/:id') updateChannel(@Param('id') id: string, @Body() body: any) {
    return this.svc.updateChannel(Number(id), body);
  }

  @Delete('channels/:id') removeChannel(@Param('id') id: string) {
    return this.svc.removeChannel(Number(id));
  }

  @Post('signals/:id/close') closeSignal(@Param('id') id: string) {
    return this.svc.closeSignalManual(id);
  }

  @Post('reset') reset() {
    return this.svc.reset();
  }
}
