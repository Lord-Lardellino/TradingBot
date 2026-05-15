import { Controller, Get, Query } from '@nestjs/common';
import { MexcService } from './mexc.service';

@Controller('mexc')
export class MexcController {
  constructor(private mexcService: MexcService) {}

  @Get('markets')
  getMarkets() {
    return this.mexcService.getMarkets();
  }

  @Get('ticker')
  getTicker(@Query('symbol') symbol: string) {
    return this.mexcService.getTicker(symbol || 'BTC/USDT');
  }

  @Get('ohlcv')
  getOHLCV(
    @Query('symbol') symbol: string,
    @Query('timeframe') timeframe: string,
    @Query('limit') limit: string,
  ) {
    return this.mexcService.getOHLCV(symbol || 'BTC/USDT', timeframe || '1m', limit ? parseInt(limit) : 100);
  }

  @Get('balance')
  getBalance() {
    return this.mexcService.getBalance();
  }
}
