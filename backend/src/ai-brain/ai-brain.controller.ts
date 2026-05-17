import { Controller, Get, Post, Patch, Body, Query } from '@nestjs/common';
import { AiBrainService } from './ai-brain.service';

@Controller('brain')
export class AiBrainController {
  constructor(private brain: AiBrainService) {}

  @Get('params')
  params() {
    return this.brain.getParams();
  }

  @Post('toggle')
  toggle(@Body('enabled') enabled: boolean) {
    return this.brain.toggle(enabled);
  }

  @Patch('params')
  updateParams(@Body() body: any) {
    return this.brain.updateParams(body);
  }

  @Post('reset')
  reset() {
    return this.brain.resetToDefaults();
  }

  @Post('clear')
  clear() {
    return this.brain.clearAll();
  }

  @Get('log')
  log(@Query('limit') limit?: string) {
    return this.brain.getLog(limit ? parseInt(limit) : 30);
  }
}
