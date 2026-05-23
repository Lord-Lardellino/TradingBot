<template>
  <div class="p-4 md:p-6 space-y-4 max-w-[1400px] mx-auto">

    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-brand flex items-center justify-center">
            <i class="pi pi-microchip-ai text-white text-sm" />
          </div>
          <div>
            <h1 class="text-lg font-bold text-white">Smart Scanner <span class="text-xs font-mono bg-brand/20 text-brand px-2 py-0.5 rounded ml-1">AI</span></h1>
            <p class="text-xs text-gray-500">{{ store.status.scannedPairs }} coppie · 500 candidate/ciclo · Gemma filtra ogni segnale · auto-tune ogni 5 min</p>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <span :class="store.status.isScanning ? 'pulse-dot' : 'w-2 h-2 rounded-full bg-gray-600'" />
        <span class="text-xs text-gray-400">{{ store.status.isScanning ? 'Scan...' : store.status.lastScanAt ? new Date(store.status.lastScanAt).toLocaleTimeString('it') : '—' }}</span>
        <button @click="store.reset()" class="text-xs px-2 py-1 rounded-lg bg-surface-200 text-gray-400 hover:text-red-400 border border-white/5">
          <i class="pi pi-trash" /> Reset
        </button>
      </div>
    </div>

    <!-- Stats bar -->
    <div v-if="store.analytics" class="grid grid-cols-2 md:grid-cols-5 gap-2">
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3 text-center">
        <div class="text-lg font-bold" :class="(store.analytics.winRate ?? 0) >= 50 ? 'text-profit' : 'text-loss'">{{ store.analytics.winRate ?? 0 }}%</div>
        <div class="text-[10px] text-gray-500">Win Rate</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3 text-center">
        <div class="text-lg font-bold" :class="(store.analytics.totalPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'">{{ (store.analytics.totalPnl ?? 0) >= 0 ? '+' : '' }}€{{ (store.analytics.totalPnl ?? 0).toFixed(2) }}</div>
        <div class="text-[10px] text-gray-500">P&L Totale</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3 text-center">
        <div class="text-lg font-bold text-white">{{ store.analytics.totalTrades }}</div>
        <div class="text-[10px] text-gray-500">Totale Trade</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3 text-center">
        <div class="text-lg font-bold text-brand">{{ store.analytics.openTrades }}</div>
        <div class="text-[10px] text-gray-500">Aperti</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3 text-center">
        <div class="text-lg font-bold text-white">{{ store.analytics.profitFactor ?? '—' }}</div>
        <div class="text-[10px] text-gray-500">Profit Factor</div>
      </div>
    </div>

    <!-- Live config pills -->
    <div v-if="store.analytics?.config" class="flex flex-wrap gap-2">
      <span class="text-[10px] font-mono px-2 py-1 rounded-full bg-surface-200 text-gray-300">minScore: <b class="text-white">{{ store.analytics.config.minScore }}</b></span>
      <span class="text-[10px] font-mono px-2 py-1 rounded-full bg-surface-200 text-gray-300">minBody: <b class="text-white">{{ (store.analytics.config.minBodyPct * 100).toFixed(0) }}%</b></span>
      <span class="text-[10px] font-mono px-2 py-1 rounded-full bg-surface-200 text-gray-300">ATR×: <b class="text-white">{{ store.analytics.config.atrSlMult }}</b></span>
      <span class="text-[10px] font-mono px-2 py-1 rounded-full bg-surface-200 text-gray-300">RR: <b class="text-white">1:{{ store.analytics.config.tpRr }}</b></span>
      <span :class="['text-[10px] font-mono px-2 py-1 rounded-full', store.analytics.config.autoOptimize ? 'bg-brand/20 text-brand' : 'bg-surface-200 text-gray-500']">
        🤖 Auto-tune {{ store.analytics.config.autoOptimize ? 'ON' : 'OFF' }}
      </span>
      <button @click="toggleGemma" :class="['text-[10px] font-mono px-2 py-1 rounded-full cursor-pointer transition-colors', store.analytics.config.gemmaEnabled ? 'bg-brand/20 text-brand hover:bg-brand/30' : 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30']">
        ✨ Gemma {{ store.analytics.config.gemmaEnabled ? 'ON' : 'OFF' }}
      </button>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 border-b border-white/5">
      <button v-for="tab in tabs" :key="tab.id" @click="activeTab = tab.id"
        :class="['px-4 py-2 text-sm font-medium transition-colors', activeTab === tab.id ? 'text-white border-b-2 border-brand -mb-px' : 'text-gray-500 hover:text-gray-300']">
        {{ tab.label }}
        <span v-if="tab.id === 'signals' && store.signals.length" class="ml-1 text-[10px] bg-surface-200 px-1.5 py-0.5 rounded-full text-gray-400">{{ store.signals.length }}</span>
        <span v-if="tab.id === 'optimizer' && store.optLogs.length" class="ml-1 text-[10px] bg-brand/20 px-1.5 py-0.5 rounded-full text-brand">{{ store.optLogs.length }}</span>
      </button>
    </div>

    <!-- TAB: SEGNALI -->
    <div v-if="activeTab === 'signals'">
      <div v-if="!filteredSignals.length" class="flex flex-col items-center justify-center py-16 gap-3">
        <i class="pi pi-microchip-ai text-brand text-4xl opacity-30" />
        <p class="text-gray-500 text-sm">Nessun segnale — Gemma sta analizzando ogni coppia</p>
      </div>
      <div v-else class="space-y-2">
        <div v-for="sig in filteredSignals" :key="sig.id"
          class="bg-surface-50 border border-white/5 rounded-xl p-3 flex flex-wrap gap-3 items-center">
          <!-- Pattern badge -->
          <span :class="['text-[10px] font-bold px-2 py-1 rounded-full', patBadge(sig.patternType)]">{{ sig.patternName }}</span>
          <!-- Dir badge -->
          <span :class="['text-xs font-bold px-2 py-1 rounded-full', sig.direction === 'LONG' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss']">{{ sig.direction }}</span>
          <!-- Symbol -->
          <span class="text-sm font-semibold text-white">{{ sig.symbol.replace('/USDT:USDT', '') }}</span>
          <!-- Prices -->
          <div class="flex gap-3 text-xs text-gray-400 ml-auto flex-wrap">
            <span>Entry <b class="text-white">{{ sig.entry }}</b></span>
            <span class="text-loss">SL {{ sig.slPct }}%</span>
            <span class="text-profit">TP {{ sig.tpPct }}%</span>
            <span>Score <b class="text-white">{{ sig.score }}</b></span>
            <span :class="gradeBadge(sig.grade)">{{ sig.grade }}</span>
          </div>
          <!-- Gemma verdict -->
          <div v-if="sig.gemmaReason !== undefined" class="w-full mt-1 flex items-center gap-2">
            <span :class="['text-[10px] font-bold px-2 py-0.5 rounded-full', sig.gemmaApproved ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss']">
              {{ sig.gemmaApproved ? '✅ APPROVATO' : '❌ RIFIUTATO' }}
            </span>
            <span class="text-[11px] text-gray-400 italic">{{ sig.gemmaReason }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB: SIMULAZIONE -->
    <div v-if="activeTab === 'simulation'">
      <div v-if="!store.trades.length" class="flex flex-col items-center justify-center py-16 gap-3">
        <i class="pi pi-chart-line text-gray-600 text-4xl" />
        <p class="text-gray-500 text-sm">Nessun trade ancora — solo i segnali approvati da Gemma entrano</p>
      </div>
      <div v-else class="space-y-2">
        <div v-for="t in store.trades" :key="t.id"
          :class="['bg-surface-50 border rounded-xl p-3 space-y-2 text-sm', t.status === 'open' ? 'border-brand/30' : (t.pnl ?? 0) >= 0 ? 'border-profit/20' : 'border-loss/20']">
          <!-- Row 1: direction, symbol, status, pnl, grade, link -->
          <div class="flex flex-wrap gap-3 items-center">
            <span :class="['text-xs font-bold px-2 py-1 rounded-full', t.direction === 'LONG' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss']">{{ t.direction }}</span>
            <a :href="`https://futures.mexc.com/exchange/${t.symbol.replace('/USDT:USDT', '_USDT')}`" target="_blank"
               class="font-semibold text-white hover:text-brand transition-colors flex items-center gap-1">
              {{ t.symbol.replace('/USDT:USDT', '') }}
              <i class="pi pi-external-link text-[10px] text-gray-500" />
            </a>
            <span class="text-gray-400 text-xs">@ {{ t.entry }}</span>
            <span :class="['text-xs font-mono px-2 py-0.5 rounded-full', t.status === 'open' ? 'bg-brand/20 text-brand' : (t.pnl ?? 0) >= 0 ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss']">
              {{ t.status === 'open' ? 'APERTO' : t.status.toUpperCase() }}
            </span>
            <div class="ml-auto flex gap-4 text-xs text-gray-400">
              <span v-if="t.status === 'open' && t.unrealizedPnl !== undefined" :class="(t.unrealizedPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                {{ (t.unrealizedPnl ?? 0) >= 0 ? '+' : '' }}€{{ (t.unrealizedPnl ?? 0).toFixed(3) }}
              </span>
              <span v-else-if="t.pnl !== undefined" :class="(t.pnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
                {{ (t.pnl ?? 0) >= 0 ? '+' : '' }}€{{ (t.pnl ?? 0).toFixed(3) }}
              </span>
              <span>Grade <b class="text-white">{{ t.grade }}</b></span>
            </div>
          </div>
          <!-- Row 2: SL / TP levels -->
          <div class="flex gap-4 text-[11px] text-gray-500 pl-1">
            <span>SL <b class="text-loss font-mono">{{ t.stopLoss }}</b></span>
            <span>TP <b class="text-profit font-mono">{{ t.takeProfit1 }}</b></span>
            <span class="text-gray-600">leva {{ t.leverage }}×</span>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB: AI OPTIMIZER -->
    <div v-if="activeTab === 'optimizer'" class="space-y-4">
      <!-- Controlli -->
      <div class="flex flex-wrap gap-3 items-center">
        <div class="flex items-center gap-2">
          <label class="text-xs text-gray-400">Auto-tune ogni 5 min</label>
          <button @click="toggleAutoOptimize"
            :class="['w-10 h-5 rounded-full transition-colors relative', store.analytics?.config?.autoOptimize ? 'bg-brand' : 'bg-surface-200']">
            <span :class="['absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform', store.analytics?.config?.autoOptimize ? 'translate-x-5' : 'translate-x-0.5']" />
          </button>
        </div>
        <div class="flex items-center gap-2">
          <label class="text-xs text-gray-400">Filtro Gemma AI</label>
          <button @click="toggleGemma"
            :class="['w-10 h-5 rounded-full transition-colors relative', store.analytics?.config?.gemmaEnabled ? 'bg-brand' : 'bg-surface-200']">
            <span :class="['absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform', store.analytics?.config?.gemmaEnabled ? 'translate-x-5' : 'translate-x-0.5']" />
          </button>
        </div>
        <button @click="store.triggerOptimize()" class="text-xs px-3 py-1.5 rounded-lg bg-brand/20 text-brand border border-brand/30 hover:bg-brand/30">
          <i class="pi pi-refresh mr-1" />Ottimizza ora
        </button>
        <span v-if="!store.optLogs.length" class="text-xs text-gray-600">Servono almeno 8 trade chiusi per l'ottimizzazione</span>
      </div>

      <!-- Come funziona -->
      <div class="bg-surface-50 border border-brand/20 rounded-xl p-4 text-sm">
        <div class="flex items-center gap-2 mb-2">
          <i class="pi pi-microchip-ai text-brand" />
          <span class="font-semibold text-white">Come funziona</span>
        </div>
        <ul class="text-xs text-gray-400 space-y-1 list-disc list-inside">
          <li>Ogni segnale viene valutato da Gemma prima di entrare — solo quelli approvati aprono un trade simulato</li>
          <li>Ogni 5 minuti Gemma analizza i trade chiusi: cosa è andato storto sugli SL, cosa ha funzionato sui TP</li>
          <li>Propone e applica automaticamente nuovi parametri (minScore, minBodyPct, ATR×, RR) con guardrail di sicurezza</li>
          <li>Il log mostra ogni ciclo: analisi, parametri modificati, motivazione</li>
        </ul>
      </div>

      <!-- Log ottimizzazioni -->
      <div v-if="!store.optLogs.length" class="text-center py-8 text-gray-600 text-sm">
        Nessuna ottimizzazione ancora — il primo ciclo parte dopo 8 trade chiusi
      </div>
      <div v-else class="space-y-3">
        <div v-for="log in store.optLogs" :key="log.id" class="bg-surface-50 border border-white/5 rounded-xl p-4">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-[10px] text-gray-500 font-mono">{{ new Date(log.createdAt).toLocaleString('it') }}</span>
            <span class="text-[10px] bg-surface-200 px-1.5 py-0.5 rounded text-gray-400">{{ log.tradesAnalyzed }} trade analizzati</span>
            <span :class="['text-[10px] px-1.5 py-0.5 rounded', log.applied ? 'bg-profit/20 text-profit' : 'bg-gray-700 text-gray-500']">
              {{ log.applied ? 'Applicato' : 'Nessun cambio' }}
            </span>
          </div>
          <p class="text-sm text-gray-300 mb-2">{{ log.analysis }}</p>
          <div v-if="log.applied && parsedChanges(log.changes)" class="flex flex-wrap gap-2 mb-2">
            <span v-for="(val, key) in parsedChanges(log.changes)" :key="key"
              class="text-[10px] font-mono bg-brand/20 text-brand px-2 py-0.5 rounded-full">
              {{ key }}: {{ val }}
            </span>
          </div>
          <p class="text-xs text-gray-500 italic">{{ log.reason }}</p>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useSmartScannerStore } from '@/stores/smart-scanner'

const store = useSmartScannerStore()
const activeTab = ref('signals')

const tabs = [
  { id: 'signals',    label: '⚡ Segnali' },
  { id: 'simulation', label: '📊 Simulazione' },
  { id: 'optimizer',  label: '🤖 AI Optimizer' },
]

const filteredSignals = computed(() => store.signals)

function patBadge(pt: number) {
  if (pt === 1) return 'bg-orange-500/20 text-orange-400'
  if (pt === 2) return 'bg-blue-500/20 text-blue-400'
  if (pt === 3) return 'bg-purple-500/20 text-purple-400'
  if (pt === 4) return 'bg-teal-500/20 text-teal-400'
  if (pt === 5) return 'bg-green-500/20 text-green-400'
  if (pt === 6) return 'bg-yellow-500/20 text-yellow-300'
  return 'bg-gray-500/20 text-gray-400'
}
function gradeBadge(g: string) {
  if (g === 'A+') return 'text-yellow-400 font-bold'
  if (g === 'A')  return 'text-profit'
  if (g === 'B')  return 'text-brand'
  return 'text-gray-500'
}
function parsedChanges(raw: string) {
  try { const obj = JSON.parse(raw); return Object.keys(obj).length ? obj : null } catch { return null }
}
async function toggleAutoOptimize() {
  const current = store.analytics?.config?.autoOptimize ?? true
  await store.updateConfig({ autoOptimize: !current })
}
async function toggleGemma() {
  const current = store.analytics?.config?.gemmaEnabled ?? true
  await store.updateConfig({ gemmaEnabled: !current })
}

onMounted(async () => {
  await Promise.all([store.fetchSignals(), store.fetchStatus(), store.fetchAnalytics(), store.fetchTrades(), store.fetchOptLogs()])
})
</script>
