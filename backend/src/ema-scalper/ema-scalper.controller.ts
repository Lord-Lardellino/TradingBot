import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { EmaScalperService } from './ema-scalper.service';

@Controller('ema-scalper')
export class EmaScalperController {
  constructor(private readonly svc: EmaScalperService) {}

  @Get('dashboard')  getDashboard()              { return this.svc.getDashboard(); }
  @Get('config')     getConfig()                 { return this.svc.getConfig(); }
  @Patch('config')   updateConfig(@Body() b: any) { return this.svc.updateConfig(b); }
  @Post('close')     closeOpen()                 { return this.svc.closeOpenManual(); }
  @Post('reset')     reset()                     { return this.svc.reset(); }
}
