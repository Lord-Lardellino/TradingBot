import { Controller, Get, Query } from '@nestjs/common';
import { ScannerService } from './scanner.service';

@Controller('scanner')
export class ScannerController {
  constructor(private scannerService: ScannerService) {}

  @Get('signals')
  getSignals(@Query('limit') limit?: string) {
    return this.scannerService.getRecentSignals(limit ? parseInt(limit) : 50);
  }

  @Get('status')
  getStatus() {
    return this.scannerService.getStatus();
  }

  @Get('debug')
  getDebug() {
    return this.scannerService.getDebug();
  }
}
