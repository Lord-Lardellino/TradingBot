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

  emitMtfSignal(signal: any) {
    this.server.emit('mtf:signal', signal);
  }

  emitMtfStatus(status: any) {
    this.server.emit('mtf:status', status);
  }

  emitMtfTrade(trade: any) {
    this.server.emit('mtf:trade', trade);
  }

  emitMtfPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('mtf:positions', positions);
  }

  emitFlexSignal(signal: any) { this.server.emit('flex:signal', signal); }
  emitFlexStatus(status: any) { this.server.emit('flex:status', status); }
  emitFlexTrade(trade: any)   { this.server.emit('flex:trade', trade); }
  emitFlexPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('flex:positions', positions);
  }

  emitSolSignal(signal: any) { this.server.emit('sol:signal', signal); }
  emitSolStatus(status: any) { this.server.emit('sol:status', status); }
  emitSolTrade(trade: any)   { this.server.emit('sol:trade', trade); }
  emitSolPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('sol:positions', positions);
  }

  emitInstSignal(signal: any) { this.server.emit('inst:signal', signal); }
  emitInstTrade(trade: any)   { this.server.emit('inst:trade', trade); }
  emitInstPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('inst:positions', positions);
  }

  emitSweepStarSignal(signal: any) { this.server.emit('sweep-star:signal', signal); }
  emitSweepStarStatus(status: any) { this.server.emit('sweep-star:status', status); }
  emitSweepStarTrade(trade: any)   { this.server.emit('sweep-star:trade', trade); }
  emitSweepStarPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('sweep-star:positions', positions);
  }

  emitImpulse100Signal(signal: any) { this.server.emit('impulse-100:signal', signal); }
  emitImpulse100Status(status: any) { this.server.emit('impulse-100:status', status); }
  emitImpulse100Trade(trade: any)   { this.server.emit('impulse-100:trade', trade); }
  emitImpulse100Positions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('impulse-100:positions', positions);
  }

  emitMtfScalperSignal(signal: any) { this.server.emit('mtf-scalper:signal', signal); }
  emitMtfScalperStatus(status: any) { this.server.emit('mtf-scalper:status', status); }
  emitMtfScalperTrade(trade: any)   { this.server.emit('mtf-scalper:trade', trade); }
  emitMtfScalperPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('mtf-scalper:positions', positions);
  }

  emitFootprintSignal(signal: any)  { this.server.emit('footprint:signal', signal); }
  emitFootprintStatus(status: any)  { this.server.emit('footprint:status', status); }
  emitFootprintTrade(trade: any)    { this.server.emit('footprint:trade', trade); }
  emitFootprintPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('footprint:positions', positions);
  }

  emitEngulfingSignal(signal: any) { this.server.emit('engulfing:signal', signal); }
  emitEngulfingStatus(status: any) { this.server.emit('engulfing:status', status); }
  emitEngulfingTrade(trade: any)   { this.server.emit('engulfing:trade', trade); }
  emitEngulfingPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('engulfing:positions', positions);
  }

  emitFibSignal(signal: any)    { this.server.emit('fib:signal', signal); }
  emitFibStatus(status: any)    { this.server.emit('fib:status', status); }
  emitFibTrade(trade: any)      { this.server.emit('fib:trade', trade); }
  emitFibPositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('fib:positions', positions);
  }

  emitEma34Signal(signal: any) { this.server.emit('ema34:signal', signal); }
  emitEma34Status(status: any) { this.server.emit('ema34:status', status); }
  emitEma34Trade(trade: any)   { this.server.emit('ema34:trade', trade); }
  emitEma34Positions(positions: { id: string; currentPrice: number; currentR: number; trailingSl: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    this.server.emit('ema34:positions', positions);
  }

  emitStarSignal(signal: any)         { this.server.emit('star:signal',    signal); }
  emitStarStatus(status: any)         { this.server.emit('star:status',    status); }
  emitStarTrade(trade: any)           { this.server.emit('star:trade',     trade); }
  emitStarPositions(positions: any[]) { this.server.emit('star:positions', positions); }

  emitFundingRates(rates: any[])  { this.server.emit('funding:rates',  rates); }
}
