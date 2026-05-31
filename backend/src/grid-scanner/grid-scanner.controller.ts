import { Controller, Get, Post, Patch, Body } from '@nestjs/common';
import { GridScannerService } from './grid-scanner.service';

@Controller('grid-scanner')
export class GridScannerController {
  constructor(private readonly svc: GridScannerService) {}

  @Get('dashboard')    getDashboard()              { return this.svc.getDashboard(); }
  @Get('status')       getStatus()                 { return this.svc.getStatus(); }
  @Get('config')       getConfig()                 { return this.svc.getConfig(); }
  @Get('suggestions')  getSuggestions()            { return this.svc.getSuggestions(); }
  @Patch('config')     updateConfig(@Body() b: any) { return this.svc.updateConfig(b); }
  @Post('scan')        forceScan()                 { return this.svc.scanRanges(); }
  @Post('open')        openGrid(@Body() b: any)    { return this.svc.openSimGrid(b.symbol, b.side); }
  @Post('close')       closeGrid(@Body() b: any)   { return this.svc.closeSimGrid(b.id, 'manual'); }
  @Post('open-live')   openLive(@Body() b: any)    { return this.svc.openLiveGrid(b.symbol, b.side, b.marginUsdt ?? 10, b.levels ?? 10); }
  @Post('close-live')  closeLive(@Body() b: any)   { return this.svc.closeLiveGrid(b.id, 'manual'); }
  @Post('reset')       reset()                     { return this.svc.resetGrid(); }
}
