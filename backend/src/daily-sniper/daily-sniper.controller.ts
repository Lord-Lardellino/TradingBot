import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { DailySniperService } from './daily-sniper.service';

@Controller('daily-sniper')
export class DailySniperController {
  constructor(private readonly svc: DailySniperService) {}

  @Get('dashboard')  getDashboard()              { return this.svc.getDashboard(); }
  @Get('config')     getConfig()                 { return this.svc.getConfig(); }
  @Patch('config')   updateConfig(@Body() b: any) { return this.svc.updateConfig(b); }
  @Post('close')     closeOpen()                 { return this.svc.closeOpenManual(); }
  @Post('force-entry') forceEntry(@Body() b: any) { return this.svc.forceEntry(b?.side); }
  @Post('reset')     reset()                     { return this.svc.reset(); }
}
