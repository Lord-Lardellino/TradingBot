import { Body, Controller, Get, Post } from '@nestjs/common';
import { GemmaService, ChatDto } from './gemma.service';

@Controller('gemma')
export class GemmaController {
  constructor(private svc: GemmaService) {}

  @Get('model')
  model() { return { model: this.svc.currentModel }; }

  @Post('chat')
  chat(@Body() body: ChatDto) {
    return this.svc.chat(body);
  }
}
