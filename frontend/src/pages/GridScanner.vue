<template>
  <div class="p-3 sm:p-6 space-y-4">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-sky-400 animate-pulse" />
          🔲 Grid Trading
          <span class="text-xs font-normal text-gray-500">Coppie in range · 2 long + 2 short · {{ config?.timeframe ?? '15m' }} · leva {{ config?.leverage ?? 3 }}x</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Scan ogni 5min ·
          <span v-if="status?.lastScanAt" class="ml-1">aggiornato {{ timeAgo(status.lastScanAt) }}</span>
          <span class="ml-2 text-gray-600">· {{ status?.inRangePairs ?? 0 }} coppie in range</span>
        </p>
      </div>
      <div class="flex gap-2">
        <button v-if="config" @click="toggleAuto"
          :class="['px-3 py-1.5 rounded text-sm font-medium transition', config.autoTradeEnabled ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' : 'bg-surface-200 text-gray-500 hover:bg-surface-300']">
          🤖 SIM {{ config.autoTradeEnabled ? 'ON' : 'OFF' }}
        </button>
        <button @click="resetGrid" :disabled="loading"
          class="px-3 py-1.5 rounded text-sm font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition">
          ⚠️ Reset
        </button>
        <Button size="small" icon="pi pi-bolt" label="Scan ora" severity="secondary" :loading="loading" @click="forceScan()" />
        <Button size="small" icon="pi pi-refresh" label="Aggiorna" severity="secondary" :loading="loading" @click="load()" />
      </div>
    </div>

    <!-- Come funziona -->
    <div class="stat-card border border-sky-500/20 bg-sky-500/5">
      <div class="text-sm text-sky-400 font-semibold mb-2">Come funziona</div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs text-gray-400">
        <div>
          <div class="text-white font-medium mb-1">1. Trova coppie in range</div>
          ADX basso (no trend), prezzo che oscilla tra supporto e resistenza. Più "scarica" è la coppia, meglio è.
        </div>
        <div>
          <div class="text-white font-medium mb-1">2. Apri griglie (2 long + 2 short)</div>
          Compri basso / vendi alto a ogni livello. 2 long e 2 short bilanciano l'esposizione direzionale.
        </div>
        <div>
          <div class="text-white font-medium mb-1">3. Esci al break del trend</div>
          Se l'ADX sale o il prezzo rompe il range, il grid esce e ne cerca un'altra in range.
        </div>
      </div>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-sky-400">{{ status?.inRangePairs ?? 0 }}</div>
        <div class="text-sm text-gray-500 mt-1">Coppie in range</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-white">{{ status?.topScore ?? 0 }}</div>
        <div class="text-sm text-gray-500 mt-1">Miglior score</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-emerald-400">{{ activeBots.length }}</div>
        <div class="text-sm text-gray-500 mt-1">Griglie attive</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-yellow-400">{{ bestApr }}%</div>
        <div class="text-sm text-gray-500 mt-1">Miglior APR stimato</div>
      </div>
    </div>

    <!-- PnL Simulazione (paper trading con prezzi reali) -->
    <div v-if="sim" class="grid grid-cols-2 sm:grid-cols-5 gap-3">
      <div class="stat-card border-2" :class="sim.totalPnl >= 0 ? 'border-emerald-500/40' : 'border-red-500/40'">
        <div class="text-xs text-gray-500 mb-1">📊 PnL Simulato Totale</div>
        <div class="text-2xl font-black font-mono" :class="sim.totalPnl >= 0 ? 'text-emerald-400' : 'text-red-400'">
          {{ sim.totalPnl >= 0 ? '+' : '' }}${{ sim.totalPnl.toFixed(4) }}
        </div>
        <div class="text-[10px] text-gray-600 mt-0.5">paper trading · prezzi reali</div>
      </div>
      <div class="stat-card border border-emerald-500/20">
        <div class="text-xs text-gray-500 mb-1">Aperte (non realizz.)</div>
        <div class="text-xl font-bold font-mono" :class="sim.openPnl >= 0 ? 'text-emerald-400' : 'text-red-400'">{{ sim.openPnl >= 0 ? '+' : '' }}${{ sim.openPnl.toFixed(4) }}</div>
      </div>
      <div class="stat-card border border-sky-500/20">
        <div class="text-xs text-gray-500 mb-1">Chiuse (realizz.)</div>
        <div class="text-xl font-bold font-mono" :class="sim.closedPnl >= 0 ? 'text-sky-400' : 'text-red-400'">{{ sim.closedPnl >= 0 ? '+' : '' }}${{ sim.closedPnl.toFixed(4) }}</div>
      </div>
      <div class="stat-card border border-white/10">
        <div class="text-xs text-gray-500 mb-1">Cicli totali</div>
        <div class="text-xl font-bold font-mono text-white">{{ sim.totalCycles }}</div>
      </div>
      <div class="stat-card border border-white/10">
        <div class="text-xs text-gray-500 mb-1">Griglie</div>
        <div class="text-xl font-bold font-mono text-white">{{ sim.openCount }} <span class="text-gray-600 text-sm">/ {{ sim.closedCount }} chiuse</span></div>
      </div>
    </div>

    <!-- Config -->
    <div v-if="config" class="stat-card border border-gray-500/20">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm text-gray-400 font-medium">⚙️ Config Grid</div>
        <button @click="saveConfig" :disabled="savingConfig"
          class="px-3 py-1 rounded text-xs font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition disabled:opacity-50">
          {{ savingConfig ? 'Salvo...' : '💾 Salva' }}
        </button>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div>
          <div class="text-xs text-gray-500 mb-1">Timeframe</div>
          <select v-model="config.timeframe" class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono">
            <option value="5m">5m (più veloce)</option>
            <option value="15m">15m (più stabile)</option>
          </select>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Leva</div>
          <select v-model.number="config.leverage" class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono">
            <option :value="2">2x (liq ±50%)</option>
            <option :value="3">3x (liq ±33%)</option>
            <option :value="4">4x (liq ±25%)</option>
            <option :value="5">5x (liq ±20%)</option>
          </select>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Capitale/griglia (USDT)</div>
          <input v-model.number="config.capitalPerGrid" type="number" min="5" step="5"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Livelli per griglia</div>
          <input v-model.number="config.gridLevels" type="number" min="5" max="100" step="1"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Max ADX (entrata range)</div>
          <input v-model.number="config.maxAdx" type="number" min="5" max="40" step="1"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Exit ADX (break)</div>
          <input v-model.number="config.exitAdx" type="number" min="20" max="50" step="1"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Grid long / short</div>
          <div class="flex gap-2">
            <input v-model.number="config.maxLongGrids" type="number" min="0" max="5"
              class="w-full bg-surface-100 border border-emerald-500/20 rounded px-2 py-1.5 text-sm text-emerald-400 font-mono" />
            <input v-model.number="config.maxShortGrids" type="number" min="0" max="5"
              class="w-full bg-surface-100 border border-red-500/20 rounded px-2 py-1.5 text-sm text-red-400 font-mono" />
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1">Volume min 24h</div>
          <input v-model.number="config.minVolume24h" type="number" min="100000" step="100000"
            class="w-full bg-surface-100 border border-white/10 rounded px-3 py-1.5 text-sm text-white font-mono" />
        </div>
      </div>
    </div>

    <!-- Suggerimenti bilanciati -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <!-- LONG -->
      <div class="stat-card border border-emerald-500/20">
        <div class="text-sm text-emerald-400 font-medium mb-3">🟢 Suggerite per Grid LONG ({{ config?.maxLongGrids ?? 2 }})</div>
        <div v-if="suggestions?.long?.length" class="space-y-2">
          <div v-for="c in suggestions.long" :key="c.symbol" class="flex items-center justify-between text-xs font-mono p-2 rounded bg-emerald-500/5">
            <div><span class="text-white font-bold">{{ c.base }}</span> <span class="text-gray-600">score {{ c.score }}</span></div>
            <div class="text-gray-400">range {{ c.rangePct }}% · ~{{ c.aprEst }}% APR · {{ c.cyclesPerDay }}cicli/g</div>
          </div>
        </div>
        <div v-else class="text-xs text-gray-600">Nessuna coppia in range adatta a long</div>
      </div>
      <!-- SHORT -->
      <div class="stat-card border border-red-500/20">
        <div class="text-sm text-red-400 font-medium mb-3">🔴 Suggerite per Grid SHORT ({{ config?.maxShortGrids ?? 2 }})</div>
        <div v-if="suggestions?.short?.length" class="space-y-2">
          <div v-for="c in suggestions.short" :key="c.symbol" class="flex items-center justify-between text-xs font-mono p-2 rounded bg-red-500/5">
            <div><span class="text-white font-bold">{{ c.base }}</span> <span class="text-gray-600">score {{ c.score }}</span></div>
            <div class="text-gray-400">range {{ c.rangePct }}% · ~{{ c.aprEst }}% APR · {{ c.cyclesPerDay }}cicli/g</div>
          </div>
        </div>
        <div v-else class="text-xs text-gray-600">Nessuna coppia in range adatta a short</div>
      </div>
    </div>

    <!-- Griglie attive -->
    <div v-if="activeBots.length" class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
        Griglie attive ({{ activeBots.length }}) — simulazione live
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Asset</th>
              <th class="text-center pb-2">Lato</th>
              <th class="text-right pb-2">Leva</th>
              <th class="text-right pb-2">Capitale</th>
              <th class="text-right pb-2">Range</th>
              <th class="text-right pb-2">Prezzo</th>
              <th class="text-right pb-2">Pos</th>
              <th class="text-right pb-2">→Break</th>
              <th class="text-right pb-2">ADX</th>
              <th class="text-right pb-2">Cicli</th>
              <th class="text-right pb-2">PnL</th>
              <th class="text-right pb-2">Aperto</th>
              <th class="text-right pb-2"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in activeBots" :key="b.id" class="border-b border-white/3 hover:bg-surface-100 transition">
              <td class="py-2 text-white font-bold">{{ b.symbol.replace('/USDT:USDT','') }}</td>
              <td class="py-2 text-center"><span :class="b.side === 'long' ? 'text-emerald-400' : 'text-red-400'">{{ b.side.toUpperCase() }}</span></td>
              <td class="py-2 text-right text-gray-400">{{ b.leverage }}x</td>
              <td class="py-2 text-right text-gray-400">${{ b.capitalUsdt }}</td>
              <td class="py-2 text-right text-gray-500">{{ b.rangeLow }}–{{ b.rangeHigh }}</td>
              <td class="py-2 text-right text-white">{{ b.currentPrice }}</td>
              <td class="py-2 text-right">
                <span :class="b.pricePos > 0.85 || b.pricePos < 0.15 ? 'text-yellow-400' : 'text-gray-500'">{{ (b.pricePos * 100).toFixed(0) }}%</span>
              </td>
              <td class="py-2 text-right" :class="b.distToBreakPct < 1 ? 'text-red-400' : 'text-gray-500'">{{ b.distToBreakPct }}%</td>
              <td class="py-2 text-right" :class="b.adx && b.adx > 25 ? 'text-red-400' : 'text-gray-500'">{{ b.adx ?? '—' }}</td>
              <td class="py-2 text-right">{{ b.filledCycles }}</td>
              <td class="py-2 text-right font-bold" :class="b.realizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'">{{ b.realizedPnl >= 0 ? '+' : '' }}${{ b.realizedPnl.toFixed(4) }}</td>
              <td class="py-2 text-right text-gray-500">{{ timeAgo(b.openedAt) }}</td>
              <td class="py-2 text-right"><button @click="closeGrid(b.id)" class="text-red-400/70 hover:text-red-400 text-[10px]">✕</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Storico griglie chiuse -->
    <div v-if="closedBots.length" class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3">📕 Storico griglie chiuse ({{ closedBots.length }})</div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Asset</th>
              <th class="text-center pb-2">Lato</th>
              <th class="text-right pb-2">Cicli</th>
              <th class="text-right pb-2">PnL</th>
              <th class="text-right pb-2">Motivo uscita</th>
              <th class="text-right pb-2">Chiusa</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="b in closedBots" :key="b.id" class="border-b border-white/3">
              <td class="py-2 text-white font-bold">{{ b.symbol.replace('/USDT:USDT','') }}</td>
              <td class="py-2 text-center"><span :class="b.side === 'long' ? 'text-emerald-400' : 'text-red-400'">{{ b.side.toUpperCase() }}</span></td>
              <td class="py-2 text-right">{{ b.filledCycles }}</td>
              <td class="py-2 text-right font-bold" :class="(b.closePnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'">{{ (b.closePnl ?? 0) >= 0 ? '+' : '' }}${{ (b.closePnl ?? 0).toFixed(4) }}</td>
              <td class="py-2 text-right" :class="b.closeReason?.includes('break') || b.closeReason === 'trend_adx' ? 'text-yellow-400' : 'text-gray-500'">{{ b.closeReason }}</td>
              <td class="py-2 text-right text-gray-500">{{ b.closedAt ? timeAgo(b.closedAt) : '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tabella coppie in range -->
    <div class="stat-card">
      <div class="text-sm text-gray-400 font-medium mb-3 flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-sky-400 inline-block" />
        Coppie in range (ordinate per score)
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Asset</th>
              <th class="text-right pb-2">Score</th>
              <th class="text-right pb-2">ADX</th>
              <th class="text-right pb-2">RSI</th>
              <th class="text-right pb-2">Range%</th>
              <th class="text-right pb-2">Pos</th>
              <th class="text-right pb-2">Spacing</th>
              <th class="text-right pb-2">Cicli/g</th>
              <th class="text-right pb-2 text-yellow-400">APR est</th>
              <th class="text-center pb-2">Lato</th>
              <th class="text-right pb-2">Break</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in candidates" :key="c.symbol" class="border-b border-white/3 hover:bg-surface-100 transition">
              <td class="py-2 text-white font-bold">{{ c.base }}</td>
              <td class="py-2 text-right font-bold" :class="c.score >= 70 ? 'text-emerald-400' : c.score >= 50 ? 'text-yellow-400' : 'text-gray-400'">{{ c.score }}</td>
              <td class="py-2 text-right" :class="c.adx < 15 ? 'text-emerald-400' : 'text-gray-400'">{{ c.adx }}</td>
              <td class="py-2 text-right text-gray-400">{{ c.rsi }}</td>
              <td class="py-2 text-right text-gray-400">{{ c.rangePct }}%</td>
              <td class="py-2 text-right text-gray-500">{{ (c.pricePos * 100).toFixed(0) }}%</td>
              <td class="py-2 text-right text-gray-500">{{ c.spacingPct }}%</td>
              <td class="py-2 text-right text-gray-400">{{ c.cyclesPerDay }}</td>
              <td class="py-2 text-right text-yellow-400">{{ c.aprEst }}%</td>
              <td class="py-2 text-center"><span :class="c.preferredSide === 'long' ? 'text-emerald-400' : 'text-red-400'">{{ c.preferredSide === 'long' ? 'L' : 'S' }}</span></td>
              <td class="py-2 text-right" :class="c.breakRisk === 'ok' ? 'text-gray-600' : 'text-yellow-400'">{{ c.breakRisk }}</td>
            </tr>
            <tr v-if="!candidates.length">
              <td colspan="11" class="py-4 text-center text-gray-600">Nessuna coppia in range trovata — mercato in trend o scan in corso</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import Button from 'primevue/button'

const loading      = ref(false)
const savingConfig = ref(false)
const dashboard    = ref<any>(null)
const config       = ref<any>(null)

const status      = computed(() => dashboard.value?.status)
const candidates  = computed<any[]>(() => dashboard.value?.candidates ?? [])
const suggestions = computed(() => dashboard.value?.suggestions ?? { long: [], short: [] })
const activeBots  = computed<any[]>(() => dashboard.value?.activeBots ?? [])
const closedBots  = computed<any[]>(() => dashboard.value?.closedBots ?? [])
const sim         = computed(() => dashboard.value?.sim)
const bestApr     = computed(() => candidates.value[0]?.aprEst ?? 0)

async function load() {
  loading.value = true
  try {
    const { data } = await axios.get('/api/grid-scanner/dashboard')
    dashboard.value = data
    config.value = data.config
  } catch (e: any) {
    console.warn('Grid load error:', e?.message)
  } finally { loading.value = false }
}

async function forceScan() {
  loading.value = true
  try { await axios.post('/api/grid-scanner/scan'); await new Promise(r => setTimeout(r, 2000)); await load() }
  finally { loading.value = false }
}

async function closeGrid(id: string) {
  if (!confirm('Chiudere questa griglia simulata?')) return
  try { await axios.post('/api/grid-scanner/close', { id }); await load() }
  catch (e: any) { alert(`❌ ${e?.response?.data?.message ?? e?.message}`) }
}

async function resetGrid() {
  if (!confirm('RESET totale: chiude tutte le griglie LIVE (ordini + posizioni reali su MEXC) e cancella tutti i dati. Continuare?')) return
  loading.value = true
  try {
    const { data } = await axios.post('/api/grid-scanner/reset')
    alert(`✅ Reset: ${data.liveClosed} griglie live chiuse, ${data.dbRemoved} record rimossi`)
    await load()
  } catch (e: any) {
    alert(`❌ ${e?.response?.data?.message ?? e?.message}`)
  } finally { loading.value = false }
}

async function toggleAuto() {
  if (!config.value) return
  try {
    config.value.autoTradeEnabled = !config.value.autoTradeEnabled
    await axios.patch('/api/grid-scanner/config', { autoTradeEnabled: config.value.autoTradeEnabled, enabled: true })
  } catch (e: any) {
    config.value.autoTradeEnabled = !config.value.autoTradeEnabled
    alert(`❌ ${e?.response?.data?.message ?? e?.message}`)
  }
}

async function saveConfig() {
  if (!config.value) return
  savingConfig.value = true
  try {
    await axios.patch('/api/grid-scanner/config', {
      timeframe: config.value.timeframe,
      leverage: config.value.leverage,
      capitalPerGrid: config.value.capitalPerGrid,
      gridLevels: config.value.gridLevels,
      maxAdx: config.value.maxAdx,
      exitAdx: config.value.exitAdx,
      maxLongGrids: config.value.maxLongGrids,
      maxShortGrids: config.value.maxShortGrids,
      minVolume24h: config.value.minVolume24h,
    })
    alert('✅ Config salvata')
    await load()
  } catch (e: any) {
    alert(`❌ Errore: ${e?.response?.data?.message ?? e?.message}`)
  } finally { savingConfig.value = false }
}

const timeAgo = (iso: string) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s fa`
  if (s < 3600) return `${Math.floor(s / 60)}m fa`
  return `${Math.floor(s / 3600)}h fa`
}

onMounted(load)
</script>
