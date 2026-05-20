# TradingBot — Architettura e Strategia

> Documento tecnico completo: struttura del progetto, flusso dati, strategia di trading, configurazione e deploy.
> Aggiornato: maggio 2026

---

## Indice

1. [Stack tecnologico](#1-stack-tecnologico)
2. [Struttura del progetto](#2-struttura-del-progetto)
3. [Backend — moduli attivi](#3-backend--moduli-attivi)
4. [Smart AI Scanner — strategia completa](#4-smart-ai-scanner--strategia-completa)
5. [Gemma AI — integrazione e fallback](#5-gemma-ai--integrazione-e-fallback)
6. [Live Trading — esecuzione ordini reali](#6-live-trading--esecuzione-ordini-reali)
7. [Frontend — pagine e store](#7-frontend--pagine-e-store)
8. [WebSocket — eventi real-time](#8-websocket--eventi-real-time)
9. [Database — schema Prisma](#9-database--schema-prisma)
10. [Deploy e infrastruttura](#10-deploy-e-infrastruttura)
11. [Variabili d'ambiente](#11-variabili-dambiente)
12. [Flusso completo end-to-end](#12-flusso-completo-end-to-end)

---

## 1. Stack tecnologico

| Layer | Tecnologia |
|-------|-----------|
| Backend | NestJS (Node.js + TypeScript) |
| Database | SQLite via Prisma ORM |
| Exchange | MEXC Futures — ccxt library |
| AI | Google Gemma 4 31B (API Gemini) con fallback a 26B |
| Frontend | Vue 3 + Vite + Pinia + Tailwind CSS |
| WebSocket | Socket.IO (NestJS Gateway + Vue client) |
| Deploy | Server VPS Linux — PM2 process manager |
| Reverse proxy | Nginx (serve frontend statico + proxy /api → porta 3000) |

---

## 2. Struttura del progetto

```
trading-bot/
├── backend/
│   ├── prisma/
│   │   └── schema.prisma          # Schema DB (SQLite)
│   └── src/
│       ├── app.module.ts          # Root module — importa tutti i moduli
│       ├── main.ts                # Bootstrap NestJS
│       ├── prisma/                # PrismaService (singleton DB)
│       ├── mexc/                  # MexcService — dati mercato (scalper bot)
│       ├── events/                # EventsGateway — WebSocket server
│       ├── gemma/                 # GemmaService — LLM + fallback modelli
│       ├── smart-scanner/         # MODULO PRINCIPALE — scanner AI
│       ├── live/                  # LiveTradingService — ordini reali MEXC
│       ├── bot/                   # Scalper bot classici (deprecati)
│       ├── trades/                # Storico trade
│       ├── signals/               # Storico segnali
│       ├── dashboard/             # Aggregazione stats
│       ├── settings/              # Config globale
│       ├── ai-brain/              # AI Brain (sessione chat strategica)
│       └── indicators/            # Calcolo indicatori tecnici (EMA, ATR, RSI...)
├── frontend/
│   └── src/
│       ├── pages/                 # Viste Vue
│       │   ├── SmartScanner.vue   # Pagina principale
│       │   ├── Dashboard.vue      # Overview Smart Scanner + Live Trading
│       │   ├── LiveTrading.vue    # Gestione posizioni reali
│       │   ├── Trades.vue         # Storico
│       │   ├── BotConfig.vue      # Config bot scalper
│       │   └── Settings.vue       # Impostazioni globali
│       ├── stores/                # Pinia stores
│       │   ├── smart-scanner.ts   # Stato Smart Scanner (segnali, trade, config)
│       │   ├── live.ts            # Stato Live Trading (account, posizioni)
│       │   └── ...
│       ├── composables/
│       │   └── useSocket.ts       # Connessione WebSocket + dispatch eventi
│       └── layouts/
│           └── AppLayout.vue      # Sidebar + navigazione
└── ARCHITECTURE.md                # Questo file
```

---

## 3. Backend — moduli attivi

### `AppModule` (`app.module.ts`)

Importa nell'ordine:

```
ConfigModule → ScheduleModule → PrismaModule → MexcModule →
IndicatorsModule → StrategiesModule → BotModule → TradesModule →
SignalsModule → DashboardModule → SettingsModule → EventsModule →
LiveModule → AiBrainModule → GemmaModule → SmartScannerModule
```

I moduli legacy (FlexScanner, SolScanner, SqzScanner, HfScanner, MtfScanner, IntraScanner, ScannerModule) sono stati **rimossi** da `AppModule` — il codice sorgente esiste ancora ma non è istanziato.

### `EventsGateway` (`events/events.gateway.ts`)

Gateway WebSocket Socket.IO. Tutti i moduli iniettano `EventsGateway` per emettere eventi real-time al frontend via `this.events.server.emit('event:name', data)`.

---

## 4. Smart AI Scanner — strategia completa

**File**: `backend/src/smart-scanner/smart-scanner.service.ts`

### 4.1 Parametri costanti

```typescript
const CANDLES        = 260       // candele 1m scaricate per coppia
const TIMEFRAME      = '1m'      // timeframe operativo
const TOP_CANDIDATES = 500       // coppie pre-filtrate per volume
const MAX_PER_CYCLE  = 1         // max 1 LONG + 1 SHORT per ciclo
const MAX_SL_PCT     = 1.50      // stop loss massimo consentito (%)
const GEMMA_TIMEOUT  = 25_000    // timeout per chiamata Gemma (ms)
const MAX_EXT_ATR    = 4.0       // filtro anti-estensione (multipli di ATR14)
```

### 4.2 Ciclo di scansione

Il cron gira **ogni minuto** a :20 secondi (`@Cron('20 */1 * * * *')`).

```
1. Legge config dal DB (minScore, maxConcurrent, liveEnabled...)
2. Controlla posizioni aperte: se openCount >= maxConcurrent → SKIP
3. Scarica TOP_CANDIDATES coppie per volume (USDT futures MEXC)
4. Per ogni coppia: scarica 260 candele 1m via ccxt
5. Calcola indicatori: EMA9, EMA21, ATR14, RSI3, volume ratio
6. Applica filtri tecnici (vedi §4.3)
7. Genera segnali con pattern recognition (vedi §4.4)
8. Ordina per score DESC → prende top 1 LONG + top 1 SHORT
9. Per ogni segnale: chiama Gemma sequenzialmente (vedi §5)
10. Se Gemma approva → entra in sim trade + eventualmente ordine reale
```

### 4.3 Filtri tecnici (pre-Gemma)

Tutti i filtri vengono applicati prima di chiamare Gemma per risparmiare quote API.

| Filtro | Condizione | Motivo |
|--------|-----------|--------|
| `F1_flat` | range < 0.3× ATR14 | mercato laterale, nessun momentum |
| `F_stale` | last candle age > 90s | dati vecchi |
| `F3_pat_bounce` | nessun pattern trovato | vedi §4.4 |
| `F3_body` | corpo candela < minBodyPct (default 40%) | candele doji/indecisione |
| `F3_pat_conf` | pattern non confermato dal trend EMA | contro-tendenza |
| `SCORE` | score calcolato < minScore (default 45) | segnale debole |
| `F_ext` | estensione > MAX_EXT_ATR (4×ATR14) | **filtro anti-estensione** |
| `F_sl` | SL calcolato > MAX_SL_PCT (1.5%) | rischio eccessivo |

#### Filtro anti-estensione (il più importante)

Misura quanto il prezzo si è già mosso dal suo swing origin nelle ultime 200 candele:

```typescript
const swingWindow = candles.slice(n - 202, n - 2)   // 200 candele precedenti
const swingMin200 = Math.min(...swingWindow.map(c => c[3]))  // low più basso
const swingMax200 = Math.max(...swingWindow.map(c => c[2]))  // high più alto

const extUp   = (entry - swingMin200) / atr14   // distanza in multipli ATR dal bottom
const extDown = (swingMax200 - entry) / atr14   // distanza in multipli ATR dal top

// Per LONG: se prezzo è già 4+ ATR sopra il minimo → skip (mossa già fatta)
// Per SHORT: se prezzo è già 4+ ATR sotto il massimo → skip
if (direction === 'LONG'  && extUp   > MAX_EXT_ATR) → scarta
if (direction === 'SHORT' && extDown > MAX_EXT_ATR) → scarta
```

**Obiettivo**: evitare di entrare su mosse già estese, catturare l'*inizio* dell'estensione, non la coda.

### 4.4 Pattern recognition

Quattro pattern istituzionali riconosciuti:

#### Pattern 1 — ORDER BLOCK (OB)
Identifica l'ultima candela opposta prima di un impulso direzionale forte.

```
Long:  trova l'ultima candela ribassista prima di un rialzo > 3× corpo medio
Short: trova l'ultima candela rialzista prima di un ribasso > 3× corpo medio
```
- Entry: close dell'order block + ATR × slMult
- SL: sotto/sopra l'order block
- Rationale: gli istituzionali piazzano ordini nei livelli dove hanno accumulato

#### Pattern 2 — FAIR VALUE GAP (FVG)
Gap di prezzo (imbalance) tra la candela n-2 e n, dove la candela n-1 è molto grande.

```
Long FVG:  c[n-2].high < c[n].low   (gap rialzista)
Short FVG: c[n-2].low  > c[n].high  (gap ribassista)
```
- Entry: midpoint del gap
- SL: oltre il bordo del gap
- Rationale: i gap vengono spesso ri-testati prima della continuazione

#### Pattern 3 — LIQUIDITY SWEEP (LIQ_SWEEP)
Stop hunt: il prezzo rompe brevemente un minimo/massimo recente e poi si inverte.

```
Long:  ultimo low < minimo delle 20 candele precedenti, poi chiude sopra
Short: ultimo high > massimo delle 20 candele precedenti, poi chiude sotto
```
- Entry: close della candela di sweep
- SL: oltre l'estremo dello sweep
- Rationale: gli istituzionali prelevano liquidità dai retail prima di muovere

#### Pattern 4 — RANGE BREAKOUT (RANGE_BRK)
Rottura di un range di consolidamento con volume aumentato.

```
Long:  high corrente > max(ultimi 20 high) + ATR × 0.5, volume > 1.5× medio
Short: low corrente  < min(ultimi 20 low)  - ATR × 0.5, volume > 1.5× medio
```
- Entry: close della candela di breakout
- SL: mid del range
- Rationale: breakout su volume indica partecipazione istituzionale

### 4.5 Scoring

Ogni segnale riceve un punteggio 0–100:

```typescript
score =
  + volumeRatio × 15      // volume relativo (max 15pt)
  + rsiScore              // RSI3 favorevole (0–15pt)
  + patternScore          // qualità pattern (0–20pt)
  + bodyScore             // solidità corpo candela (0–20pt)
  + trendScore            // allineamento EMA trend (0–20pt)
  + atrScore              // ATR favorevole (0–10pt)
```

Grade assegnato:
- A+ → score ≥ 80
- A  → score ≥ 65
- B  → score ≥ 50
- C  → score < 50

### 4.6 Chart ASCII per Gemma

Prima di chiamare Gemma, viene generato un mini-grafico delle ultime 90 candele (aggregato a ~60 caratteri):

```
▁▂▁▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇█▇▆ ← chiusure normalizzate
```

I simboli `▁▂▃▄▅▆▇█` rappresentano 8 livelli di prezzo da minimo a massimo. Viene inviato a Gemma insieme all'URL del grafico MEXC reale per confronto visivo.

---

## 5. Gemma AI — integrazione e fallback

**File**: `backend/src/gemma/gemma.service.ts`

### 5.1 Modelli e fallback quota

```typescript
const GEMMA_MODELS = [
  'gemma-4-31b-it',       // primario (1500 req/giorno free tier)
  'gemma-4-26b-a4b-it',   // fallback automatico quando quota esaurita
]
```

Il metodo `callApi(body)` centralizza tutte le chiamate:

```typescript
async callApi(body, retryOnQuota = true): Promise<Response> {
  const model = GEMMA_MODELS[this.modelIdx]
  const res   = await fetch(`${BASE_URL}/${model}:generateContent?key=${apiKey}`, ...)

  if ((res.status === 429 || res.status === 403) && retryOnQuota) {
    const text = await res.clone().text()
    if (text.includes('quota') || text.includes('RESOURCE_EXHAUSTED')) {
      if (this.modelIdx < GEMMA_MODELS.length - 1) {
        this.modelIdx++
        this.logger.warn(`[Gemma] Switch a ${GEMMA_MODELS[this.modelIdx]}`)
        return this.callApi(body, false)  // riprova con modello successivo
      }
    }
  }
  return res
}
```

Reset automatico a mezzanotte:

```typescript
@Cron('0 0 * * *')
resetQuota() { this.modelIdx = 0 }  // torna al modello principale
```

### 5.2 Prompt di valutazione segnale

Il prompt inviato a Gemma per ogni segnale contiene:

```
- Symbol, direction (LONG/SHORT), pattern type
- Entry price, Stop Loss %, Take Profit %
- Score, grade, ATR%, volume ratio, RSI3
- Grafico ASCII ultimi 90 minuti
- URL grafico MEXC reale: https://futures.mexc.com/exchange/SYMBOL_USDT
- Posizioni aperte attuali (contesto portfolio)
- Istruzione: rispondere SOLO con JSON {"enter": true/false, "reason": "..."}
```

### 5.3 Valutazione sequenziale

I segnali (max 2 per ciclo: 1 LONG + 1 SHORT) vengono valutati in **sequenza** con 1.5s di pausa tra uno e l'altro — non in parallelo. Motivo: evitare burst di API calls che causano errori 429/500 da Google.

Se Gemma risponde con errore, il fallback è **sempre `enter: false`** — nessun segnale passa in automatico per errore API.

### 5.4 Timeout

Ogni chiamata Gemma ha un timeout di 25 secondi tramite `Promise.race`:

```typescript
const verdict = await Promise.race([
  this.callGemmaFilter(sig, cfg, openPositions),
  new Promise(resolve => setTimeout(() => resolve({ enter: false, reason: 'timeout' }), GEMMA_TIMEOUT))
])
```

---

## 6. Live Trading — esecuzione ordini reali

**File**: `backend/src/live/live-trading.service.ts`

### 6.1 Interfaccia TradeSignal

```typescript
export interface TradeSignal {
  symbol:            string
  direction:         'LONG' | 'SHORT'
  grade:             string       // sempre 'A+' quando chiamato da SmartScanner
  entry:             number       // prezzo entry suggerito
  slPct:             number       // stop loss % (es. 0.64)
  tp1Pct:            number       // take profit % (es. 1.28)
  suggestedLeverage: number
  score?:            number
}
```

### 6.2 Flusso `enterTrade()`

```
1. Legge config Live Trading dal DB (enabled, minGrade, maxConcurrent, marginPerTrade)
2. Se !cfg.enabled → skip
3. Se grade inferiore a minGrade → skip
   (NB: SmartScanner passa sempre grade 'A+' per bypassare il filtro — Gemma ha già approvato)
4. Se posizioni aperte >= maxConcurrent → skip
5. Se già aperta una posizione sullo stesso symbol → skip
6. Calcola notional: marginPerTrade × leverage
7. Invia ordine market su MEXC via ccxt
8. Legge fill reale (dealAvgPrice)
9. Calcola SL e TP prezzi assoluti dal fill reale usando slPct/tp1Pct
10. Imposta SL+TP tramite MEXC stoporder/place API (singolo ordine combinato)
11. Salva il trade nel DB (LiveTrade)
12. Emette evento WebSocket live:trade al frontend
```

### 6.3 Stop Loss e Take Profit

SL e TP vengono calcolati sul **prezzo di fill reale** (non quello di entry stimato):

```typescript
const slFrac = signal.slPct  / 100   // es. 0.0064
const tpFrac = signal.tp1Pct / 100   // es. 0.0128

const slPrice = isLong ? filled × (1 - slFrac) : filled × (1 + slFrac)
const tpPrice = isLong ? filled × (1 + tpFrac) : filled × (1 - tpFrac)
```

MEXC gestisce SL+TP con un singolo `stopOrderId` che copre entrambi i livelli.

### 6.4 Toggle Live da Smart Scanner

In `smart-scanner.service.ts`, dopo l'approvazione di Gemma:

```typescript
if (verdict.enter) {
  await this.enterSimTrade(sig, cfg)       // sempre: entra in simulazione
  if (cfg.liveEnabled) {
    await this.liveTrading.enterTrade({
      ...tradeSignal,
      grade: 'A+',    // bypassa minGrade filter — Gemma ha già approvato
    })
  }
}
```

Il toggle `liveEnabled` è visibile nella pagina Smart Scanner (pill rossa "🔴 Live ON/OFF"). Quando attivo, mostra un avviso rosso: "ATTENZIONE: Gli ordini approvati da Gemma vengono eseguiti su MEXC con soldi reali".

### 6.5 Riconciliazione posizioni

Ogni 10 secondi, `LiveTradingService` interroga MEXC per posizioni aperte e rileva chiusure native (SL/TP scattati sull'exchange). Aggiorna il DB e invia `live:update` via WebSocket.

---

## 7. Frontend — pagine e store

### Pagine attive

| Pagina | Route | Descrizione |
|--------|-------|-------------|
| `Dashboard.vue` | `/dashboard` | Overview: stats Smart Scanner + equity Live Trading + segnali recenti + price chart |
| `SmartScanner.vue` | `/smart` | Segnali AI in tempo reale, simulazione, AI Optimizer, toggle Live |
| `LiveTrading.vue` | `/live` | Posizioni reali aperte, storico, config Live Trading |
| `BotConfig.vue` | `/bots` | Configurazione scalper bot classici |
| `Trades.vue` | `/trades` | Storico trade (scalper) |
| `Settings.vue` | `/settings` | Config globale (MEXC keys, thresholds, notifiche) |

### Store Pinia principali

**`smart-scanner.ts`**
- `signals`: ultimi 200 segnali (aggiornati via WebSocket `smart:signal`)
- `trades`: trade simulati (aperti + chiusi)
- `analytics`: stats aggregate + config corrente
- `status`: stato scanner (last scan, coppie, isScanning)
- `toggleLive()`: invia `POST /api/smart-scanner/config { liveEnabled: !current }`

**`live.ts`**
- `account`: balance, equity, margin disponibile
- `positions`: posizioni aperte in tempo reale
- `trades`: storico trade live
- `config`: enabled, marginPerTrade, maxConcurrent, minGrade

---

## 8. WebSocket — eventi real-time

| Evento | Direzione | Payload | Handler |
|--------|-----------|---------|---------|
| `smart:signal` | server → client | `SmartSignal` | `store.addLiveSignal()` |
| `smart:trade` | server → client | `SmartTrade` | `store.addLiveTrade()` |
| `smart:positions` | server → client | `position[]` | `store.updatePositions()` |
| `smart:status` | server → client | `{ lastScanAt, isScanning... }` | `Object.assign(status, data)` |
| `smart:opt-log` | server → client | `SmartOptLog` | `store.addOptLog()` |
| `smart:config` | server → client | `{ liveEnabled, autoOptimize }` | `Object.assign(analytics.config, data)` |
| `live:update` | server → client | `{ account, positions }` | `liveStore.setFromSocket()` |
| `live:trade` | server → client | `LiveTrade` | `liveStore.addLiveTrade()` |
| `price` | server → client | `{ symbol, price, changePct }` | `botStore.updatePrice()` |
| `signal` | server → client | `Signal` | `signalsStore.addLive()` |
| `trade` | server → client | `Trade` | `tradesStore.addLive()` |
| `bot:status` | server → client | `{ botId, status }` | `botStore.updateStatus()` |

L'evento `smart:config` viene emesso ogni volta che la config di Smart Scanner viene modificata (via toggle Live, auto-tune, ecc.), garantendo sincronizzazione real-time tra tutti i client connessi senza aspettare un refresh.

---

## 9. Database — schema Prisma

**File**: `backend/prisma/schema.prisma` — SQLite

### Tabelle principali

**`SmartSimConfig`** — configurazione Smart Scanner
```prisma
id              Int     @id @default(1)
startingCapital Float   @default(500)
maxConcurrent   Int     @default(5)
autoEnter       Boolean @default(true)
minScore        Int     @default(45)
minBodyPct      Float   @default(0.40)
atrSlMult       Float   @default(1.5)
tpRr            Float   @default(2.5)
autoOptimize    Boolean @default(true)
liveEnabled     Boolean @default(false)   // ← aggiunto: collega a Live Trading
```

**`SmartSimulatedTrade`** — trade simulati
```prisma
id, symbol, direction, patternType
entry, stopLoss, takeProfit1, takeProfit2
leverage, riskEur, positionSize, marginEur
grade, score, status, closePrice, pnl, fees
capitalBefore, capitalAfter, openedAt, closedAt
```

**`SmartSignalRecord`** — log storico segnali
```prisma
id, symbol, direction, patternType, patternName
entry, slPct, tpPct, suggestedLeverage
volumeRatio, rsi3, atrPct, score, grade
gemmaApproved, gemmaReason, reasons (JSON), mexcUrl
createdAt
```

**`SmartOptLog`** — log ottimizzazioni AI
```prisma
id, createdAt, tradesAnalyzed
analysis, changes (JSON), reason, applied
```

**`LiveTrade`** — ordini reali MEXC
```prisma
id, symbol, direction
entry, stopLoss, takeProfit
leverage, marginEur, positionSize, contracts
orderId, slOrderId, tpOrderId
grade, score, feesOpen, feesClose
status (open/closed/error), note
closePrice, pnl, openedAt, closedAt
```

**`LiveConfig`** — config Live Trading
```prisma
id, enabled, autoClose
marginPerTrade, minGrade, maxConcurrent
```

---

## 10. Deploy e infrastruttura

### Server
- IP: `144.91.101.42`
- OS: Linux
- Process manager: PM2 (`pm2 restart tradingbot-api`)

### Struttura server
```
/var/www/tradingbot/
├── backend/
│   ├── dist/           ← JS compilato (copiato da locale con scp)
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── tradingbot.db    ← database SQLite (NON sovrascrivere!)
│   ├── node_modules/
│   └── .env            ← variabili d'ambiente (NON committare!)
└── frontend/           ← build Vue statica (copiata con scp)
    ├── index.html
    └── assets/
```

### Procedura di deploy

```bash
# 1. Build locale
cd backend  && npm run build
cd frontend && npm run build

# 2. Deploy backend (solo dist compilato)
scp -r backend/dist/. root@144.91.101.42:/var/www/tradingbot/backend/dist/

# 3. Deploy frontend (build statica)
scp -r frontend/dist/. root@144.91.101.42:/var/www/tradingbot/frontend/

# 4. Se schema Prisma cambiato:
scp backend/prisma/schema.prisma root@144.91.101.42:/var/www/tradingbot/backend/prisma/
ssh root@144.91.101.42 "cd /var/www/tradingbot/backend && npx prisma db push && npx prisma generate"

# 5. Riavvio (SEMPRE con --update-env per caricare nuove env vars)
ssh root@144.91.101.42 "pm2 restart tradingbot-api --update-env"
```

### Regole di sicurezza PM2
- ✅ Usare SEMPRE: `pm2 restart tradingbot-api`
- ❌ MAI usare: `pm2 stop` + `pm2 delete` (perderesti la configurazione)
- ❌ MAI usare: `prisma db push --force-reset` (cancella tutto il DB)

---

## 11. Variabili d'ambiente

**File**: `backend/.env` (NON committare in git)

```env
MEXC_API_KEY=<la tua chiave MEXC>
MEXC_API_SECRET=<il tuo secret MEXC>
GEMINI_API_KEY=<la tua chiave Google AI>
PORT=3000
NODE_ENV=production
TEST_MODE=true         # false = abilita ordini reali per gli scalper bot
FRONTEND_URL=https://tuodominio.com
```

> `TEST_MODE` controlla solo i **scalper bot classici** (`MexcService`). Il Live Trading di Smart Scanner è controllato separatamente dal toggle `liveEnabled` nel DB.

---

## 12. Flusso completo end-to-end

```
┌─────────────────────────────────────────────────────────────────────┐
│                    OGNI MINUTO (a :20s)                             │
│                                                                     │
│  SmartScannerService.runScan()                                      │
│  │                                                                  │
│  ├─ 1. Legge config dal DB (minScore, maxConcurrent, liveEnabled)   │
│  │                                                                  │
│  ├─ 2. openCount >= maxConcurrent? → SKIP tutto il ciclo            │
│  │                                                                  │
│  ├─ 3. Scarica TOP 500 coppie per volume da MEXC                    │
│  │                                                                  │
│  ├─ 4. Per ogni coppia: 260 candele 1m → indicatori                 │
│  │     EMA9, EMA21, ATR14, RSI3, volumeRatio                        │
│  │                                                                  │
│  ├─ 5. Filtri tecnici (flat, stale, body, score, anti-estensione)   │
│  │                                                                  │
│  ├─ 6. Pattern matching: OB / FVG / LIQ_SWEEP / RANGE_BRK          │
│  │                                                                  │
│  ├─ 7. Top 1 LONG + Top 1 SHORT per score                           │
│  │                                                                  │
│  └─ 8. Per ogni segnale (max 2, sequenziali):                       │
│        │                                                            │
│        ├─ Genera ASCII chart (90 candele)                           │
│        │                                                            │
│        ├─ Chiama GemmaService.callApi() → gemma-4-31b-it            │
│        │   (fallback auto a gemma-4-26b-a4b-it se quota esaurita)  │
│        │   Timeout: 25s → fallback enter:false                      │
│        │                                                            │
│        ├─ Se verdict.enter = true:                                  │
│        │   ├─ enterSimTrade() → DB SmartSimulatedTrade             │
│        │   ├─ emit('smart:signal', {..., gemmaApproved: true})       │
│        │   └─ Se cfg.liveEnabled = true:                            │
│        │       └─ LiveTradingService.enterTrade(grade:'A+')         │
│        │           ├─ Ordine market MEXC via ccxt                   │
│        │           ├─ SL+TP su fill reale → stoporder/place         │
│        │           └─ emit('live:trade', liveTrade)                 │
│        │                                                            │
│        └─ Se verdict.enter = false:                                 │
│            └─ emit('smart:signal', {..., gemmaApproved: false})     │
│                                                                     │
│  emit('smart:status', {lastScanAt, isScanning, ...})                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    OGNI 10 SECONDI                                  │
│                                                                     │
│  LiveTradingService — riconciliazione                               │
│  ├─ fetchPositions MEXC                                             │
│  ├─ Rileva chiusure SL/TP native                                    │
│  ├─ Aggiorna DB LiveTrade (status, closePrice, pnl)                 │
│  └─ emit('live:update', {account, positions})                       │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    OGNI 5 MINUTI (se autoOptimize=true)             │
│                                                                     │
│  SmartScannerService.gemmaOptimize()                                │
│  ├─ Analizza ultimi trade chiusi (win rate, pnl, pattern stats)     │
│  ├─ Chiama Gemma per suggerimenti parametri                         │
│  ├─ Se suggerisce modifiche: aggiorna config nel DB                 │
│  └─ emit('smart:opt-log', logEntry)                                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Note operative

**Quando attivare Live Trading**
1. Verificare che su `/live` la config abbia `enabled: true` e un `marginPerTrade` ragionevole (es. €5–20)
2. Andare su `/smart` → attivare il toggle "🔴 Live ON"
3. Attendere il prossimo segnale approvato da Gemma — l'ordine partirà automaticamente
4. Verificare su MEXC Futures che l'ordine sia stato piazzato con SL e TP

**Quando disattivare**
1. Spegnere il toggle "🔴 Live OFF" su `/smart` — immediato, nessun ordine aperto viene toccato
2. Gli ordini già aperti rimangono aperti fino a SL/TP o chiusura manuale su MEXC

**Monitoraggio logs**
```bash
ssh root@144.91.101.42 "pm2 logs tradingbot-api --lines 50 --nostream"
# Cercare: [SMART ✅] APPROVATO e [LIVE] ✅ per confermare il flusso
# Cercare: [SMART ❌] RIFIUTATO per vedere cosa Gemma scarta
# Cercare: [Gemma] Switch per vedere il fallback modello
```
