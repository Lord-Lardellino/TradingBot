import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(EventsGateway.name);

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe:bot')
  handleSubscribeBot(@MessageBody() botId: number) {
    this.logger.log(`Client subscribed to bot #${botId}`);
  }

  emitSignal(botId: number, signal: any) {
    this.server.emit('signal', { botId, ...signal });
  }

  emitTrade(botId: number, trade: any) {
    this.server.emit('trade', { botId, ...trade });
  }

  emitPrice(symbol: string, price: number, changePct: number) {
    this.server.emit('price', { symbol, price, changePct, ts: Date.now() });
  }

  emitBotStatus(botId: number, status: string) {
    this.server.emit('bot:status', { botId, status });
  }

  emitPumpSignal(signal: any) {
    this.server.emit('scanner:signal', signal);
  }

  emitScannerStatus(status: any) {
    this.server.emit('scanner:status', status);
  }

  emitSimTrade(trade: any) {
    this.server.emit('sim:trade', trade);
  }

  emitSimPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('sim:positions', positions);
  }

  emitLiveUpdate(data: { account: any; positions: any[] }) {
    this.server.emit('live:update', data);
  }

  emitIntraSignal(signal: any) {
    this.server.emit('intra:signal', signal);
  }

  emitIntraTrade(trade: any) {
    this.server.emit('intra:trade', trade);
  }

  emitIntraPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('intra:positions', positions);
  }

  emitLiveTrade(trade: any) {
    this.server.emit('live:trade', trade);
  }
}
