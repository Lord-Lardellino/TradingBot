import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import * as ccxt from 'ccxt';
import { IndicatorsService } from '../indicators/indicators.service';
import { EventsGateway } from '../events/events.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { LiveTradingService } from '../live/live-trading.service';

const TIMEFRAME       = '5m';
const CANDLES         = 100;          // ~8h di contesto
const MIN_VOLUME_24H  = 80_000;       // bassa soglia: più coppie, più segnali
const MIN_TRIGGER_VOL_R = 1.0;        // evita trigger sotto-volume: troppi falsi breakout
const SIGNAL_COOLDOWN = 5 * 60_000;  // 5 min = 1 candela 5m → no duplicati
const BATCH_SIZE      = 5;            // batch piccoli — meno connessioni parallele, meno fetch_err
const TAKER_FEE       = 0.00038;
const RISK_EUR        = 2.0;
const MAX_FEE_TO_RISK = 0.55;

const PT_MOMENTUM      = 1;  // pullback/bounce ordinato sulla SMA34
const PT_IMPULSE_BREAK = 2;  // rottura impulsiva pulita, senza pullback stretto

export interface InstSignal {
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
  ema9spark: number[];
  ema21spark: number[];
  ema50spark: number[];
}

@Injectable()
export class InstScannerService implements OnModuleInit {
  private readonly logger = new Logger(InstScannerService.name);
  private exchange: ccxt.mexc;
  private fastExchange: ccxt.mexc; // no rate limiter — solo per public OHLCV in batch
  private validSymbols = new Set<string>();
  private recentSignals: InstSignal[] = [];
  private isScanning = false;
  private lastScanAt: string | null = null;
  private scannedCount = 0;
  private lastRawSignals = 0;
  private lastEmitted = 0;
  private cooldowns = new Map<string, number>();
  private readonly sessionStart = new Date();
  private dbg: Record<string, number> = {};
  private lastScanPairList: string[] = [];
  private trendCandidates: { sym: string; dir: string; reason: string }[] = [];
  private nearMisses:      { sym: string; dir: string; reason: string }[] = [];
  private tickerCache: Record<string, any> = {};

  @Interval(30000)
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
    // Istanza veloce senza rate limiter per fetch OHLCV pubblici in parallelo
    this.fastExchange = new ccxt.mexc({
      enableRateLimit: false,
      options: { defaultType: 'swap' },
    });
    await this.loadMarkets();
    await this.initConfig();
    this.logger.log(`[INST5m] ${this.validSymbols.size} coppie · TF=5m · scan ogni 1min · 3 pattern istituzionali`);
  }

  @Cron('0 0 * * * *')
  async loadMarkets() {
    try {
      const markets = await this.exchange.loadMarkets(true);
      // Condividi i dati di mercato con fastExchange senza re-fetch
      this.fastExchange.markets         = this.exchange.markets;
      this.fastExchange.markets_by_id   = this.exchange.markets_by_id;
      this.fastExchange.currencies      = this.exchange.currencies;
      this.fastExchange.currencies_by_id = this.exchange.currencies_by_id;
      this.validSymbols = new Set(Object.keys(markets).filter(s => s.endsWith('/USDT:USDT')));
    } catch (err: any) { this.logger.error(`loadMarkets: ${err.message}`); }
  }

  // ── SCAN 4s prima della chiusura candela 5m — ordine nella finestra ±1s dal close
  @Cron('44 4,9,14,19,24,29,34,39,44,49,54,59 * * * *')
  async scan() {
    if (this.isScanning || this.validSymbols.size === 0) return;
    this.isScanning = true;
    try {
      const cfg = await this.getConfig();
      // tickers dalla cache (già pronti), openSymbols in parallelo con config
      const tickers = Object.keys(this.tickerCache).length > 0
        ? this.tickerCache
        : await this.exchange.fetchTickers([...this.validSymbols]);
      const btcBias    = 'neutral'; // non bloccante — bias rimosso dal path critico
      const openSymbols = await this.getOpenSymbolsSet();

      const candidates = Object.values(tickers)
        .filter(t => this.validSymbols.has(t.symbol) && (t.quoteVolume ?? 0) >= MIN_VOLUME_24H && !openSymbols.has(t.symbol))
        .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
        .slice(0, 25);
      this.scannedCount = candidates.length;
      this.dbg = {};
      this.trendCandidates = [];
      this.nearMisses = [];
      this.lastScanPairList = candidates.map(t => t.symbol.replace('/USDT:USDT', ''));
      this.logger.log(`[INST5m] BTC bias: ${btcBias} · scansiono ${candidates.length} pair`);

      const openCount = await this.prisma.instSimulatedTrade.count({
        where: { status: 'open', openedAt: { gte: this.sessionStart } },
      });
      if (openCount >= cfg.maxConcurrent) {
        this.isScanning = false;
        this._emitStatus(cfg, candidates.length, 0, 0);
        return;
      }

      // Fetch OHLCV in batch paralleli — molto più veloce del sequenziale
      const cycleSignals: InstSignal[] = [];
      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
          batch.map(async ticker => {
            try {
              const raw = await this.fastExchange.fetchOHLCV(ticker.symbol, TIMEFRAME, undefined, CANDLES);
              try {
                return this.analyzePair(ticker.symbol, raw, cfg, btcBias);
              } catch {
                this.dbg['analyze_err'] = (this.dbg['analyze_err'] ?? 0) + 1;
                return null;
              }
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
      this.logger.log(`[INST5m DBG] raw=${cycleSignals.length} ${JSON.stringify(this.dbg)}`);

      // Best LONG + best SHORT per ciclo
      const bestLong  = cycleSignals.filter(s => s.direction === 'LONG').sort((a, b) => b.score - a.score)[0];
      const bestShort = cycleSignals.filter(s => s.direction === 'SHORT').sort((a, b) => b.score - a.score)[0];
      const best = [bestLong, bestShort].filter(Boolean) as InstSignal[];

      const toProcess = best.filter(sig => {
        const last = this.cooldowns.get(sig.symbol) ?? 0;
        return Date.now() - last >= SIGNAL_COOLDOWN;
      });
      for (const sig of toProcess) this.cooldowns.set(sig.symbol, Date.now());

      let emitted = 0;
      for (const sig of toProcess) {
        this.recentSignals.unshift(sig);
        if (this.recentSignals.length > 200) this.recentSignals.pop();
        this.events.emitInstSignal(sig);
        if (cfg.autoEnter) {
          await this.enterSimTrade(sig, cfg).catch(() => {});
        }
        if (cfg.liveEnabled) {
          await this.liveTrading.enterTrade({
            symbol: sig.symbol, direction: sig.direction, grade: sig.grade,
            entry: sig.entry, slPct: sig.slPct, tp1Pct: sig.tpPct,
            suggestedLeverage: sig.suggestedLeverage, score: sig.score,
            stopLossPrice: sig.stopLoss,
            takeProfitPrice: sig.takeProfit1,
          }).catch(err => this.logger.error(`[INST LIVE] ${err.message}`));
        }
        emitted++;
        this.logger.log(`[INST5m ✅] ${sig.direction} ${sig.symbol} ${sig.patternName} score=${sig.score} grade=${sig.grade}`);
      }
      this.lastEmitted = emitted;
      this._emitStatus(cfg, candidates.length, cycleSignals.length, emitted);
    } catch (err: any) { this.logger.error(`Inst scan: ${err.message}`); }
    finally { this.isScanning = false; }
  }

  // ── CHECK OPEN TRADES ogni 30s ──────────────────────────────────────────────
  @Cron('*/30 * * * * *')
  async checkOpenTrades() {
    try {
      const open = await this.prisma.instSimulatedTrade.findMany({
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

          this.events.emitInstPositions([{
            id: t.id,
            currentPrice: curr,
            unrealizedPnl: parseFloat(((curr - t.entry) / t.entry * (isLong ? 1 : -1) * t.positionSize).toFixed(4)),
            unrealizedPnlPct: parseFloat(((curr - t.entry) / t.entry * (isLong ? 1 : -1) * 100).toFixed(3)),
          }]);

          // Break-Even — usa high/low della candela per non perdere tocchi intracandle
          const tpDist   = Math.abs(t.takeProfit1 - t.entry);
          const bePrice  = isLong ? t.entry + tpDist * 0.5 : t.entry - tpDist * 0.5;
          const beActive = isLong ? t.stopLoss >= t.entry * 0.9999 : t.stopLoss <= t.entry * 1.0001;
          const beHit    = isLong ? candleHigh >= bePrice : candleLow <= bePrice;
          if (!beActive && beHit) {
            await this.prisma.instSimulatedTrade.update({ where: { id: t.id }, data: { stopLoss: t.entry } });
            this.logger.log(`[INST5m BE] ${t.symbol} BE attivato — SL spostato a entry ${t.entry}`);
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

          await this.prisma.instSimulatedTrade.update({
            where: { id: t.id },
            data: { status, closePrice, pnl: parseFloat(pnl.toFixed(4)), fees: parseFloat(totalFees.toFixed(4)), capitalAfter: parseFloat(capitalAfter.toFixed(4)), closedAt: new Date() },
          });
          if (cfg.autoEnter) {
            await this.prisma.instSimConfig.update({ where: { id: 1 }, data: { startingCapital: parseFloat(capitalAfter.toFixed(4)) } });
          }
          const updated = await this.prisma.instSimulatedTrade.findUnique({ where: { id: t.id } });
          this.events.emitInstTrade(updated);
          this.logger.log(`[INST5m CLOSE] ${t.symbol} ${status.toUpperCase()} PnL ${pnl >= 0 ? '+' : ''}€${pnl.toFixed(3)}`);
        } catch { /* skip */ }
      }
    } catch (err: any) { this.logger.error(`Inst checkOpen: ${err.message}`); }
  }

  // ── ANALISI PATTERN SU SINGOLA COPPIA — PRICE ACTION PURA ──────────────────
  private analyzePair(sym: string, raw: number[][], cfg: any, _btcBias: string): InstSignal | null {
    const n = raw.length;
    if (n < 30) { this.dbg['no_data'] = (this.dbg['no_data'] ?? 0) + 1; return null; }

    const o = raw.map(r => r[1] as number);
    const h = raw.map(r => r[2] as number);
    const l = raw.map(r => r[3] as number);
    const c = raw.map(r => r[4] as number);
    const v = raw.map(r => r[5] as number);

    // Indice dinamico: se siamo entro 8s dalla chiusura, usa n-1 (candela in formazione)
    const TF_MS = 5 * 60_000;
    const lastTs = raw[n-1][0] as number;
    const timeUntilClose = (lastTs + TF_MS) - Date.now();
    const ti = timeUntilClose <= 10_000 ? n - 1 : n - 2; // trigger index

    const entry = c[ti];
    if (!entry || entry <= 0) return null;

    const atr14  = this.indicators.atr(h, l, c, 14);
    if (atr14 <= 0) return null;
    const atrPct = atr14 / entry * 100;

    // Volume ratio (20 candele prima del trigger)
    const volWindow = v.slice(ti - 20, ti);
    const avgVol    = volWindow.reduce((a, b) => a + b, 0) / volWindow.length;
    const volR      = avgVol > 0 ? v[ti] / avgVol : 1;

    // Candela trigger
    const cO = o[ti], cH = h[ti], cL = l[ti], cC = c[ti];
    const body        = Math.abs(cC - cO);
    const candleRange = cH - cL || atr14 * 0.01;
    const closePos    = (cC - cL) / candleRange;

    // SMA 34 — media esatta, nessun problema di warmup
    const sma34     = c.slice(ti - 33, ti + 1).reduce((a, b) => a + b, 0) / 34;
    const sma34_5   = c.slice(ti - 38, ti - 4).reduce((a, b) => a + b, 0) / 34; // SMA 5 candele fa
    if (sma34 <= 0) { this.dbg['no_sma34'] = (this.dbg['no_sma34'] ?? 0) + 1; return null; }

    const smaSlope   = sma34 - sma34_5;
    const smaRising  = smaSlope >=  atr14 * 0.05;
    const smaFalling = smaSlope <= -atr14 * 0.05;
    // LONG: cattura bounce (cL > sma34) e cross dal basso (cC > sma34, cL <= sma34)
    // SHORT: solo candele interamente sotto SMA (cH < sma34) — evita falsi segnali sopra SMA
    const longTrend  = cC > sma34 && smaRising;
    const shortTrend = cC < sma34 && smaFalling;
    const isCrossLong  = longTrend && cL <= sma34;
    const isCrossShort = shortTrend && cH >= sma34;

    // Wick sul lato debole
    const lowerWick = Math.min(cO, cC) - cL;
    const upperWick = cH - Math.max(cO, cC);
    const maxWeakWick = Math.min(atr14 * 0.05, candleRange * 0.15);
    const weakLong  = lowerWick <= maxWeakWick;
    const weakShort = upperWick <= maxWeakWick;

    // ── PATTERN: MOMENTUM CANDLE ────────────────────────────────────────────
    const prevBullish = [1,2,3].filter(i => c[ti-i] > o[ti-i]).length;
    const prevBearish = [1,2,3].filter(i => c[ti-i] < o[ti-i]).length;
    // LONG cross: basta 1 bullish precedente; LONG bounce: 2+
    // SHORT: basta 1 bearish — catchare la prima candela dopo il bounce/cross
    // Pullback recente alla SMA (LONG: max 1.5×ATR sopra; SHORT: max 1.0×ATR sotto — più stretto)
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

    // Debug granulare
    if (longTrend || shortTrend)  this.dbg['trend_ok']  = (this.dbg['trend_ok']  ?? 0) + 1;
    if (trendMomentum)            this.dbg['mom_ok']    = (this.dbg['mom_ok']    ?? 0) + 1;
    const trendWick = (longTrend && weakLong) || (shortTrend && weakShort);
    if (trendWick)               this.dbg['wick_ok']  = (this.dbg['wick_ok']  ?? 0) + 1;
    if (longTrend || shortTrend) this.dbg[volumeOk ? 'vol_ok' : 'vol_low'] = (this.dbg[volumeOk ? 'vol_ok' : 'vol_low'] ?? 0) + 1;
    const trendBody = (longTrend && cC > cO && body >= atr14 * 1.2) || (shortTrend && cC < cO && body >= atr14 * 1.2);
    if (trendBody)               this.dbg['body_ok']  = (this.dbg['body_ok']  ?? 0) + 1;
    if (momLong || momShort)     this.dbg['raw_mom']  = (this.dbg['raw_mom']  ?? 0) + 1;
    if (impulseLong || impulseShort) this.dbg['raw_impulse'] = (this.dbg['raw_impulse'] ?? 0) + 1;

    // Trend candidates: track perché ogni coppia con trend fallisce
    if (longTrend || shortTrend) {
      const dir = longTrend ? 'L' : 'S';
      if (!trendMomentum)                                      this.trendCandidates.push({ sym, dir, reason: 'no_mom' });
      else if (longTrend && !hadPullbackLong && !impulseLong)  this.trendCandidates.push({ sym, dir, reason: `no_pullback (×${smaDistLong.toFixed(1)}ATR)` });
      else if (shortTrend && !hadPullbackShort && !impulseShort) this.trendCandidates.push({ sym, dir, reason: `no_pullback (×${smaDistShort.toFixed(1)}ATR)` });
      else if (!trendWick)                                     this.trendCandidates.push({ sym, dir, reason: 'wick_fail' });
      else if (body < atr14*0.5)                               this.trendCandidates.push({ sym, dir, reason: `body_small ×${(body/atr14).toFixed(1)}` });
      else if (longTrend && !triggerLong)                      this.trendCandidates.push({ sym, dir, reason: 'bad_trigger_wick_close' });
      else if (shortTrend && !triggerShort)                    this.trendCandidates.push({ sym, dir, reason: 'bad_trigger_wick_close' });
      else if (!volumeOk)                                      this.trendCandidates.push({ sym, dir, reason: `vol_low ×${volR.toFixed(1)}` });
      else if (!(momLong || momShort || impulseLong || impulseShort)) this.trendCandidates.push({ sym, dir, reason: 'close_pos' });
    }

    let isLong: boolean;
    let patternType: number;
    let patternName: string;

    if      (impulseLong)  { isLong = true;  patternType = PT_IMPULSE_BREAK; patternName = 'IMPULSE_BREAK'; }
    else if (impulseShort) { isLong = false; patternType = PT_IMPULSE_BREAK; patternName = 'IMPULSE_BREAK'; }
    else if (momLong)      { isLong = true;  patternType = PT_MOMENTUM;      patternName = 'MOMENTUM'; }
    else if (momShort)     { isLong = false; patternType = PT_MOMENTUM;      patternName = 'MOMENTUM'; }
    else { this.dbg['no_pattern'] = (this.dbg['no_pattern'] ?? 0) + 1; return null; }

    const _dir = isLong ? 'L' : 'S';
    const _nm  = (reason: string) => { this.nearMisses.push({ sym, dir: _dir, reason }); };

    // ── SL: apertura della candela trigger — se torna lì il pattern è fallito
    const slLevel = cO;

    const slPct = isLong
      ? (entry - slLevel) / entry * 100
      : (slLevel - entry) / entry * 100;

    // Max 2× ATR — esclude spike già esplosi, entry troppo tardiva
    if (body > atr14 * 1.6) {
      this.dbg['too_big'] = (this.dbg['too_big'] ?? 0) + 1; _nm('body_too_big'); return null;
    }

    if (slPct <= 0) return null;

    const estimatedRoundTripFee = (RISK_EUR / (slPct / 100)) * TAKER_FEE * 2;
    if (estimatedRoundTripFee > RISK_EUR * MAX_FEE_TO_RISK) {
      this.dbg['fee_too_high'] = (this.dbg['fee_too_high'] ?? 0) + 1;
      _nm(`fee_${estimatedRoundTripFee.toFixed(2)}`);
      return null;
    }

    // Candela in formazione (n-1) non deve contraddire la direzione — evita entry su rimbalzi
    if (ti === n - 2) {
      const fBody = Math.abs(c[n-1] - o[n-1]);
      if ( isLong && c[n-1] < o[n-1] && fBody > atr14 * 0.25) { this.dbg['forming_contra'] = (this.dbg['forming_contra'] ?? 0) + 1; _nm('forming_bearish'); return null; }
      if (!isLong && c[n-1] > o[n-1] && fBody > atr14 * 0.25) { this.dbg['forming_contra'] = (this.dbg['forming_contra'] ?? 0) + 1; _nm('forming_bullish'); return null; }
    }

    // ── SCORING ──────────────────────────────────────────────────────────────
    // Range body effettivo: 0.5–1.2×ATR (imposto dai filtri sopra)
    // Sweet spot pre-breakout: 0.6–0.9×ATR — corpo non troppo piccolo, non già esploso
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
    // bodyMult < 0.65 o prossimo al min: 0 punti — setup debole

    if      (isLong  && closePos >= 0.90) { score += 15; reasons.push('StrongClose'); }
    else if (isLong  && closePos >= 0.80) { score += 10; reasons.push('GoodClose'); }
    else if (isLong  && closePos >= 0.65) { score +=  5; }
    else if (!isLong && closePos <= 0.10) { score += 15; reasons.push('StrongClose'); }
    else if (!isLong && closePos <= 0.20) { score += 10; reasons.push('GoodClose'); }
    else if (!isLong && closePos <= 0.35) { score +=  5; }

    if      (volR >= 2.5) { score += patternName === 'IMPULSE_BREAK' ? 18 : 15; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.8) { score += patternName === 'IMPULSE_BREAK' ? 12 : 10; reasons.push(`Vol×${volR.toFixed(1)}`); }
    else if (volR >= 1.3) { score += patternName === 'IMPULSE_BREAK' ?  7 :  5; }

    // Bonus cross SMA (setup più pulito)
    if (isCrossLong) { score += 5; reasons.push('CrossSMA'); }
    if (isCrossShort) { score += 5; reasons.push('CrossSMA'); }

    if (score < cfg.minScore) { this.dbg['score_low'] = (this.dbg['score_low'] ?? 0) + 1; _nm(`score_${score}<${cfg.minScore}`); return null; }

    // Score range reale: 40–95 — soglie ricalibrate
    const grade: 'A+' | 'A' | 'B' = score >= 75 ? 'A+' : score >= 60 ? 'A' : 'B';

    // ── BUILD SIGNAL ─────────────────────────────────────────────────────────
    const tpPct    = slPct * cfg.tpRr;
    const tp1      = isLong ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
    const leverage = Math.min(20, Math.max(3, Math.round(1 / (slPct / 100) * 0.5)));
    const ticker   = sym.replace('/USDT:USDT', '');
    const sparkStart = Math.max(0, n - 60);
    const sparkline  = raw.slice(sparkStart).map(r => ({ t: r[0] as number, o: r[1] as number, h: r[2] as number, l: r[3] as number, c: r[4] as number }));

    this.dbg['PRE_SIG'] = (this.dbg['PRE_SIG'] ?? 0) + 1;

    return {
      id: `inst_${sym}_${Date.now()}`,
      symbol: sym,
      direction: isLong ? 'LONG' : 'SHORT',
      patternType, patternName,
      entry,
      stopLoss:    parseFloat(slLevel.toPrecision(6)),
      takeProfit1: parseFloat(tp1.toPrecision(6)),
      slPct:       parseFloat(slPct.toFixed(3)),
      tpPct:       parseFloat(tpPct.toFixed(3)),
      suggestedLeverage: leverage,
      volumeRatio: parseFloat(volR.toFixed(2)),
      rsi14:  0,
      atrPct: parseFloat(atrPct.toFixed(3)),
      score, grade, reasons,
      timestamp: new Date().toISOString(),
      mexcUrl: `https://futures.mexc.com/exchange/${ticker}_USDT`,
      sparkline, ema9spark: [], ema21spark: [], ema50spark: [],
    };
  }

  // ── ENTER SIM TRADE ─────────────────────────────────────────────────────────
  private async enterSimTrade(sig: InstSignal, cfg: any) {
    const already = await this.prisma.instSimulatedTrade.findFirst({
      where: { symbol: sig.symbol, status: 'open' },
    });
    if (already) return;

    const capital = cfg.startingCapital;
    const pos     = RISK_EUR / (sig.slPct / 100); // posizione: sempre RISK_EUR / slPct
    const margin  = pos / sig.suggestedLeverage;
    const fee     = pos * TAKER_FEE;

    const trade = await this.prisma.instSimulatedTrade.create({
      data: {
        id: sig.id,
        symbol: sig.symbol, direction: sig.direction,
        patternType: sig.patternType, patternName: sig.patternName,
        entry: sig.entry, stopLoss: sig.stopLoss, takeProfit1: sig.takeProfit1,
        leverage: sig.suggestedLeverage,
        riskEur: RISK_EUR,
        positionSize: parseFloat(pos.toFixed(4)),
        marginEur: parseFloat(margin.toFixed(4)),
        grade: sig.grade, score: sig.score,
        fees: parseFloat(fee.toFixed(6)),
        capitalBefore: parseFloat(capital.toFixed(4)),
      },
    });
    this.events.emitInstTrade(trade);
  }

  private async getOpenSymbolsSet(): Promise<Set<string>> {
    const open = await this.prisma.instSimulatedTrade.findMany({
      where: { status: 'open', openedAt: { gte: this.sessionStart } },
      select: { symbol: true },
    });
    return new Set(open.map(t => t.symbol));
  }

  private _emitStatus(cfg: any, candidates: number, rawSignals: number, emitted: number) {
    this.events.server.emit('inst:status', {
      lastScanAt: new Date().toISOString(),
      scannedPairs: this.scannedCount,
      candidates, rawSignals, emitted,
      isScanning: false,
      debug: { ...this.dbg },
      trendCandidates: this.trendCandidates.slice(0, 30),
      nearMisses: this.nearMisses.slice(0, 20),
      lastScanPairs: this.lastScanPairList,
      config: { minScore: cfg.minScore, atrSlMult: cfg.atrSlMult, tpRr: cfg.tpRr },
    });
  }

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  private async initConfig() {
    const exists = await this.prisma.instSimConfig.findUnique({ where: { id: 1 } });
    if (!exists) {
      await this.prisma.instSimConfig.create({
        data: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 40, atrSlMult: 0.5, tpRr: 3.0, liveEnabled: false },
      });
    }
  }

  async getConfig() {
    let cfg = await this.prisma.instSimConfig.findUnique({ where: { id: 1 } });
    if (!cfg) {
      cfg = await this.prisma.instSimConfig.create({
        data: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 3.0, liveEnabled: false },
      });
    }
    return cfg;
  }

  async updateConfig(data: any) {
    return this.prisma.instSimConfig.upsert({
      where: { id: 1 },
      create: { id: 1, startingCapital: 500, maxConcurrent: 5, autoEnter: true, minScore: 50, atrSlMult: 0.5, tpRr: 3.0, liveEnabled: false, ...data },
      update: data,
    });
  }

  // ── ANALYTICS ───────────────────────────────────────────────────────────────
  async getAnalytics() {
    const cfg    = await this.getConfig();
    const trades = await this.prisma.instSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' } });
    const closed = trades.filter(t => t.status !== 'open');
    const tp1    = closed.filter(t => t.status === 'tp1');
    const sl     = closed.filter(t => t.status === 'sl');
    const be     = closed.filter(t => t.status === 'be');
    const totalPnl   = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const totalFees  = trades.reduce((s, t) => s + (t.fees ?? 0), 0);
    const winRate    = tp1.length + sl.length > 0 ? tp1.length / (tp1.length + sl.length) * 100 : null;

    const byPattern: Record<string, { tp: number; sl: number; be: number }> = {};
    for (const t of closed) {
      if (!byPattern[t.patternName]) byPattern[t.patternName] = { tp: 0, sl: 0, be: 0 };
      if (t.status === 'tp1') byPattern[t.patternName].tp++;
      if (t.status === 'sl')  byPattern[t.patternName].sl++;
      if (t.status === 'be')  byPattern[t.patternName].be++;
    }

    return {
      totalTrades: trades.length,
      openTrades:  trades.filter(t => t.status === 'open').length,
      closedTrades: closed.length,
      tp1Count: tp1.length, slCount: sl.length, beCount: be.length,
      totalPnl: parseFloat(totalPnl.toFixed(4)),
      totalFees: parseFloat(totalFees.toFixed(4)),
      winRate: winRate !== null ? parseFloat(winRate.toFixed(1)) : null,
      capital: cfg.startingCapital,
      byPattern,
      config: cfg,
      recentSignals: this.recentSignals.slice(0, 50),
      scannerStatus: {
        lastScanAt: this.lastScanAt,
        scannedPairs: this.scannedCount,
        lastRawSignals: this.lastRawSignals,
        lastEmitted: this.lastEmitted,
        isScanning: this.isScanning,
      },
      debug: { ...this.dbg },
      lastScanPairs: this.lastScanPairList,
      trendCandidates: this.trendCandidates.slice(0, 30),
      nearMisses: this.nearMisses.slice(0, 20),
    };
  }

  async getTrades(limit = 100) {
    return this.prisma.instSimulatedTrade.findMany({ orderBy: { openedAt: 'desc' }, take: limit });
  }

  async resetSim() {
    await this.prisma.instSimulatedTrade.deleteMany({});
    await this.prisma.instSimConfig.update({ where: { id: 1 }, data: { startingCapital: 500 } });
    this.recentSignals = [];
  }
}
