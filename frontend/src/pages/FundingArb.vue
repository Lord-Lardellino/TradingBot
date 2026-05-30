<template>
  <div class="p-3 sm:p-6 space-y-4">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          💰 Funding Rate Arbitrage
          <span class="text-xs font-normal text-gray-500">Delta-neutral · Spot long + Futures short · ogni 4h</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Scan ogni 30min ·
          <span v-if="status?.lastScanAt" class="ml-1">aggiornato {{ timeAgo(status.lastScanAt) }}</span>
          <span class="ml-2 text-gray-600">· {{ status?.totalPairs ?? 0 }} pair trovati</span>
        </p>
      </div>
      <div class="flex gap-2">
        <button v-if="autoTradeEnabled !== null" @click="toggleAutoTrade"
          :class="['px-3 py-1.5 rounded text-sm font-medium transition', autoTradeEnabled ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-surface-200 text-gray-500 hover:bg-surface-300']">
          🔴 {{ autoTradeEnabled ? 'AUTO ON' : 'AUTO OFF' }}
        </button>
        <button @click="closeAllSpot" :disabled="loading"
          class="px-3 py-1.5 rounded text-sm font-medium bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 transition">
          🔶 Vendi Spot
        </button>
        <button @click="closeAllFutures" :disabled="loading"
          class="px-3 py-1.5 rounded text-sm font-medium bg-purple-500/20 text-purple-400 hover:bg-purple-500/30 transition">
          💜 Chiudi Futures
        </button>
        <button @click="cleanHistory" :disabled="loading"
          class="px-3 py-1.5 rounded text-sm font-medium bg-surface-200 text-gray-400 hover:bg-surface-300 transition">
          🧹 Pulisci storico
        </button>
        <button @click="resetAll" :disabled="loading"
          class="px-3 py-1.5 rounded text-sm font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition">
          ⚠️ Reset
        </button>
        <Button size="small" icon="pi pi-refresh" label="Aggiorna" severity="secondary" :loading="loading" @click="load()" />
      </div>
    </div>

    <!-- Spiega la strategia -->
    <div class="stat-card border border-emerald-500/20 bg-emerald-500/5">
      <div class="text-sm text-emerald-400 font-semibold mb-2">Come funziona</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-gray-400">
        <div>
          <div class="text-white font-medium mb-1">1. Compri spot + shorti futures</div>
          Sei delta-neutral: se il prezzo sale o scende, le due posizioni si bilanciano sempre.
        </div>
        <div>
          <div class="text-white font-medium mb-1">2. Incassi il funding ogni 8h</div>
          Quando il mercato è bullish, i long pagano gli short. Tu sei short → incassi tu.
        </div>
        <div>
          <div class="text-white font-medium mb-1">3. Esci se il rate diventa negativo</div>
          Se shorts > longs, il rate si inverte e pagheresti tu. Esci prima che accada.
        </div>
      </div>
    </div>

    <!-- Stats overview -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-emerald-400">{{ status?.positivePairs ?? 0 }}</div>
        <div class="text-sm text-gray-500 mt-1">Rate positivi ✅</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-red-400">{{ status?.negativePairs ?? 0 }}</div>
        <div class="text-sm text-gray-500 mt-1">Rate negativi ❌</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-white">{{ bestRate?.aprPct?.toFixed(1) ?? '—' }}%</div>
        <div class="text-sm text-gray-500 mt-1">Miglior APR (con spot)</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-sky-400">{{ avgApr.toFixed(1) }}%</div>
        <div class="text-sm text-gray-500 mt-1">APR medio positivi</div>
      </div>
    </div>

    <!-- PnL Stats REALI (da MEXC) -->
    <div v-if="analytics" class="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <div class="stat-card border border-emerald-500/20">
        <div class="text-xs text-gray-500 mb-1">💰 Funding incassato</div>
        <div class="text-xl font-bold font-mono" :class="analytics.fundingReceived >= 0 ? 'text-emerald-400' : 'text-red-400'">
          {{ analytics.fundingReceived >= 0 ? '+' : '' }}{{ analytics.fundingReceived.toFixed(4) }}$
        </div>
        <div class="text-[10px] text-gray-600 mt-0.5">{{ analytics.fundingCount }} settlement reali</div>
      </div>
      <div class="stat-card border border-red-500/20">
        <div class="text-xs text-gray-500 mb-1">💸 Fee pagate</div>
        <div class="text-xl font-bold font-mono text-red-400">−{{ analytics.feesPaid.toFixed(4) }}$</div>
        <div class="text-[10px] text-gray-600 mt-0.5">coppie attive</div>
      </div>
      <div class="stat-card border" :class="analytics.netPnl >= 0 ? 'border-emerald-500/30' : 'border-red-500/30'">
        <div class="text-xs text-gray-500 mb-1">📊 Netto</div>
        <div class="text-xl font-black font-mono" :class="analytics.netPnl >= 0 ? 'text-emerald-400' : 'text-red-400'">
          {{ analytics.netPnl >= 0 ? '+' : '' }}{{ analytics.netPnl.toFixed(4) }}$
        </div>
        <div class="text-[10px] text-gray-600 mt-0.5">funding − fee</div>
      </div>
      <div class="stat-card border border-sky-500/20">
        <div class="text-xs text-gray-500 mb-1">📈 Funding/giorno</div>
        <div class="text-xl font-bold font-mono text-sky-400">+{{ analytics.dailyFundingEst.toFixed(4) }}$</div>
        <div class="text-[10px] text-gray-600 mt-0.5">stima d'ora in poi</div>
      </div>
      <div class="stat-card border" :class="absVal(analytics.gap) < 2 ? 'border-emerald-500/20' : 'border-yellow-500/30'">
        <div class="text-xs text-gray-500 mb-1">⚖️ Gap delta</div>
        <div class="text-xl font-bold font-mono" :class="absVal(analytics.gap) < 2 ? 'text-emerald-400' : 'text-yellow-400'">
          {{ analytics.gap >= 0 ? '+' : '' }}{{ analytics.gap.toFixed(2) }}$
        </div>
        <div class="text-[10px] text-gray-600 mt-0.5">spot {{ analytics.spotValue.toFixed(0) }} vs fut {{ analytics.futNotional.toFixed(0) }} · {{ analytics.openCount }} pos</div>
      </div>
    </div>

    <!-- Config editabile -->
    <div v-if="config" class="stat-card border border-gray-500/20">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm text-gray-400 font-medium">⚙️ Auto-trade Config</div>
        <button @click="saveConfig" :disabled="savingConfig"
          class="px-3 py-1 rounded text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition disabled:opacity-50">
          {{ savingConfig ? 'Salvo...' : '💾 Salva' }}
        </button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <div class="text-xs text-gray-500 mb-1">Capitale spot/posizione (USDT)</div>
          <input v-model.number="config.capitalPerPosition" type="number" min="1" step="1"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Leva futures <span class="text-emerald-500">(impostata dal bot)</span></div>
          <select v-model.number="config.leveragePerPosition"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono">
            <option :value="1">1x (margine = spot)</option>
            <option :value="2">2x (margine = spot/2) — default MEXC</option>
            <option :value="3">3x (margine = spot/3)</option>
            <option :value="5">5x (margine = spot/5)</option>
            <option :value="10">10x (margine = spot/10)</option>
            <option :value="20">20x (margine = spot/20)</option>
          </select>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Max posizioni</div>
          <input v-model.number="config.maxOpenPositions" type="number" min="1" max="50" step="1"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Margine futures stimato</div>
          <div class="text-white font-mono font-bold py-1.5">
            ${{ (config.capitalPerPosition / config.leveragePerPosition).toFixed(2) }}
            <span class="text-gray-600 text-xs">+ ${{ config.capitalPerPosition }} spot</span>
          </div>
        </div>
      </div>
      <div class="mt-3 text-xs text-gray-600">
        Per posizione blocchi: <span class="text-white">${{ config.capitalPerPosition }}</span> spot +
        <span class="text-white">${{ (config.capitalPerPosition / config.leveragePerPosition).toFixed(2) }}</span> margine futures =
        <span class="text-emerald-400 font-bold">${{ (config.capitalPerPosition + config.capitalPerPosition / config.leveragePerPosition).toFixed(2) }}</span> totale.
        Liquidation a ±{{ (100 / config.leveragePerPosition).toFixed(1) }}%.
      </div>
      <div class="mt-2 text-xs text-emerald-500/80 bg-emerald-500/5 border border-emerald-500/20 rounded px-3 py-2">
        ✅ Il bot imposta automaticamente la leva su MEXC ({{ config.leveragePerPosition }}x isolated) all'apertura di ogni posizione.
      </div>
    </div>

    <!-- Open Positions -->
    <div v-if="positionsData?.openPositions?.length" class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-blue-400 inline-block" />
        Posizioni aperte ({{ positionsData.openPositions.length }})
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Asset</th>
              <th class="text-right pb-2">Entry</th>
              <th class="text-right pb-2">Qty</th>
              <th class="text-right pb-2">Rate</th>
              <th class="text-right pb-2">Aperto</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pos in positionsData.openPositions" :key="pos.id"
              class="border-b border-white/3 hover:bg-surface-100 transition">
              <td class="py-2 text-white font-bold">{{ pos.symbol.replace('/USDT:USDT', '') }}</td>
              <td class="py-2 text-right">{{ pos.entryPrice.toFixed(4) }}</td>
              <td class="py-2 text-right">{{ pos.quantity.toFixed(6) }}</td>
              <td class="py-2 text-right text-emerald-400">{{ (pos.fundingRate * 100).toFixed(4) }}%</td>
              <td class="py-2 text-right text-gray-500">{{ timeAgo(pos.entryTime) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Calcolatore profitto -->
    <div class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3">💡 Simulatore — quanto guadagno?</div>
      <div class="flex flex-wrap gap-4 items-end">
        <div>
          <div class="text-xs text-gray-500 mb-1">Asset</div>
          <select v-model="simSymbol" class="bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white">
            <option v-for="r in positiveWithSpot" :key="r.symbol" :value="r.symbol">
              {{ r.base }} ({{ r.aprPct.toFixed(1) }}% APR)
            </option>
          </select>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Capitale (USDT)</div>
          <input v-model.number="simCapital" type="number" min="10" step="10"
            class="bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white w-28" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Leva (spot:futures)</div>
          <select v-model.number="simLeverage" class="bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white">
            <option :value="1">1x (no leva) — safest</option>
            <option :value="2">2x — moderate</option>
            <option :value="3">3x — aggressive</option>
            <option :value="5">5x — risky</option>
          </select>
        </div>
        <div v-if="projection" class="flex gap-6 text-center items-end">
          <div>
            <div class="text-xs text-gray-500">Al giorno</div>
            <div class="text-lg font-black text-emerald-400 font-mono">+{{ projection.dailyProfit.toFixed(3) }}$</div>
          </div>
          <div>
            <div class="text-xs text-gray-500">Al mese</div>
            <div class="text-lg font-black text-emerald-400 font-mono">+{{ projection.monthlyProfit.toFixed(2) }}$</div>
          </div>
          <div>
            <div class="text-xs text-gray-500">All'anno</div>
            <div class="text-xl font-black text-emerald-400 font-mono">+{{ projection.yearlyProfit.toFixed(2) }}$</div>
          </div>
          <div>
            <div class="text-xs text-gray-500">Liquidation</div>
            <div :class="['text-lg font-black font-mono', projection.liquidationPct <= 0.5 ? 'text-red-400' : projection.liquidationPct <= 1 ? 'text-yellow-400' : 'text-emerald-400']">
              ±{{ projection.liquidationPct.toFixed(2) }}%
            </div>
          </div>
          <button @click="enterNow" :disabled="entering" :class="['px-4 py-2 rounded font-medium transition', entering ? 'bg-gray-600 text-gray-400' : 'bg-emerald-500 text-white hover:bg-emerald-600']">
            {{ entering ? 'Entrando...' : '🚀 Entra ora' }}
          </button>
        </div>
      </div>
      <div class="mt-3 text-xs text-gray-600">
        ⚠ Leva aumenta il notional (fondingAncora) ma accorcia la liquidation distance. Consiglio: BTC/ETH con leva 2-3x, altcoin senza leva.
      </div>
    </div>

    <!-- Tabella rate — con spot disponibile (fattibili) -->
    <div class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
        Opportunità con spot disponibile su MEXC
        <span class="text-xs text-gray-600 ml-1">(fattibili per arbitrage)</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Asset</th>
              <th class="text-right pb-2">Funding/settle</th>
              <th class="text-right pb-2">Giornaliero</th>
              <th class="text-right pb-2 text-emerald-400">APR</th>
              <th class="text-right pb-2">Settle</th>
              <th class="text-right pb-2">Next</th>
              <th class="text-right pb-2">Vol 24h</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in positiveWithSpot" :key="r.symbol"
              class="border-b border-white/3 hover:bg-surface-100 transition">
              <td class="py-2">
                <span class="text-white font-bold">{{ r.base }}</span>
                <span class="text-gray-600 ml-1">{{ r.price }}</span>
              </td>
              <td class="py-2 text-right" :class="r.fundingRate > 0 ? 'text-emerald-400' : 'text-red-400'">
                {{ r.fundingRate > 0 ? '+' : '' }}{{ (r.fundingRate * 100).toFixed(4) }}%
              </td>
              <td class="py-2 text-right text-emerald-400">+{{ r.dailyPct.toFixed(4) }}%</td>
              <td class="py-2 text-right font-bold" :class="r.aprPct > 20 ? 'text-yellow-400' : r.aprPct > 10 ? 'text-emerald-400' : 'text-gray-400'">
                {{ r.aprPct.toFixed(2) }}%
              </td>
              <td class="py-2 text-right text-gray-500">{{ r.settleHours }}h</td>
              <td class="py-2 text-right text-gray-500">{{ r.nextFunding ? nextFundingIn(r.nextFunding) : '—' }}</td>
              <td class="py-2 text-right text-gray-500">{{ formatVol(r.vol24h) }}</td>
            </tr>
            <tr v-if="!positiveWithSpot.length">
              <td colspan="6" class="py-4 text-center text-gray-600">Nessun rate positivo con spot disponibile</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tabella rate — senza spot (solo info) -->
    <div class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-yellow-400 inline-block" />
        Rate elevati ma senza spot su MEXC
        <span class="text-xs text-gray-600 ml-1">(solo info — non fattibili)</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <div v-for="r in positiveNoSpot.slice(0,10)" :key="r.symbol"
          class="text-xs font-mono px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <span class="text-yellow-400 font-bold">{{ r.base }}</span>
          <span class="text-gray-400 ml-2">{{ r.aprPct.toFixed(1) }}% APR</span>
        </div>
      </div>
    </div>

    <!-- Rate negativi -->
    <div v-if="negativeRates.length" class="stat-card border border-red-500/10">
      <div class="text-sm text-red-400 font-medium mb-2">⚠ Rate negativi — da evitare</div>
      <div class="flex flex-wrap gap-2">
        <span v-for="r in negativeRates.slice(0,10)" :key="r.symbol"
          class="text-xs font-mono px-2 py-1 rounded bg-red-500/10 text-red-400">
          {{ r.base }} {{ (r.fundingRate * 100).toFixed(4) }}%
        </span>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import axios from 'axios'
import Button from 'primevue/button'

interface Rate {
  symbol: string; base: string; spotSymbol: string; hasSpot: boolean
  price: number; vol24h: number; fundingRate: number
  settleHours: number; settlePerDay: number
  dailyPct: number; aprPct: number; nextFunding: string | null; timestamp: string
}

const loading          = ref(false)
const entering         = ref(false)
const savingConfig     = ref(false)
const autoTradeEnabled = ref<boolean | null>(null)
const dashboard        = ref<any>(null)
const positionsData    = ref<any>(null)
const analytics        = ref<any>(null)
const config           = ref<any>(null)
const simSymbol        = ref('')
const simCapital       = ref(100)
const simLeverage      = ref(1)
const projection       = ref<any>(null)

const status   = computed(() => dashboard.value?.status)
const allRates = computed<Rate[]>(() => dashboard.value?.rates ?? [])

const positiveWithSpot = computed(() => allRates.value.filter(r => r.fundingRate > 0 && r.hasSpot))
const positiveNoSpot   = computed(() => allRates.value.filter(r => r.fundingRate > 0 && !r.hasSpot))
const negativeRates    = computed(() => allRates.value.filter(r => r.fundingRate < 0))
const bestRate         = computed(() => positiveWithSpot.value[0] ?? null)
const avgApr           = computed(() => {
  const pos = allRates.value.filter(r => r.fundingRate > 0)
  return pos.length ? pos.reduce((s, r) => s + r.aprPct, 0) / pos.length : 0
})

async function load() {
  loading.value = true
  try {
    const [dashRes, cfgRes, posRes, anRes] = await Promise.all([
      axios.get('/api/funding-arb/dashboard'),
      axios.get('/api/funding-arb/config'),
      axios.get('/api/funding-arb/positions'),
      axios.get('/api/funding-arb/analytics').catch(() => ({ data: null })),
    ])
    dashboard.value = dashRes.data
    config.value = cfgRes.data
    positionsData.value = posRes.data
    analytics.value = anRes.data
    autoTradeEnabled.value = cfgRes.data?.autoTradeEnabled ?? false

    if (!simSymbol.value && positiveWithSpot.value.length)
      simSymbol.value = positiveWithSpot.value[0].symbol
  } catch (e: any) {
    console.warn('Load error:', e?.message)
  } finally { loading.value = false }
}

async function toggleAutoTrade() {
  try {
    autoTradeEnabled.value = !autoTradeEnabled.value
    await axios.patch('/api/funding-arb/config', { autoTradeEnabled: autoTradeEnabled.value })
  } catch (e: any) {
    autoTradeEnabled.value = !autoTradeEnabled.value
    alert(`❌ Toggle fallito: ${e?.response?.data?.message ?? e?.message}`)
  }
}

async function closeAllSpot() {
  if (!confirm('Vendi TUTTO lo spot? (irreversibile)')) return
  loading.value = true
  try {
    await axios.post('/api/funding-arb/close-all-spot')
    alert('✅ Spot venduto completamente')
    await load()
  } catch (e: any) {
    alert(`❌ Errore: ${e?.response?.data?.message ?? e?.message}`)
  } finally { loading.value = false }
}

async function closeAllFutures() {
  if (!confirm('Chiudi TUTTI i futures? (irreversibile)')) return
  loading.value = true
  try {
    await axios.post('/api/funding-arb/close-all-futures')
    alert('✅ Futures chiusi completamente')
    await load()
  } catch (e: any) {
    alert(`❌ Errore: ${e?.response?.data?.message ?? e?.message}`)
  } finally { loading.value = false }
}

async function resetAll() {
  if (!confirm('RESET COMPLETO? Chiude spot + futures + pulisce DB')) return
  loading.value = true
  try {
    await axios.post('/api/funding-arb/reset-all')
    alert('✅ Reset completo eseguito')
    await load()
  } catch (e: any) {
    alert(`❌ Errore: ${e?.response?.data?.message ?? e?.message}`)
  } finally { loading.value = false }
}

async function cleanHistory() {
  if (!confirm('Cancellare le posizioni chiuse di test dal DB? (non tocca le posizioni reali aperte)')) return
  loading.value = true
  try {
    const { data } = await axios.post('/api/funding-arb/clean-history')
    alert(`✅ ${data.removed} posizioni di test rimosse`)
    await load()
  } catch (e: any) {
    alert(`❌ Errore: ${e?.response?.data?.message ?? e?.message}`)
  } finally { loading.value = false }
}

async function saveConfig() {
  if (!config.value) return
  savingConfig.value = true
  try {
    await axios.patch('/api/funding-arb/config', {
      capitalPerPosition: config.value.capitalPerPosition,
      leveragePerPosition: config.value.leveragePerPosition,
      maxOpenPositions: config.value.maxOpenPositions,
    })
    alert('✅ Config salvata')
  } catch (e: any) {
    alert(`❌ Errore: ${e?.response?.data?.message ?? e?.message}`)
  } finally { savingConfig.value = false }
}

async function loadProjection() {
  if (!simSymbol.value || !simCapital.value) return
  try {
    const { data } = await axios.get(`/api/funding-arb/projection?symbol=${encodeURIComponent(simSymbol.value)}&capital=${simCapital.value}&leverage=${simLeverage.value}`)
    projection.value = data
  } catch { projection.value = null }
}

async function enterNow() {
  if (!simSymbol.value || !simCapital.value || entering.value) return
  entering.value = true
  try {
    const { data } = await axios.post('/api/funding-arb/enter', {
      symbol: simSymbol.value,
      capitalUsdt: simCapital.value,
      leverage: simLeverage.value,
    })
    alert(`✅ Entrato in ${data.base}!\nNotional: ${data.notional}$\nDaily: +${data.dailyProfit}$\nLiq: ±${data.liquidationPct}%`)
  } catch (e: any) {
    alert(`❌ Entry fallito: ${e?.response?.data?.message ?? e?.message}`)
  } finally {
    entering.value = false
  }
}

watch([simSymbol, simCapital, simLeverage], loadProjection)

const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s fa`
  if (s < 3600) return `${Math.floor(s / 60)}m fa`
  return `${Math.floor(s / 3600)}h fa`
}

const nextFundingIn = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms < 0) return 'imminente'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  return `${h}h ${m}m`
}

const absVal = (n: number) => Math.abs(n)

const formatVol = (v: number) => {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  return (v / 1e3).toFixed(0) + 'K'
}

onMounted(load)
</script>
