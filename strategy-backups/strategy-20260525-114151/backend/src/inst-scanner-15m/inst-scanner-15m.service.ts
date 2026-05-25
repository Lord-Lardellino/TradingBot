import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';

const TIMEFRAME       = '15m';
const TF_MS           = 15 * 60_000;
const CANDLES         = 100;
const MIN_VOLUME_24H  = 200_000;
const MIN_TRIGGER_VOL_R = 1.0;
const SIGNAL_COOLDOWN = 15 * 60_000;
const BATCH_SIZE      = 5;
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 2.0;
const MAX_FEE_TO_RISK = 0.55;
const PT_MOMENTUM      = 1;
const PT_IMPULSE_BREAK = 2;

export interface Inst15mSignal {
  id: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  patternType: number;
  patternName: string;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  slPct: number;
  tpPct: number;
  suggestedLeverage: number;
  volumeRatio: number;
  rsi14: number;
  atrPct: number;
  score: number;
  grade: 'A+' | 'A' | 'B';
  reasons: string[];
  timestamp: string;
  mexcUrl: string;
  sparkline: { t: number; o: number; h: number; l: number; c: number }[];
}

@Injectable()
export class InstScanner15mService implements OnModuleInit {
  private readonly logger = new Logger(InstScanner15mService.name);
  private exchange: ccxt.mexc;
  private fastExchange: ccxt.mexc;
  private validSymbols = new Set<string>();
  private recentSignals: Inst15mSignal[] = [];
  private isScanning = false;
  private lastScanAt: string | null = null;
  private scannedCount = 0;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private cooldowns = new Map<string, number>();
  private readonly sessionStart = new Date();
  private dbg: Record<string, number> = {};
  private tickerCache: Record<string, any> = {};

  @Interval(60000)
  async refreshTickerCache() {
    try { this.tickerCache = await this.exchange.fetchTickers([...this.validSymbols]); } catch {}
  }

  constructor(
    private config: ConfigService,
    private indicators: IndicatorsService,
    private events: EventsGateway,
    private prisma: PrismaService,
    private liveTrading: LiveTradingService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get('MEXC_API_KEY', '');
    const secret = this.config.get('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      options: { defaultType: 'swap' },
    });
    this.fastExchange = new ccxt.mexc({
      enableRateLimit: false,
      options: { defaultType: 'swap' },
    });
    await this.loadMarkets();
    await this.initConfig();
    this.logger.log(`[INST15m] ${this.validSymbols.size} coppie · TF=15m`);
  }

  @Cron('0 0 * * * *')
  async loadMarkets() {
    try {
      const markets = await this.exchange.loadMarkets(true);
      this.fastExchange.markets          = this.exchange.markets;
      this.fastExchange.markets_by_id    = this.exchange.markets_by_id;
      this.fastExchange.currencies       = this.exchange.currencies;
      this.fastExchange.currencies_by_id = this.exchange.currencies_by_id;
      this.validSymbols = new Set(Object.keys(markets).filter(s => s.endsWith('/USDT:USDT')));
    } catch (err: any) { this.logger.error(`loadMarkets: ${err.message}`); }
  }

  // 15m candles close at :00, :15, :30, :45 — fire 8s before
  @Cron('44 14,29,44,59 * * * *')
  async scan() {
    if (this.isScanning || this.validSymbols.size === 0) return;
    this.isScanning = true;
    try {
      const cfg = await this.getConfig();
      const tickers = Object.keys(this.tickerCache).length > 0
        ? this.tickerCache
        : await this.exchange.fetchTickers([...this.validSymbols]);
      const openSymbols = await this.getOpenSymbolsSet();

      const candidates = Object.values(tickers)
        .filter(t => this.validSymbols.has(t.symbol) && (t.quoteVolume ?? 0) >= MIN_VOLUME_24H && !openSymbols.has(t.symbol))
        .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
        .slice(0, 25);
      this.scannedCount = candidates.length;
      this.dbg = {};
      this.logger.log(`[INST15m] scansiono ${candidates.length} pair`);

      const openCount = await this.prisma.inst15mSimulatedTrade.count({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (openCount >= cfg.maxConcurrent) {
        this.isScanning = false;
        this._emitStatus(cfg, candidates.length, 0, 0);
        return;
      }

      const cycleSignals: Inst15mSignal[] = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async ticker => {
            try {
              const raw = await this.fastExchange.fetchOHLCV(ticker.symbol, TIMEFRAME, undefined, CANDLES);
              try { return this.analyzePair(ticker.symbol, raw, cfg); }
              catch { this.dbg['analyze_err'] = (this.dbg['analyze_err'] ?? 0) + 1; return null; }
            } catch {
              this.dbg['fetch_err'] = (this.dbg['fetch_err'] ?? 0) + 1;
              return null;
            }
          }),
        );
        results.forEach(sig => sig && cycleSignals.push(sig));
        await new Promise(r => setTimeout(r, 120));
      }
      this.lastRawSignals = cycleSignals.length;
      this.logger.log(`[INST15m DBG] raw=${cycleSignals.length} ${JSON.stringify(this.dbg)}`);

      const bestLong  = cycleSignals.filter(s => s.direction === 'LONG').sort((a, b) => b.score - a.score)[0];
      const bestShort = cycleSignals.filter(s => s.direction === 'SHORT').sort((a, b) => b.score - a.score)[0];
      const best = [bestLong, bestShort].filter(Boolean) as Inst15mSignal[];

      const toProcess = best.filter(sig => {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        return Date.now() - last >= SIGNAL_COOLDOWN;
      });
      for (const sig of toProcess) this.cooldowns.set(sig.symbol, Date.now());

      let emitted = 0;
      for (const sig of toProcess) {
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 200) this.recentSignals.pop();
        this.events.server.emit('inst15m:signal', sig);
        if (cfg.autoEnter) await this.enterSimTrade(sig, cfg).catch(() => {});
        if (cfg.liveEnabled) {
          await this.liveTrading.enterTrade({
            symbol: sig.symbol, direction: sig.direction, grade: sig.grade,
            entry: sig.entry, slPct: sig.slPct, tp1Pct: sig.tpPct,
            suggestedLeverage: sig.suggestedLeverage, score: sig.score,
            stopLossPrice: sig.stopLoss, takeProfitPrice: sig.takeProfit1,
          }).catch(err => this.logger.error(`[INST15m LIVE] ${err.message}`));
        }
        emitted++;
        this.logger.log(`[INST15m ✅] ${sig.direction} ${sig.symbol} score=${sig.score} grade=${sig.grade}`);
      }
      this.lastEmitted = emitted;
      this._emitStatus(cfg, candidates.length, cycleSignals.length, emitted);
    } catch (err: any) { this.logger.error(`Inst15m scan: ${err.message}`); }
    finally { this.isScanning = false; }
  }

  @Cron('*/30 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.inst15mSimulatedTrade.findMany({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (!open.length) return;
      const cfg = await this.getConfig();

      for (const t of open) {
        try {
          const ohlcv = await this.exchange.fetchOHLCV(t.symbol, '1m', undefined, 3);
          if (!ohlcv.length) continue;
          const curr      = ohlcv.at(-1)![4] as number;
          const candleHigh = ohlcv.at(-1)![2] as number;
          const candleLow  = ohlcv.at(-1)![3] as number;
          const isLong = t.direction === 'LONG';

          this.events.server.emit('inst15m:positions', [{
            id: t.id,
            currentPrice: curr,
            unrealizedPnl: parseFloat(((curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize).toFixed(4)),
            unrealizedPnlPct: parseFloat(((curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100).toFixed(3)),
          }]);

          const tpDist   = Math.abs(t.takeProfit1 - t.entry);
          const bePrice  = isLong ? t.entry + tpDist * 0.5 : t.entry - tpDist * 0.5;
          const beActive = isLong ? t.stopLoss >= t.entry * 0.9999 : t.stopLoss <= t.entry * 1.0001;
          const beHit    = isLong ? candleHigh >= bePrice : candleLow <= bePrice;
          if (!beActive && beHit) {
            await this.prisma.inst15mSimulatedTrade.update({ where: { id: t.id }, data: { stopLoss: t.entry } });
            this.logger.log(`[INST15m BE] ${t.symbol} BE attivato`);
          }

          const hitSL = isLong ? candleLow <= t.stopLoss    : candleHigh >= t.stopLoss;
          const hitTP = isLong ? candleHigh >= t.takeProfit1 : candleLow <= t.takeProfit1;
          if (!hitSL && !hitTP) continue;

          const isBreakEvenStop = hitSL && !hitTP && Math.abs(t.stopLoss - t.entry) / t.entry <= 0.00001;
          const status     = hitTP ? 'tp1' : isBreakEvenStop ? 'be' : 'sl';
          const closePrice = hitTP ? t.takeProfit1 : t.stopLoss;
          const pnlRaw     = (closePrice - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize;
          const exitFee    = t.positionSize * TAKER_FEE;
          const totalFees  = (t.fees ?? 0) + exitFee;
          const pnl        = pnlRaw - totalFees;
          const capitalAfter = t.capitalBefore + pnl;

          await this.prisma.inst15mSimulatedTrade.update({
            where: { id: t.id },
            data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(totalFees.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
          });
          if (cfg.autoEnter) {
            await this.prisma.inst15mSimConfig.update({ where: { id: 1 }, data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) } });
          }
          const updated = await this.prisma.inst15mSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.server.emit('inst15m:trade', updated);
          this.logger.log(`[INST15m CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err: any) { this.logger.error(`Inst15m checkOpen: ${err.message}`); }
  }

  private analyzePair(sym: string, raw: number[][], cfg: any): Inst15mSignal | null {
    const n = raw.length;
    if (n < 30) { this.dbg['no_data'] = (this.dbg['no_data'] ?? 0) + 1; return null; }

    const o = raw.map(r => r[1] as number);
    const h = raw.map(r => r[2] as number);
    const l = raw.map(r => r[3] as number);
    const c = raw.map(r => r[4] as number);
    const v = raw.map(r => r[5] as number);

    const lastTs = raw[n-1][0] as number;
    const timeUntilClose = (lastTs + TF_MS) - Date.now();
    const ti = timeUntilClose <= 10_000 ? n - 1 : n - 2;

    const entry = c[ti];
    if (!entry || entry <= 0) return null;

    const atr14  = this.indicators.atr(h, l, c, 14);
    if (atr14 <= 0) return null;
    const atrPct = atr14 / entry * 100;

    const volWindow = v.slice(ti - 20, ti);
    const avgVol    = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
    const volR      = avgVol > 0 ? v[ti] / avgVol : 1;

    const cO = o[ti], cH = h[ti], cL = l[ti], cC = c[ti];
    const body        = Math.abs(cC - cO);
    const candleRange = cH - cL || atr14 * 0.01;
    const closePos    = (cC - cL) / candleRange;

    const sma34   = c.slice(ti - 33, ti + 1).reduce((a, b) => a + b, 0) / 34;
    const sma34_5 = c.slice(ti - 38, ti - 4).reduce((a, b) => a + b, 0) / 34;
    if (sma34 <= 0) { this.dbg['no_sma34'] = (this.dbg['no_sma34'] ?? 0) + 1; return null; }

    const smaSlope   = sma34 - sma34_5;
    const smaRising  = smaSlope >=  atr14 * 0.05;
    const smaFalling = smaSlope <= -atr14 * 0.05;
    const longTrend  = cC > sma34 && smaRising;
    const shortTrend = cC < sma34 && smaFalling;
    const isCrossLong = longTrend && cL <= sma34;
    const isCrossShort = shortTrend && cH >= sma34;

    const lowerWick = Math.min(cO, cC) - cL;
    const upperWick = cH - Math.max(cO, cC);
    const maxWeakWick = Math.min(atr14 * 0.05, candleRange * 0.15);
    const weakLong  = lowerWick <= maxWeakWick;
    const weakShort = upperWick <= maxWeakWick;

    const prevBullish = [1,2,3].filter(i => c[ti-i] > o[ti-i]).length;
    const prevBearish = [1,2,3].filter(i => c[ti-i] < o[ti-i]).length;
    const hadPullbackLong  = [1,2,3,4,5].some(i => l[ti-i] <= sma34 + atr14 * 1.5);
    const hadPullbackShort = [1,2,3,4,5].some(i => h[ti-i] >= sma34 - atr14 * 1.0);
    const smaDistLong  = (cC - sma34) / atr14;
    const smaDistShort = (sma34 - cC) / atr14;
    const volumeOk = volR >= MIN_TRIGGER_VOL_R;
    const triggerLong  = cC > cO && body >= atr14 * 0.5 && closePos >= 0.70 && weakLong;
    const triggerShort = cC < cO && body >= atr14 * 0.5 && closePos <= 0.30 && weakShort;
    const trendMomentum = longTrend
      ? triggerLong  && (isCrossLong  || hadPullbackLong  || prevBullish >= 1)
      : triggerShort && (isCrossShort || hadPullbackShort || prevBearish >= 1);

    const momLong  = volumeOk && longTrend  && trendMomentum && hadPullbackLong  && body <= atr14 * 1.2 && triggerLong;
    const momShort = volumeOk && shortTrend && trendMomentum && hadPullbackShort && body <= atr14 * 1.2 && triggerShort;
    const impulseLong  = volumeOk && longTrend  && trendMomentum && body >= atr14 * 0.9 && body <= atr14 * 1.6 && closePos >= 0.85 && weakLong  && smaDistLong  <= 2.2;
    const impulseShort = volumeOk && shortTrend && trendMomentum && body >= atr14 * 0.9 && body <= atr14 * 1.6 && closePos <= 0.15 && weakShort && smaDistShort <= 2.2;

    if (longTrend || shortTrend) this.dbg['trend_ok'] = (this.dbg['trend_ok'] ?? 0) + 1;
    if (trendMomentum)           this.dbg['mom_ok']   = (this.dbg['mom_ok']   ?? 0) + 1;
    if (longTrend || shortTrend) this.dbg[volumeOk ? 'vol_ok' : 'vol_low'] = (this.dbg[volumeOk ? 'vol_ok' : 'vol_low'] ?? 0) + 1;
    if (momLong || momShort)     this.dbg['raw_mom']  = (this.dbg['raw_mom']  ?? 0) + 1;
    if (impulseLong || impulseShort) this.dbg['raw_impulse'] = (this.dbg['raw_impulse'] ?? 0) + 1;

    let isLong: boolean;
    let patternType: number;
    let patternName: string;
    if      (impulseLong)  { isLong = true;  patternType = PT_IMPULSE_BREAK; patternName = 'IMPULSE_BREAK'; }
    else if (impulseShort) { isLong = false; patternType = PT_IMPULSE_BREAK; patternName = 'IMPULSE_BREAK'; }
    else if (momLong)      { isLong = true;  patternType = PT_MOMENTUM;      patternName = 'MOMENTUM'; }
    else if (momShort)     { isLong = false; patternType = PT_MOMENTUM;      patternName = 'MOMENTUM'; }
    else { this.dbg['no_pattern'] = (this.dbg['no_pattern'] ?? 0) + 1; return null; }

    const slLevel = cO;
    const slPct   = isLong ? (entry - slLevel) / entry * 100 : (slLevel - entry) / entry * 100;

    if (body > atr14 * 1.6) { this.dbg['too_big'] = (this.dbg['too_big'] ?? 0) + 1; return null; }
    if (slPct <= 0) return null;

    const estimatedRoundTripFee = (RISK_EUR / (slPct / 100)) * TAKER_FEE * 2;
    if (estimatedRoundTripFee > RISK_EUR * MAX_FEE_TO_RISK) {
      this.dbg['fee_too_high'] = (this.dbg['fee_too_high'] ?? 0) + 1;
      return null;
    }

    // Candela in formazione non deve contraddire la direzione — evita entry su rimbalzi
    if (ti === n - 2) {
      const fBody = Math.abs(c[n-1] - o[n-1]);
      if ( isLong && c[n-1] < o[n-1] && fBody > atr14 * 0.25) { this.dbg['forming_contra'] = (this.dbg['forming_contra'] ?? 0) + 1; return null; }
      if (!isLong && c[n-1] > o[n-1] && fBody > atr14 * 0.25) { this.dbg['forming_contra'] = (this.dbg['forming_contra'] ?? 0) + 1; return null; }
    }

    let score = patternName === 'IMPULSE_BREAK' ? 42 : 40;
    const reasons: string[] = [patternName];
    const bodyMult = body / atr14;
    if (patternName === 'IMPULSE_BREAK') {
      if      (bodyMult >= 1.05 && bodyMult <= 1.35) { score += 20; reasons.push(`ImpulseBody×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >= 0.90 && bodyMult <  1.05) { score += 14; reasons.push(`Body×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >  1.35 && bodyMult <= 1.60) { score +=  8; reasons.push(`ExtendedBody×${bodyMult.toFixed(2)}`); }
    } else {
      if      (bodyMult >= 0.85 && bodyMult <= 1.05) { score += 20; reasons.push(`Body×${bodyMult.toFixed(2)} sweet`); }
      else if (bodyMult >= 0.65 && bodyMult <  0.85) { score += 12; reasons.push(`Body×${bodyMult.toFixed(2)}`); }
      else if (bodyMult >= 1.05 && bodyMult <= 1.20) { score +=  5; }
    }

    if      (isLong  && closePos >= 0.90) { score += 15; reasons.push('StrongClose'); }
    else if (isLong  && closePos >= 0.80) { score += 10; reasons.push('GoodClose'); }
    else if (isLong  && closePos >= 0.65) { score +=  5; }
    else if (!isLong && closePos <= 0.10) { score += 15; reasons.push('StrongClose'); }
    else if (!isLong && closePos <= 0.20) { score += 10; reasons.push('GoodClose'); }
    else if (!isLong && closePos <= 0.35) { score +=  5; }

    if      (volR >= 2.5) { score += patternName === 'IMPULSE_BREAK' ? 18 : 15; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.8) { score += patternName === 'IMPULSE_BREAK' ? 12 : 10; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.3) { score += patternName === 'IMPULSE_BREAK' ?  7 :  5; }

    if (isCrossLong) { score += 5; reasons.push('CrossSMA'); }
    if (isCrossShort) { score += 5; reasons.push('CrossSMA'); }

    if (score < cfg.minScore) { this.dbg['score_low'] = (this.dbg['score_low'] ?? 0) + 1; return null; }

    const grade: 'A+' | 'A' | 'B' = score >= 75 ? 'A+' : score >= 60 ? 'A' : 'B';
    const tpPct    = slPct * cfg.tpRr;
    const tp1      = isLong ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    const leverage = Math.min(20, Math.max(3, Math.round(1 / (slPct / 100) * 0.5)));
    const ticker   = sym.replace('/USDT:USDT', '');
    const sparkStart = Math.max(0, n - 60);
    const sparkline  = raw.slice(sparkStart).map(r => ({ t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number, c: r[4] as number }));

    return {
      id: `inst15m_${sym}_${Date.now()}`,
      symbol: sym, direction: isLong ? 'LONG' : 'SHORT',
      patternType, patternName,
      entry, stopLoss: parseFloat(slLevel.toPrecision(6)),
      takeProfit1: parseFloat(tp1.toPrecision(6)),
      slPct: parseFloat(slPct.toFixed(3)), tpPct: parseFloat(tpPct.toFixed(3)),
      suggestedLeverage: leverage, volumeRatio: parseFloat(volR.toFixed(2)),
      rsi14: 0, atrPct: parseFloat(atrPct.toFixed(3)),
      score, grade, reasons, timestamp: new Date().toISOString(),
      mexcUrl: `https://futures.mexc.com/exchange/${ticker}_USDT`,
      sparkline,
    };
  }

  private async enterSimTrade(sig: Inst15mSignal, cfg: any) {
    const already = await this.prisma.inst15mSimulatedTrade.findFirst({ where: { symbol: sig.symbol, status: 'open' } });
    if (already) return;
    const capital = cfg.startingCapital;
    const pos     = RISK_EUR / (sig.slPct / 100);
    const margin  = pos / sig.suggestedLeverage;
    const fee     = pos * TAKER_FEE;
    const trade = await this.prisma.inst15mSimulatedTrade.create({
      data: {
        id: sig.id, symbol: sig.symbol, direction: sig.direction,
        patternType: sig.patternType, patternName: sig.patternName,
        entry: sig.entry, stopLoss: sig.stopLoss, takeProfit1: sig.takeProfit1,
        leverage: sig.suggestedLeverage, riskEur: RISK_EUR,
        positionSize: parseFloat(pos.toFixed(4)), marginEur: parseFloat(margin.toFixed(4)),
        grade: sig.grade, score: sig.score,
        fees: parseFloat(fee.toFixed(6)), capitalBefore: parseFloat(capital.toFixed(4)),
      },
    });
    this.events.server.emit('inst15m:trade', trade);
  }

  private async getOpenSymbolsSet(): Promise<Set<string>> {
    const open = await this.prisma.inst15mSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
      select: { symbol: true },
    });
    return new Set(open.map(t => t.symbol));
  }

  private _emitStatus(cfg: any, candidates: number, rawSignals: number, emitted: number) {
    this.events.server.emit('inst15m:status', {
      lastScanAt: new Date().toISOString(),
      scannedPairs: this.scannedCount,
      candidates, rawSignals, emitted, isScanning: false,
      debug: { ...this.dbg },
      config: { minScore: cfg.minScore, tpRr: cfg.tpRr },
    });
  }

  private async initConfig() {
    const exists = await this.prisma.inst15mSimConfig.findUnique({ where: { id: 1 } });
    if (!exists) await this.prisma.inst15mSimConfig.create({
      data: { id: 1, startingCapital: 500, maxConcurrent: 3, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 1.5, liveEnabled: false },
    });
  }

  async getConfig() {
    let cfg = await this.prisma.inst15mSimConfig.findUnique({ where: { id: 1 } });
    if (!cfg) cfg = await this.prisma.inst15mSimConfig.create({
      data: { id: 1, startingCapital: 500, maxConcurrent: 3, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 1.5, liveEnabled: false },
    });
    return cfg;
  }

  async updateConfig(data: any) {
    return this.prisma.inst15mSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, maxConcurrent: 3, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 1.5, liveEnabled: false, ...data },
      update: data,
    });
  }

  async getAnalytics() {
    const cfg    = await this.getConfig();
    const trades = await this.prisma.inst15mSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const tp1    = closed.filter(t => t.status === 'tp1');
    const sl     = closed.filter(t => t.status === 'sl');
    const be     = closed.filter(t => t.status === 'be');
    const totalPnl  = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees = trades.reduce((s, t) => s + (t.fees ?? 0), 0);
    const winRate   = tp1.length + sl.length > 0 ? tp1.length / (tp1.length + sl.length) * 100 : null;
    return {
      totalTrades: trades.length, openTrades: trades.filter(t => t.status === 'open').length,
      closedTrades: closed.length, tp1Count: tp1.length, slCount: sl.length, beCount: be.length,
      totalPnl: parseFloat(totalPnl.toFixed(4)), totalFees: parseFloat(totalFees.toFixed(4)),
      winRate: winRate !== null ? parseFloat(winRate.toFixed(1)) : null,
      capital: cfg.startingCapital, config: cfg,
      recentSignals: this.recentSignals.slice(0, 50),
      scannerStatus: { lastScanAt: this.lastScanAt, scannedPairs: this.scannedCount, lastRawSignals: this.lastRawSignals, lastEmitted: this.lastEmitted, isScanning: this.isScanning },
    };
  }

  async getTrades(limit = 100) {
    return this.prisma.inst15mSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' }, take: limit });
  }

  async resetSim() {
    await this.prisma.inst15mSimulatedTrade.deleteMany({});
    await this.prisma.inst15mSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    this.recentSignals = [];
  }
}
