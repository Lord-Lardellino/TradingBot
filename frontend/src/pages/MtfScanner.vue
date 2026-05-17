<template>
  <div class="p-6 space-y-5">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          📡 Multi-TF Scanner
          <span class="text-xs font-normal px-2 py-0.5 rounded bg-cyan-500/20 text-cyan-400 border border-cyan-500/20">
            ERB v7 · EMA34 Bounce
          </span>
        </h1>
        <p class="text-xs text-gray-500 mt-1 font-mono">
          Stessa strategia scalping — adattata su 5m · 15m · 1h
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="clearSignals"
          class="px-3 py-1.5 rounded-lg text-sm bg-surface-200 text-gray-400 border border-white/5 hover:text-white">
          <i class="pi pi-trash" />
        </button>
      </div>
    </div>

    <!-- Tabs TF -->
    <div class="flex gap-1 bg-surface-100 p-1 rounded-xl w-fit">
      <button
        v-for="tf in tfs" :key="tf"
        @click="activeTf = tf"
        :class="[
          'px-5 py-2 rounded-lg text-sm font-semibold transition-all',
          activeTf === tf
            ? 'bg-cyan-500 text-white shadow'
            : 'text-gray-400 hover:text-white hover:bg-surface-200',
        ]"
      >
        {{ tf }}
        <span v-if="liveCount(tf)" class="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-white/20">
          {{ liveCount(tf) }}
        </span>
      </button>
    </div>

    <!-- Status bar TF attivo -->
    <div class="stat-card py-3">
      <div class="flex flex-wrap items-center gap-5 text-xs text-gray-400 font-mono">
        <span>🔍 {{ currentStatus.scannedPairs }} coppie</span>
        <span>📋 {{ currentStatus.candidates }} candidate</span>
        <span>⚡ {{ currentStatus.rawSignals }} raw</span>
        <span>✅ {{ currentStatus.emitted }} emessi</span>
        <span>🕒 {{ lastScanFormatted }}</span>
        <span v-if="currentStatus.isScanning" class="text-yellow-400">⟳ scansione...</span>
        <span class="ml-auto text-gray-600">
          SL {{ tfCfg.sl }} · TP1 {{ tfCfg.tp1 }} · TP2 {{ tfCfg.tp2 }}
        </span>
      </div>
    </div>

    <!-- Analytics -->
    <div v-if="currentAnalytics" class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">Capitale</div>
        <div class="text-xl font-bold font-mono text-white">
          €{{ currentAnalytics.currentCapital.toFixed(0) }}
        </div>
        <div :class="['text-xs mt-0.5', currentAnalytics.totalPnlPct >= 0 ? 'text-profit' : 'text-loss']">
          {{ currentAnalytics.totalPnlPct >= 0 ? '+' : '' }}{{ currentAnalytics.totalPnlPct.toFixed(2) }}%
        </div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">P&L netto</div>
        <div :class="['text-xl font-bold font-mono', currentAnalytics.totalPnl >= 0 ? 'text-profit' : 'text-loss']">
          {{ currentAnalytics.totalPnl >= 0 ? '+' : '' }}€{{ currentAnalytics.totalPnl.toFixed(2) }}
        </div>
        <div class="text-xs text-gray-600 mt-0.5">fee: -€{{ currentAnalytics.totalFeesPaid.toFixed(2) }}</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">Win Rate</div>
        <div :class="['text-xl font-bold font-mono', currentAnalytics.winRate >= 50 ? 'text-profit' : 'text-loss']">
          {{ currentAnalytics.winRate.toFixed(1) }}%
        </div>
        <div class="text-xs text-gray-600 mt-0.5">{{ currentAnalytics.wins }}W · {{ currentAnalytics.losses }}L · {{ currentAnalytics.openTrades }} open</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">RR Reale</div>
        <div :class="['text-xl font-bold font-mono', currentAnalytics.rrActual >= 2 ? 'text-profit' : currentAnalytics.rrActual >= 1 ? 'text-yellow-400' : 'text-loss']">
          {{ currentAnalytics.rrActual.toFixed(2) }}×
        </div>
        <div class="text-xs text-gray-600 mt-0.5">avg win / avg loss</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">Profit Factor</div>
        <div :class="['text-xl font-bold font-mono', currentAnalytics.profitFactor >= 1.5 ? 'text-profit' : currentAnalytics.profitFactor >= 1 ? 'text-yellow-400' : 'text-loss']">
          {{ currentAnalytics.profitFactor.toFixed(2) }}
        </div>
        <div class="text-xs text-gray-600 mt-0.5">{{ currentAnalytics.totalTrades }} trade totali</div>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2 text-xs text-gray-400">
        <span>Grade min</span>
        <Select v-model="filterGrade" :options="gradeOptions" option-label="label" option-value="value" size="small" />
      </div>
      <div class="flex items-center gap-2 text-xs text-gray-400">
        <span>Direzione</span>
        <Select v-model="filterDir" :options="dirOptions" option-label="label" option-value="value" size="small" />
      </div>
      <span class="text-xs text-gray-600 ml-auto">{{ filteredSignals.length }} segnali</span>
    </div>

    <!-- Signal cards -->
    <div v-if="filteredSignals.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <div
        v-for="sig in filteredSignals"
        :key="sig.id"
        class="stat-card p-4 space-y-3 relative"
      >
        <!-- Grade badge + direction -->
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span :class="['text-xs font-bold px-2 py-0.5 rounded', gradeClass(sig.grade)]">
              {{ sig.grade }}
            </span>
            <span :class="['text-xs font-bold px-2 py-0.5 rounded', sig.direction === 'LONG' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss']">
              {{ sig.direction }}
            </span>
          </div>
          <a :href="sig.mexcUrl" target="_blank" class="text-xs text-gray-500 hover:text-cyan-400 font-mono">
            {{ sig.symbol.replace('/USDT:USDT', '') }}
            <i class="pi pi-external-link ml-1 text-[10px]" />
          </a>
        </div>

        <!-- SparkChart -->
        <div v-if="sig.sparkline?.length" class="rounded-lg overflow-hidden border border-white/10">
          <SparkChart :candles="sig.sparkline" :ema34="sig.ema34spark ?? []" :entry="sig.entry" :is-long="sig.direction === 'LONG'" />
        </div>

        <!-- Price levels -->
        <div class="grid grid-cols-3 gap-2 text-center text-xs">
          <div class="bg-loss/10 rounded p-2">
            <div class="text-gray-500">SL</div>
            <div class="text-loss font-mono font-bold">{{ sig.stopLoss.toPrecision(5) }}</div>
            <div class="text-gray-600">-{{ sig.slPct }}%</div>
          </div>
          <div class="bg-surface-200 rounded p-2">
            <div class="text-gray-500">Entry</div>
            <div class="text-white font-mono font-bold">{{ sig.entry.toPrecision(5) }}</div>
            <div class="text-gray-600">{{ sig.suggestedLeverage }}×</div>
          </div>
          <div class="bg-profit/10 rounded p-2">
            <div class="text-gray-500">TP1</div>
            <div class="text-profit font-mono font-bold">{{ sig.takeProfit1.toPrecision(5) }}</div>
            <div class="text-gray-600">+{{ sig.tp1Pct }}%</div>
          </div>
        </div>

        <!-- Reasons -->
        <div v-if="sig.reasons.length" class="flex flex-wrap gap-1">
          <span v-for="r in sig.reasons" :key="r"
            class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/15">
            {{ r }}
          </span>
        </div>

        <!-- Metrics row -->
        <div class="flex items-center justify-between text-xs text-gray-500">
          <span>RSI {{ sig.rsi }}</span>
          <span>Vol ×{{ sig.volumeRatio }}</span>
          <span :class="sig.macdConfirm ? 'text-profit' : 'text-gray-600'">MACD {{ sig.macdConfirm ? '✓' : '—' }}</span>
          <span>Score {{ sig.score }}</span>
        </div>

        <div class="text-[10px] text-gray-600 font-mono">
          {{ new Date(sig.timestamp).toLocaleTimeString() }}
          · Vol 24h ${{ (sig.quoteVolume24h / 1_000_000).toFixed(1) }}M
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-else class="stat-card text-center py-16">
      <i class="pi pi-chart-line text-4xl text-gray-700 mb-3" />
      <p class="text-gray-500">Nessun segnale {{ activeTf }} ancora.</p>
      <p class="text-xs text-gray-600 mt-1">Il prossimo scan di {{ activeTf }} arriverà tra poco.</p>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import Select from 'primevue/select'
import SparkChart from '@/components/SparkChart.vue'
import { useMtfScannerStore } from '@/stores/mtf-scanner'

const store = useMtfScannerStore()

const tfs = ['5m', '15m', '1h'] as const
type Tf = typeof tfs[number]

const activeTf = ref<Tf>('5m')

const TF_CFG = {
  '5m':  { sl: '0.60%', tp1: '1.20%', tp2: '1.80%' },
  '15m': { sl: '0.80%', tp1: '1.60%', tp2: '2.40%' },
  '1h':  { sl: '1.20%', tp1: '2.40%', tp2: '3.60%' },
}

const tfCfg = computed(() => TF_CFG[activeTf.value])

const filterGrade = ref('C')
const filterDir   = ref('ALL')
const gradeOptions = [
  { label: 'Tutti',   value: 'C'  },
  { label: 'B+',      value: 'B'  },
  { label: 'A+, A',   value: 'A'  },
  { label: 'Solo A+', value: 'A+' },
]
const dirOptions = [
  { label: 'LONG + SHORT', value: 'ALL'   },
  { label: 'Solo LONG',    value: 'LONG'  },
  { label: 'Solo SHORT',   value: 'SHORT' },
]
const gradeOrder: Record<string, number> = { 'C': 0, 'B': 1, 'A': 2, 'A+': 3 }

const currentStatus    = computed(() => store.status[activeTf.value])
const currentAnalytics = computed(() => store.analytics[activeTf.value])

const filteredSignals = computed(() => {
  const minGrade = gradeOrder[filterGrade.value] ?? 0
  return store.signals[activeTf.value]
    .filter((s) => gradeOrder[s.grade] >= minGrade)
    .filter((s) => filterDir.value === 'ALL' || s.direction === filterDir.value)
})

const liveCount = (tf: Tf) => store.signals[tf].length

const lastScanFormatted = computed(() => {
  const t = currentStatus.value?.lastScanAt
  if (!t) return 'mai'
  return new Date(t).toLocaleTimeString()
})

function gradeClass(grade: string) {
  if (grade === 'A+') return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
  if (grade === 'A')  return 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
  if (grade === 'B')  return 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
  return 'bg-gray-500/20 text-gray-400'
}

function clearSignals() {
  store.signals[activeTf.value] = []
}

watch(activeTf, async (tf) => {
  await Promise.all([store.fetchSignals(tf), store.fetchStatus(tf), store.fetchAnalytics(tf)])
})

onMounted(async () => {
  await Promise.all(
    tfs.flatMap((tf) => [store.fetchSignals(tf), store.fetchStatus(tf), store.fetchAnalytics(tf)]),
  )
})
</script>
