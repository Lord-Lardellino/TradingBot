import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';

// Morning / Evening Star — PURE PRICE ACTION
// Niente EMA, niente slope. Direzione dal pattern stesso.
//
// EVENING STAR (SHORT):
//   [GRANDE BULLISH] → [1-3 star piccole] → [GRANDE BEARISH ≈ prima] → ENTRY SHORT
//   Trigger chiude sotto il 50% (midpoint) della prima candela bullish
//
// MORNING STAR (LONG):
//   [GRANDE BEARISH] → [1-3 star piccole] → [GRANDE BULLISH ≈ prima] → ENTRY LONG
//   Trigger chiude sopra il midpoint della prima candela bearish

const SOURCE     = 'STAR';
const TF         = '1m';
const FEE        = 0.0006;
const EMA_PERIOD = 34;

type Grade = 'A+' | 'A' | 'B';

export interface StarSignal {
  id:                string;
  symbol:            string;
  direction:         'LONG' | 'SHORT';
  entry:             number;
  stopLoss:          number;
  takeProfit:        number;
  slPct:             number;
  tpPct:             number;
  suggestedLeverage: number;
  riskUsdt:          number;
  positionSize:      number;
  marginUsdt:        number;
  score:             number;
  grade:             Grade;
  emaSlope:          number;
  starCount:         number;
  volumeRatio:       number;
  feeRate:           number;
  reasons:           string[];
  timestamp:         string;
}

@Injectable()
export class StarScannerService implements OnModuleInit {
  private readonly logger = new Logger(StarScannerService.name);
  private exchange: ccxt.mexc;
  private markets: Record<string, any> = {};
  private top100: string[] = [];
  private lastSignals: StarSignal[] = [];
  private lastScanAt: string | null = null;
  private lastError: string | null = null;
  private isScanning = false;
  private debug: Record<string, number> = {};

  constructor(
    private config: ConfigService,
    private events: EventsGateway,
    private prisma: PrismaService,
    private liveTrading: LiveTradingService,
  ) {}

  async onModuleInit() {
    const apiKey = this.config.get<string>('MEXC_API_KEY', '');
    const secret = this.config.get<string>('MEXC_API_SECRET', '');
    const hasKeys = apiKey && apiKey !== 'your_api_key_here';
    this.exchange = new ccxt.mexc({
      ...(hasKeys ? { apiKey, secret } : {}),
      enableRateLimit: true,
      timeout: 8000,
      options: { defaultType: 'swap' },
    });
    try {
      this.markets = await this.exchange.loadMarkets();
    } catch (e: any) {
      this.logger.warn(`[STAR] loadMarkets: ${e?.message}`);
    }
    await this.refreshTop100();
    await this.ensureConfig();
    this.logger.log(`[STAR] Morning/Evening Star · Pure Price Action · 1m · ${this.top100.length} coppie`);
  }

  @Cron('0 0 * * * *')
  async refreshTop100() {
    try {
      const tickers = await this.exchange.fetchTickers();
      const list = Object.values(tickers)
        .filter((t: any) => t.symbol?.endsWith('/USDT:USDT') && t.quoteVolume > 0)
        .sort((a: any, b: any) => b.quoteVolume - a.quoteVolume)
        .slice(0, 100)
        .map((t: any) => t.symbol);
      if (list.length >= 10) {
        this.top100 = list;
        this.logger.log(`[STAR] Top 100 aggiornate: ${list.slice(0, 5).join(', ')}...`);
      }
    } catch (e: any) {
      this.logger.warn(`[STAR] refreshTop100: ${e?.message}`);
      if (!this.top100.length) {
        this.top100 = ['BTC/USDT:USDT','ETH/USDT:USDT','SOL/USDT:USDT','XRP/USDT:USDT','BNB/USDT:USDT'];
      }
    }
  }

  @Cron('30 * * * * *')
  async scan() {
    if (this.isScanning) return;
    const cfg = await this.ensureConfig();
    if (!cfg.enabled || !this.top100.length) return;

    this.debug = {};
    this.isScanning = true;
    const signals: StarSignal[] = [];

    try {
      for (let i = 0; i < this.top100.length; i += 2) {
        const batch = this.top100.slice(i, i + 2);
        await Promise.allSettled(batch.map(async sym => {
          try {
            const sig = await this.scanOne(sym, cfg);
            if (sig) signals.push(sig);
          } catch {
            this.bump('fetch_err');
          }
        }));
        if (i + 2 < this.top100.length) await new Promise(r => setTimeout(r, 280));
      }

      signals.sort((a, b) => b.score - a.score);
      this.lastSignals = signals;
      this.lastScanAt  = new Date().toISOString();
      this.lastError   = null;

      let slots = cfg.maxConcurrent - await this.openSimCount();

      for (const sig of signals) {
        this.events.emitStarSignal(sig);

        if (slots > 0 && cfg.autoEnter) {
          await this.enterSimTrade(sig, cfg);
          slots--;
        }

        if (cfg.liveEnabled) {
          const nextClose   = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
          const secsToClose = (nextClose - Date.now()) / 1000;
          if (secsToClose <= 60) {
            this.logger.log(`[STAR LIVE] ${sig.symbol} ${sig.direction} → entro (${Math.round(secsToClose)}s)`);
            this.liveTrading.enterTrade({
              symbol:              sig.symbol,
              direction:           sig.direction,
              grade:               sig.grade,
              entry:               sig.entry,
              slPct:               sig.slPct,
              tp1Pct:              sig.tpPct,
              suggestedLeverage:   sig.suggestedLeverage,
              score:               sig.score,
              stopLossPrice:       sig.stopLoss,
              takeProfitPrice:     sig.takeProfit,
              riskUsdt:            sig.riskUsdt,
              feeRate:             sig.feeRate,
              source:              SOURCE,
              sourceMaxConcurrent: cfg.maxConcurrent,
              bypassGlobalConfig:  true,
            }).catch(err => this.logger.error(`[STAR LIVE] ${sig.symbol}: ${err?.message}`));
          }
        }
      }
    } catch (e: any) {
      this.lastError = e?.message ?? String(e);
    } finally {
      this.isScanning = false;
      this.events.emitStarStatus(this.statusPayload());
      if (signals.length > 0 || Object.keys(this.debug).length > 0) {
        this.logger.log(`[STAR] signals=${signals.length} pairs=${this.top100.length} dbg=${JSON.stringify(this.debug)}`);
      }
    }
  }

  // ── Core: Morning / Evening Star + EMA34 directional bias ───────────────
  private calcEMA(closes: number[], period: number): number[] {
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    result.push(sum / period);
    for (let i = period; i < closes.length; i++)
      result.push(closes[i] * k + result[result.length - 1] * (1 - k));
    return result;
  }

  private async scanOne(symbol: string, cfg: any): Promise<StarSignal | null> {
    const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, undefined, 80) as number[][];
    if (!ohlcv || ohlcv.length < 50) { this.bump('no_candle'); return null; }

    const last   = ohlcv.length - 1;
    const closes = ohlcv.slice(0, last).map(c => c[4]);
    const emaAll = this.calcEMA(closes, EMA_PERIOD);
    if (emaAll.length < 15) { this.bump('no_ema'); return null; }

    const emaAt = (k: number): number | null => {
      const j = emaAll.length - 1 - k;
      return j >= 0 ? emaAll[j] : null;
    };
    const candleAt = (k: number): number[] | null => {
      const idx = last - 1 - k;
      return idx >= 0 && idx < ohlcv.length ? ohlcv[idx] : null;
    };

    // ── EMA34 slope: filtro direzionale ───────────────────────────────────
    const ema34Now = emaAt(0);
    const ema34_5  = emaAt(5);
    if (!ema34Now || !ema34_5) { this.bump('no_ema'); return null; }
    const emaSlope  = (ema34Now - ema34_5) / ema34Now * 100;
    const minSlope  = Number(cfg.minEmaSlope ?? 0.05);
    if (Math.abs(emaSlope) < minSlope) { this.bump('ema_flat'); return null; }

    const bullSlope = emaSlope > 0;
    const bearSlope = emaSlope < 0;

    // Consistenza slope: max 2 violazioni su 10 step
    const consistN = Number(cfg.emaSlopeConsistencyN ?? 10);
    let violations = 0;
    for (let k = 1; k <= consistN; k++) {
      const prev = emaAt(k), curr = emaAt(k - 1);
      if (!prev || !curr) { violations++; continue; }
      if (bullSlope && curr <= prev) violations++;
      if (bearSlope && curr >= prev) violations++;
    }
    if (violations > 2) { this.bump('slope_decelerating'); return null; }

    // ── Trigger (k=0): grande candela direzionale ─────────────────────────
    const trig = candleAt(0);
    if (!trig) { this.bump('no_candle'); return null; }
    const [ts, trigO, trigH, trigL, trigC, trigVol] = trig;
    if (!trigC || !trigVol || trigH <= trigL) { this.bump('no_candle'); return null; }

    const trigBullish   = trigC > trigO;
    const trigBearish   = trigC < trigO;
    if (!trigBullish && !trigBearish) { this.bump('trigger_doji'); return null; }

    const trigBody      = Math.abs(trigC - trigO);
    const trigRange     = trigH - trigL;
    const trigBodyRatio = trigRange > 0 ? trigBody / trigRange : 0;
    const minTrigBody   = Number(cfg.minTrigBodyRatio ?? 0.55);
    if (trigBodyRatio < minTrigBody) { this.bump('trigger_weak'); return null; }

    // Direzione trigger deve coincidere con slope EMA34
    if (trigBullish && bearSlope) { this.bump('trigger_vs_ema'); return null; }
    if (trigBearish && bullSlope) { this.bump('trigger_vs_ema'); return null; }
    const direction: 'LONG' | 'SHORT' = trigBullish ? 'LONG' : 'SHORT';

    // ── Star zone (k=1 a k=3): candele piccole consecutive ───────────────
    const maxStarBody = Number(cfg.maxStarBodyRatio ?? 0.45);
    let starCount = 0;
    let starHigh  = -Infinity;
    let starLow   = Infinity;

    for (let k = 1; k <= 3; k++) {
      const c = candleAt(k);
      if (!c) break;
      const cBody  = Math.abs(c[4] - c[1]);
      const cRange = c[2] - c[3];
      const cBodyR = cRange > 0 ? cBody / cRange : 0;
      if (cBodyR > maxStarBody) break;
      starCount++;
      starHigh = Math.max(starHigh, c[2]);
      starLow  = Math.min(starLow,  c[3]);
    }
    if (starCount === 0) { this.bump('no_star'); return null; }

    // Trigger > stelle in dimensione corpo
    let maxStarBodyAbs = 0;
    for (let k = 1; k <= starCount; k++) {
      const c = candleAt(k);
      if (c) maxStarBodyAbs = Math.max(maxStarBodyAbs, Math.abs(c[4] - c[1]));
    }
    if (trigBody <= maxStarBodyAbs) { this.bump('trigger_not_dominant'); return null; }

    // ── Prima candela (k=starCount+1): grande, direzione OPPOSTA al trigger ─
    const firstK      = starCount + 1;
    const firstCandle = candleAt(firstK);
    if (!firstCandle) { this.bump('no_first'); return null; }

    const [, fO, fH, fL, fC] = firstCandle;
    const fBody      = Math.abs(fC - fO);
    const fRange     = fH - fL;
    const fBodyRatio = fRange > 0 ? fBody / fRange : 0;
    const minFirstBody = Number(cfg.minFirstBodyRatio ?? 0.50);

    // La prima deve essere nella direzione OPPOSTA al trigger (classic star)
    if (direction === 'LONG'  && fC >= fO) { this.bump('first_dir'); return null; } // deve essere BEARISH
    if (direction === 'SHORT' && fC <= fO) { this.bump('first_dir'); return null; } // deve essere BULLISH
    if (fBodyRatio < minFirstBody) { this.bump('first_weak'); return null; }

    // ── Trigger ≈ prima candela in dimensione (quasi uguale) ─────────────
    const trigVsFirst = fBody > 0 ? trigBody / fBody : 0;
    if (trigVsFirst < 0.45 || trigVsFirst > 2.2) { this.bump('trigger_vs_first'); return null; }

    // ── Midpoint rule: il trigger chiude oltre il 50% della prima ─────────
    // Regola chiave dell'Evening/Morning Star: la candela finale "supera" la prima
    const fMidpoint = (fO + fC) / 2;
    if (direction === 'LONG'  && trigC < fMidpoint) { this.bump('no_midpoint'); return null; }
    if (direction === 'SHORT' && trigC > fMidpoint) { this.bump('no_midpoint'); return null; }

    // ── Star zone contenuta nel range della prima candela ─────────────────
    if (direction === 'LONG'  && starLow  < fL * 0.9985) { this.bump('star_breaks_first'); return null; }
    if (direction === 'SHORT' && starHigh > fH * 1.0015) { this.bump('star_breaks_first'); return null; }

    // ── Volume: trigger > media ultimi 15 candles ─────────────────────────
    const avgVol   = ohlcv.slice(Math.max(0, last - 16), last - 1).reduce((s: number, c: number[]) => s + c[5], 0) / 15;
    const volRatio = avgVol > 0 ? trigVol / avgVol : 1;
    if (volRatio < Number(cfg.minVolumeRatio ?? 1.0)) { this.bump('vol_weak'); return null; }

    // ── ADX: forza del trend in corso ─────────────────────────────────────
    const adxWindow = ohlcv.slice(Math.max(0, last - 22), last);
    const adx = this.calcADX(adxWindow, 14);
    if (adx < Number(cfg.minAdx ?? 18)) { this.bump('adx_weak'); return null; }

    // ── Cooldown ──────────────────────────────────────────────────────────
    if (Number(cfg.cooldownMinutes ?? 5) > 0) {
      const since  = new Date(Date.now() - cfg.cooldownMinutes * 60_000);
      const recent = await this.prisma.starSimulatedTrade.findFirst({
        where: { symbol, direction, openedAt: { gte: since } },
      });
      if (recent) { this.bump('cooldown'); return null; }
    }

    // ── SL: estremo della star zone ───────────────────────────────────────
    const entry   = trigC;
    const slPrice = direction === 'LONG'
      ? starLow  * (1 - 0.0003)
      : starHigh * (1 + 0.0003);
    const slPct   = Math.abs(entry - slPrice) / entry * 100;
    if (slPct < Number(cfg.minSlPct ?? 0.05)) { this.bump('sl_small'); return null; }
    if (slPct > Number(cfg.maxSlPct ?? 1.50)) { this.bump('sl_big');   return null; }

    // ── TP ────────────────────────────────────────────────────────────────
    const tpRr    = Number(cfg.tpRr ?? 1.5);
    const tpMove  = tpRr * (slPct / 100 + FEE * 2) + FEE * 2;
    const tpPrice = direction === 'LONG' ? entry * (1 + tpMove) : entry * (1 - tpMove);
    const tpPct   = Math.abs(entry - tpPrice) / entry * 100;

    // ── Sizing ────────────────────────────────────────────────────────────
    const riskUsdt     = Number(cfg.riskUsdt ?? 0.1);
    const positionSize = riskUsdt / (slPct / 100);
    const maxLev       = Number(this.markets[symbol]?.limits?.leverage?.max ?? 125) || 125;
    const leverage     = Math.max(1, Math.min(Math.ceil(positionSize / 5), maxLev, 125));
    const margin       = positionSize / leverage;

    // ── Score ─────────────────────────────────────────────────────────────
    const trigScore   = Math.min(30, trigBodyRatio / 0.8 * 30);
    const firstScore  = Math.min(20, fBodyRatio / 0.7 * 20);
    const volScore    = Math.min(15, (volRatio - 1) / 2 * 15);
    const starScore   = starCount === 1 ? 20 : starCount === 2 ? 15 : 10;
    const adxScore    = adx >= 25 ? 10 : adx >= 18 ? 5 : 0;
    const sizeScore   = Math.min(5, (1 - Math.abs(trigVsFirst - 1)) * 5);  // più sono simili, meglio
    const score = Math.round(trigScore + firstScore + volScore + starScore + adxScore + sizeScore);
    if (score < Number(cfg.minScore ?? 45)) { this.bump('score'); return null; }

    const grade: Grade = score >= 80 ? 'A+' : score >= 60 ? 'A' : 'B';
    this.bump('ok');

    const px = (p: number) => {
      try { return parseFloat(this.exchange.priceToPrecision(symbol, p)); } catch { return p; }
    };

    const patternName = direction === 'SHORT' ? 'Evening Star' : 'Morning Star';
    return {
      id:                `${SOURCE}_${symbol}_${ts}`,
      symbol,
      direction,
      entry:             px(entry),
      stopLoss:          px(slPrice),
      takeProfit:        px(tpPrice),
      slPct:             parseFloat(slPct.toFixed(4)),
      tpPct:             parseFloat(tpPct.toFixed(4)),
      suggestedLeverage: leverage,
      riskUsdt:          parseFloat(riskUsdt.toFixed(2)),
      positionSize:      parseFloat(positionSize.toFixed(4)),
      marginUsdt:        parseFloat(margin.toFixed(4)),
      score,
      grade,
      emaSlope:          parseFloat(emaSlope.toFixed(4)),
      starCount,
      volumeRatio:       parseFloat(volRatio.toFixed(3)),
      feeRate:           FEE,
      reasons: [
        `${patternName} · ${starCount} star candle${starCount > 1 ? 's' : ''}`,
        `Prima: ${direction === 'SHORT' ? 'BULLISH' : 'BEARISH'} ${(fBodyRatio*100).toFixed(0)}% — Trigger: ${(trigBodyRatio*100).toFixed(0)}%`,
        `Trigger/Prima ratio: ${trigVsFirst.toFixed(2)} · Midpoint ✓`,
        `EMA34 slope ${emaSlope >= 0 ? '+' : ''}${emaSlope.toFixed(3)}% · Vol ${volRatio.toFixed(1)}x · ADX ${adx.toFixed(1)}`,
        `SL @ star zone ${slPct.toFixed(2)}% · TP ${tpPct.toFixed(2)}%`,
      ],
      timestamp: new Date(ts + 60_000).toISOString(),
    };
  }

  // ── Sim trades ────────────────────────────────────────────────────────────
  private async enterSimTrade(sig: StarSignal, cfg: any) {
    if (await this.prisma.starSimulatedTrade.findFirst({ where: { symbol: sig.symbol, status: 'open' } })) return;
    const capital = await this.currentCapital(cfg);
    await this.prisma.starSimulatedTrade.create({
      data: {
        id:           sig.id,  symbol:       sig.symbol,  direction:    sig.direction,
        entry:        sig.entry, stopLoss:   sig.stopLoss, takeProfit:  sig.takeProfit,
        slPct:        sig.slPct, tpPct:      sig.tpPct,   leverage:    sig.suggestedLeverage,
        riskUsdt:     sig.riskUsdt, positionSize: sig.positionSize, marginUsdt: sig.marginUsdt,
        score:        sig.score, grade:      sig.grade,   starCount:   sig.starCount,
        emaSlope:     sig.emaSlope,
        volumeRatio:  sig.volumeRatio, feeRate: sig.feeRate,
        fees:         sig.positionSize * sig.feeRate,
        capitalBefore: capital, status: 'open',
      },
    });
  }

  @Cron('* * * * * *')
  async checkSimTrades() {
    const open = await this.prisma.starSimulatedTrade.findMany({ where: { status: 'open' } });
    if (!open.length) return;
    const symbols = [...new Set(open.map(t => t.symbol))];
    let tickers: Record<string, any> = {};
    try { tickers = await this.exchange.fetchTickers(symbols) as Record<string, any>; } catch { return; }

    for (const trade of open) {
      const ticker = tickers[trade.symbol];
      if (!ticker) continue;
      const last = Number(ticker.last ?? 0);
      if (!last) continue;
      const isLong  = trade.direction === 'LONG';
      const bid = Number(ticker.bid ?? last), ask = Number(ticker.ask ?? last);
      if (isLong ? bid <= Number(trade.stopLoss)  : ask >= Number(trade.stopLoss))  { await this.closeSimTrade(trade, Number(trade.stopLoss),  'sl'); continue; }
      if (isLong ? ask >= Number(trade.takeProfit): bid <= Number(trade.takeProfit)) { await this.closeSimTrade(trade, Number(trade.takeProfit), 'tp'); continue; }
      const pctDiff = isLong ? (last - trade.entry) / trade.entry * 100 : (trade.entry - last) / trade.entry * 100;
      this.events.emitStarPositions([{ id: trade.id, currentPrice: last, currentR: Number(trade.slPct) > 0 ? parseFloat((pctDiff / Number(trade.slPct)).toFixed(2)) : 0, unrealizedPnl: parseFloat((trade.positionSize * (pctDiff / 100) - (trade.fees ?? 0)).toFixed(4)) }]);
    }
  }

  private async closeSimTrade(trade: any, closePrice: number, status: string) {
    const isLong = trade.direction === 'LONG';
    const diff   = isLong ? (closePrice - trade.entry) / trade.entry : (trade.entry - closePrice) / trade.entry;
    const fee    = trade.positionSize * Number(trade.feeRate ?? FEE);
    const pnl    = trade.positionSize * diff - ((trade.fees ?? 0) + fee);
    const u = await this.prisma.starSimulatedTrade.update({
      where: { id: trade.id },
      data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(((trade.fees ?? 0) + fee).toFixed(6)), capitalAfter: parseFloat(((trade.capitalBefore ?? 0) + pnl).toFixed(4)), closedAt: new Date() },
    });
    this.events.emitStarTrade(u);
  }

  // ── ADX ───────────────────────────────────────────────────────────────────
  private calcADX(candles: number[][], period = 14): number {
    if (candles.length < period + 2) return 0;
    const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const [,,h,l] = candles[i], [,,ph,pl,pc] = candles[i-1];
      trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
      const up = h-ph, dn = pl-l;
      plusDMs.push(up > dn && up > 0 ? up : 0);
      minusDMs.push(dn > up && dn > 0 ? dn : 0);
    }
    const sm = (a: number[]) => { let v = a.slice(0, period).reduce((x,y)=>x+y,0); for (let i=period;i<a.length;i++) v=v-v/period+a[i]; return v; };
    const atr = sm(trs); if (!atr) return 0;
    const pdi = sm(plusDMs)/atr*100, mdi = sm(minusDMs)/atr*100, s = pdi+mdi;
    return s ? parseFloat((Math.abs(pdi-mdi)/s*100).toFixed(1)) : 0;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private bump(k: string) { this.debug[k] = (this.debug[k] ?? 0) + 1; }
  private async openSimCount() { return this.prisma.starSimulatedTrade.count({ where: { status: 'open' } }); }
  private async currentCapital(cfg: any) {
    const last = await this.prisma.starSimulatedTrade.findFirst({ where: { capitalAfter: { not: null } }, orderBy: { openedAt: 'desc' } });
    return last?.capitalAfter ?? cfg.startingCapital ?? 50;
  }
  private async ensureConfig() {
    const c = await this.prisma.starConfig.findUnique({ where: { id: 1 } });
    if (c) return c;
    return this.prisma.starConfig.create({ data: { id: 1 } });
  }
  private statusPayload() {
    return { isScanning: this.isScanning, lastScanAt: this.lastScanAt, lastError: this.lastError, symbols: this.top100.length, debug: this.debug };
  }

  // ── API ───────────────────────────────────────────────────────────────────
  async getAnalytics() {
    const cfg = await this.ensureConfig();
    const trades = await this.prisma.starSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const wins   = closed.filter(t => (t.pnl ?? 0) > 0);
    const losses = closed.filter(t => (t.pnl ?? 0) <= 0);
    return {
      config: cfg,
      totalPnl:     parseFloat(closed.reduce((s,t) => s + (t.pnl ?? 0), 0).toFixed(2)),
      winRate:      closed.length ? parseFloat((wins.length / closed.length * 100).toFixed(1)) : 0,
      closedTrades: closed.length, openTrades: trades.filter(t => t.status === 'open').length,
      avgWin:       wins.length   ? parseFloat((wins.reduce((s,t)=>s+(t.pnl??0),0)/wins.length).toFixed(2)) : 0,
      avgLoss:      losses.length ? parseFloat((losses.reduce((s,t)=>s+(t.pnl??0),0)/losses.length).toFixed(2)) : 0,
      recentSignals: this.lastSignals, scannerStatus: this.statusPayload(),
      openTradesList: trades.filter(t => t.status === 'open'),
      closedTradesList: closed.slice(0, 100),
    };
  }

  async updateConfig(data: any) {
    const allowed = ['startingCapital','riskUsdt','tpRr','maxConcurrent','enabled','autoEnter','liveEnabled','minScore','minAdx','minTrigBodyRatio','maxStarBodyRatio','minFirstBodyRatio','minVolumeRatio','minSlPct','maxSlPct','cooldownMinutes'];
    const patch: any = {};
    for (const k of allowed) { if (data[k] !== undefined) patch[k] = data[k]; }
    return this.prisma.starConfig.update({ where: { id: 1 }, data: patch });
  }

  async resetSim()            { await this.prisma.starSimulatedTrade.deleteMany({}); }
  getSignals(limit = 50)      { return this.lastSignals.slice(0, limit); }
  getStatus()                 { return this.statusPayload(); }

  async getCandles(symbol: string, limit = 120, from?: number, live = false) {
    try {
      const since = Number.isFinite(from) && from && from > 0 ? from : undefined;
      const ohlcv = await this.exchange.fetchOHLCV(symbol, TF, since, limit + 1) as number[][];
      const candles = live ? ohlcv : ohlcv.slice(0, -1);
      const closes  = candles.map(c => c[4]);
      const emaVals = this.calcEMA(closes, EMA_PERIOD);
      const offset  = closes.length - emaVals.length;
      return candles.map((c, i) => ({
        time:  Math.floor(c[0] / 1000),
        open:  c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
        ema34: i >= offset ? parseFloat(emaVals[i - offset].toFixed(8)) : null,
      }));
    } catch { return []; }
  }
}
