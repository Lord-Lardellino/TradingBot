import { Controller, Get, Post, Put, Delete, Param, Body, ParseIntPipe } from '@nestjs/common';
import { BotService } from './bot.service';
import { CreateBotDto, UpdateBotDto } from './dto/create-bot.dto';

@Controller('bots')
export class BotController {
  constructor(private botService: BotService) {}

  @Get()
  findAll() {
    return this.botService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.botService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateBotDto) {
    return this.botService.create(dto);
  }

  @Put(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBotDto) {
    return this.botService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.botService.remove(id);
  }

  @Post(':id/start')
  start(@Param('id', ParseIntPipe) id: number) {
    return this.botService.start(id);
  }

  @Post(':id/stop')
  stop(@Param('id', ParseIntPipe) id: number) {
    return this.botService.stop(id);
  }

  @Get(':id/stats')
  stats(@Param('id', ParseIntPipe) id: number) {
    return this.botService.getStats(id);
  }
}
