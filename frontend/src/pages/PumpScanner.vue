<template>
  <div class="p-6 space-y-5">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          🔍 Pump Scanner
          <span class="text-xs font-normal px-2 py-0.5 rounded bg-brand/20 text-brand-light border border-brand/20">
            FUTURES MEXC
          </span>
        </h1>
        <p class="text-xs text-gray-500 mt-1 font-mono">
          {{ scannedPairs }} coppie monitorate ·
          scan ogni 30s ·
          ultimo: {{ lastScanFormatted }}
          <span v-if="status.isScanning" class="text-yellow-400 ml-2">⟳ scansione in corso...</span>
        </p>
      </div>

      <div class="flex items-center gap-2">
        <!-- Sound toggle -->
        <button
          @click="toggleSound"
          :class="[
            'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors',
            soundEnabled
              ? 'bg-green-500/10 text-green-400 border-green-500/30'
              : 'bg-surface-200 text-gray-500 border-white/5'
          ]"
        >
          <i :class="soundEnabled ? 'pi pi-volume-up' : 'pi pi-volume-off'" />
          {{ soundEnabled ? 'Audio ON' : 'Audio OFF' }}
        </button>
        <button @click="testSound"
          class="px-3 py-1.5 rounded-lg text-sm bg-surface-200 text-gray-400 border border-white/5 hover:text-white">
          Test 🔔
        </button>
        <button @click="scannerStore.signals.splice(0)"
          class="px-3 py-1.5 rounded-lg text-sm bg-surface-200 text-gray-400 border border-white/5 hover:text-white">
          <i class="pi pi-trash" />
        </button>
      </div>
    </div>

    <!-- Audio arm banner -->
    <div v-if="!audioArmed"
      class="flex items-center gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
      <i class="pi pi-exclamation-circle text-yellow-400" />
      <span class="text-sm text-yellow-400 flex-1">
        Clicca per abilitare gli alert sonori (richiesto dal browser).
      </span>
      <Button size="small" label="Abilita audio" icon="pi pi-volume-up" @click="activateAudio" />
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
      <div class="flex items-center gap-2 text-xs text-gray-400">
        <ToggleButton v-model="onlyMTF" on-label="Solo MTF ✓" off-label="Tutti i segnali" size="small" />
      </div>
      <span class="text-xs text-gray-600 ml-auto">{{ filteredSignals.length }} segnali</span>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="stat-card text-center py-3">
        <div class="text-xs text-gray-500 mb-1">LONG</div>
        <div class="text-xl font-bold text-profit">{{ longCount }}</div>
      </div>
      <div class="stat-card text-center py-3">
        <div class="text-xs text-gray-500 mb-1">SHORT</div>
        <div class="text-xl font-bold text-loss">{{ shortCount }}</div>
      </div>
      <div class="stat-card text-center py-3">
        <div class="text-xs text-gray-500 mb-1">Grade A/A+</div>
        <div class="text-xl font-bold text-yellow-400">{{ gradeACount }}</div>
      </div>
      <div class="stat-card text-center py-3">
        <div class="text-xs text-gray-500 mb-1">MTF confermati</div>
        <div class="text-xl font-bold text-brand-light">{{ mtfCount }}</div>
      </div>
    </div>

    <!-- ERB Debug panel -->
    <details class="stat-card text-xs font-mono" open>
      <summary class="cursor-pointer text-gray-500 hover:text-gray-300 select-none">
        ERB filter debug — ultimo ciclo
        <span class="ml-2 text-gray-600">
          ({{ status.rawSignals ?? 0 }} raw → {{ status.emitted ?? 0 }} emessi)
        </span>
      </summary>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
        <div v-for="(entry, i) in debugEntries" :key="i"
          :class="['rounded px-2 py-1.5 flex justify-between gap-2', entry.value > 0 ? 'bg-red-950/50 border border-red-500/20 text-red-400' : 'bg-surface-200 text-gray-600']">
          <span>{{ entry.label }}</span>
          <span class="font-bold">{{ entry.value }}</span>
        </div>
        <div v-if="scannerStore.debug._max !== undefined"
          class="rounded px-2 py-1.5 flex justify-between gap-2 bg-brand/10 border border-brand/20 text-brand-light">
          <span>max score</span>
          <span class="font-bold">{{ scannerStore.debug._max }}</span>
        </div>
      </div>
      <div class="mt-2 text-gray-700">aggiornato: {{ debugTimestamp }}</div>
    </details>

    <!-- Signal cards -->
    <div class="space-y-3">
      <TransitionGroup name="signal-list">
        <div
          v-for="sig in filteredSignals"
          :key="sig.id"
          :class="[
            'rounded-xl border p-4 cursor-pointer transition-shadow hover:shadow-lg',
            sig.direction === 'LONG' ? 'bg-profit/5 border-profit/20' : 'bg-loss/5 border-loss/20'
          ]"
          @click="openChart(sig)"
        >
          <!-- Row 1: direction + symbol + grade + time -->
          <div class="flex flex-wrap items-center gap-3 mb-3">
            <!-- Direction badge -->
            <span :class="[
              'text-sm font-bold px-3 py-1 rounded-lg',
              sig.direction === 'LONG'
                ? 'bg-profit text-black'
                : 'bg-loss text-white'
            ]">
              {{ sig.direction === 'LONG' ? '▲ LONG' : '▼ SHORT' }}
            </span>

            <!-- Symbol -->
            <span class="font-mono font-bold text-white text-lg">
              {{ sig.symbol.replace('/USDT:USDT', '') }}<span class="text-gray-500 text-sm">/USDT</span>
            </span>

            <!-- Grade badge -->
            <span :class="gradeBadgeClass(sig.grade)" class="font-bold px-2 py-0.5 rounded text-sm">
              {{ sig.grade }}
            </span>

            <!-- MTF badge -->
            <span v-if="sig.timeframeConfirm"
              class="text-xs px-2 py-0.5 rounded bg-brand/20 text-brand-light border border-brand/20 font-mono">
              MTF ✓
            </span>

            <span class="text-xs text-gray-600 font-mono ml-auto">{{ formatTime(sig.timestamp) }}</span>
          </div>

          <!-- Row 2: price levels -->
          <div class="grid grid-cols-4 gap-2 mb-3">
            <div class="bg-surface-200 rounded-lg p-2.5 text-center">
              <div class="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Entry</div>
              <div class="font-mono font-bold text-white text-sm">{{ formatPrice(sig.entry) }}</div>
            </div>
            <div class="bg-red-950/40 rounded-lg p-2.5 text-center border border-red-500/20">
              <div class="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">Stop Loss</div>
              <div class="font-mono font-bold text-loss text-sm">{{ formatPrice(sig.stopLoss) }}</div>
              <div class="text-[10px] text-red-400 mt-0.5">−{{ sig.slPct }}%</div>
            </div>
            <div class="bg-green-950/30 rounded-lg p-2.5 text-center border border-profit/20">
              <div class="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">TP1 (1:2)</div>
              <div class="font-mono font-bold text-profit text-sm">{{ formatPrice(sig.takeProfit1) }}</div>
              <div class="text-[10px] text-profit/70 mt-0.5">+{{ sig.tp1Pct }}%</div>
            </div>
            <div class="bg-green-950/20 rounded-lg p-2.5 text-center border border-profit/10">
              <div class="text-[10px] text-gray-500 mb-1 uppercase tracking-wider">TP2 (1:3)</div>
              <div class="font-mono font-bold text-profit/80 text-sm">{{ formatPrice(sig.takeProfit2) }}</div>
              <div class="text-[10px] text-profit/50 mt-0.5">+{{ sig.tp2Pct }}%</div>
            </div>
          </div>

          <!-- Mini chart 1m — lightweight-charts, dati già nel segnale -->
          <div v-if="sig.sparkline?.length"
               class="mb-3 rounded-lg overflow-hidden border border-white/10">
            <SparkChart
              :candles="sig.sparkline"
              :ema34="sig.ema34spark ?? []"
              :entry="sig.entry"
              :is-long="sig.direction === 'LONG'"
            />
          </div>

          <!-- Row 3: indicators + suggestion -->
          <div class="flex flex-wrap items-center gap-4 text-xs">
            <!-- Indicators -->
            <div class="flex gap-3 flex-wrap">
              <span class="font-mono text-gray-400">
                Vol <span class="text-orange-400 font-bold">×{{ sig.volumeRatio.toFixed(1) }}</span>
              </span>
              <span class="font-mono text-gray-400">
                5m <span :class="sig.priceChange5m >= 0 ? 'text-profit' : 'text-loss'" class="font-bold">
                  {{ sig.priceChange5m >= 0 ? '+' : '' }}{{ sig.priceChange5m.toFixed(2) }}%
                </span>
              </span>
              <span class="font-mono text-gray-400">
                15m <span :class="sig.priceChange15m >= 0 ? 'text-profit' : 'text-loss'" class="font-bold">
                  {{ sig.priceChange15m >= 0 ? '+' : '' }}{{ sig.priceChange15m.toFixed(2) }}%
                </span>
              </span>
              <span class="font-mono text-gray-400">
                RSI <span :class="rsiColor(sig.rsi5m)" class="font-bold">{{ sig.rsi5m.toFixed(0) }}</span>
              </span>
              <!-- Checkmarks -->
              <span :class="sig.emaConfirm ? 'text-profit' : 'text-gray-600'">EMA ✓</span>
              <span :class="sig.macdConfirm ? 'text-profit' : 'text-gray-600'">MACD ✓</span>
            </div>

            <!-- Score bar -->
            <div class="flex items-center gap-2 flex-1 min-w-[120px]">
              <span class="text-gray-500 shrink-0">Score</span>
              <div class="flex-1 h-1.5 rounded-full bg-surface-300 overflow-hidden">
                <div
                  class="h-full rounded-full transition-all"
                  :class="sig.direction === 'LONG' ? 'bg-profit' : 'bg-loss'"
                  :style="{ width: sig.score + '%' }"
                />
              </div>
              <span :class="sig.direction === 'LONG' ? 'text-profit' : 'text-loss'" class="font-mono font-bold shrink-0">
                {{ sig.score }}/100
              </span>
            </div>

            <!-- Leva suggerita -->
            <div class="text-gray-400 shrink-0">
              Leva suggerita:
              <span class="font-bold text-white">{{ sig.suggestedLeverage }}×</span>
            </div>

            <!-- Buttons -->
            <div class="flex items-center gap-2 shrink-0" @click.stop>
              <button
                @click="openChart(sig)"
                class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-surface-200 text-gray-300 border border-white/10 hover:text-white hover:border-white/30 transition-colors"
              >
                📈 Grafico
              </button>
              <a :href="sig.mexcUrl" target="_blank" rel="noopener"
                :class="[
                  'flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors',
                  sig.direction === 'LONG'
                    ? 'bg-profit text-black hover:bg-green-400'
                    : 'bg-loss text-white hover:bg-red-400'
                ]"
              >
                {{ sig.direction === 'LONG' ? '▲ MEXC' : '▼ MEXC' }}
                <i class="pi pi-external-link text-xs" />
              </a>
            </div>
          </div>

          <!-- Reasons (expandable) -->
          <details class="mt-2">
            <summary class="text-[11px] text-gray-600 cursor-pointer hover:text-gray-400">
              Perché questo segnale? ({{ sig.reasons.length }} condizioni)
            </summary>
            <ul class="mt-1.5 space-y-0.5">
              <li v-for="r in sig.reasons" :key="r" class="text-[11px] text-gray-400 flex items-center gap-1.5">
                <span class="text-profit">✓</span> {{ r }}
              </li>
            </ul>
          </details>
        </div>
      </TransitionGroup>

      <div v-if="!filteredSignals.length" class="stat-card text-center py-16">
        <div class="text-5xl mb-4">🔍</div>
        <p class="text-gray-400 font-semibold">Nessun segnale futures attivo</p>
        <p class="text-gray-600 text-sm mt-1">
          Il scanner analizza le coppie ogni 30 secondi.<br>
          I segnali appaiono solo quando volume + momentum + RSI + EMA + MACD si allineano.
        </p>
      </div>
    </div>

  </div>

  <!-- ── Chart Modal ──────────────────────────────────────────────────────── -->
  <Teleport to="body">
    <Transition name="modal-fade">
      <div
        v-if="selectedSignal"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm px-4 py-6"
        @click.self="selectedSignal = null"
      >
        <div class="relative w-full max-w-4xl bg-[#13131e] rounded-2xl border border-white/10 shadow-2xl flex flex-col">

          <!-- Modal header -->
          <div class="flex items-center justify-between px-5 py-4 border-b border-white/5 flex-wrap gap-3">
            <div class="flex items-center gap-3">
              <span
                :class="selectedSignal.direction === 'LONG' ? 'bg-profit text-black' : 'bg-loss text-white'"
                class="text-sm font-bold px-3 py-1 rounded-lg"
              >
                {{ selectedSignal.direction === 'LONG' ? '▲ LONG' : '▼ SHORT' }}
              </span>
              <span class="font-mono font-bold text-white text-lg">
                {{ selectedSignal.symbol.replace('/USDT:USDT', '') }}<span class="text-gray-500 text-sm">/USDT</span>
              </span>
              <span :class="gradeBadgeClass(selectedSignal.grade)" class="font-bold px-2 py-0.5 rounded text-sm">
                {{ selectedSignal.grade }}
              </span>
              <span class="text-xs text-gray-600 font-mono">{{ formatTime(selectedSignal.timestamp) }}</span>
            </div>
            <!-- Price levels inline -->
            <div class="flex items-center gap-4 text-xs font-mono flex-wrap">
              <span class="text-gray-400">
                Entry <span class="text-white font-bold">{{ formatPrice(selectedSignal.entry) }}</span>
              </span>
              <span>
                SL <span class="text-loss font-bold">{{ formatPrice(selectedSignal.stopLoss) }}</span>
                <span class="text-red-500 ml-1">−{{ selectedSignal.slPct }}%</span>
              </span>
              <span>
                TP1 <span class="text-profit font-bold">{{ formatPrice(selectedSignal.takeProfit1) }}</span>
                <span class="text-green-500 ml-1">+{{ selectedSignal.tp1Pct }}%</span>
              </span>
              <span>
                TP2 <span class="text-profit/70 font-bold">{{ formatPrice(selectedSignal.takeProfit2) }}</span>
                <span class="text-green-700 ml-1">+{{ selectedSignal.tp2Pct }}%</span>
              </span>
              <button @click="selectedSignal = null" class="text-gray-500 hover:text-white text-xl leading-none ml-2">✕</button>
            </div>
          </div>

          <!-- Legend strip -->
          <div class="flex items-center gap-5 px-5 pt-3 pb-1 text-xs font-mono">
            <span class="flex items-center gap-1.5"><span class="inline-block w-5 h-0.5 bg-[#94a3b8]" />Entry</span>
            <span class="flex items-center gap-1.5"><span class="inline-block w-5 h-0.5 bg-[#ef4444] border-dashed border-t-2 border-[#ef4444]" />SL</span>
            <span class="flex items-center gap-1.5"><span class="inline-block w-5 h-0.5 bg-[#22c55e] border-dashed border-t-2 border-[#22c55e]" />TP1</span>
            <span class="flex items-center gap-1.5"><span class="inline-block w-5 h-0.5 bg-[#16a34a] border-dashed border-t-2 border-[#16a34a]" />TP2</span>
            <span class="flex items-center gap-1.5 ml-2"><span class="inline-block w-5 h-0.5 bg-[#22d3ee]" />EMA34</span>
            <span class="flex items-center gap-1.5"><span class="inline-block w-5 h-0.5 bg-[#a78bfa]" />EMA9</span>
            <span class="flex items-center gap-1.5"><span class="inline-block w-5 h-0.5 bg-[#f59e0b]" />EMA21</span>
          </div>

          <!-- Chart -->
          <div class="px-4 pb-2">
            <PriceChart
              :symbol="selectedSignal.symbol"
              :timeframe="chartTimeframe"
              :height="370"
              :lines="chartLines"
              :show-ema34="true"
            />
          </div>

          <!-- Footer: timeframe + MEXC link -->
          <div class="flex items-center gap-2 px-5 pb-4">
            <span class="text-xs text-gray-500 mr-1">TF:</span>
            <button
              v-for="tf in ['1m', '5m', '15m', '1h']"
              :key="tf"
              @click="chartTimeframe = tf"
              :class="chartTimeframe === tf
                ? 'bg-brand/20 text-brand-light border-brand/30'
                : 'bg-surface-200 text-gray-400 border-white/5 hover:text-white'"
              class="px-3 py-1 text-xs rounded border transition-colors"
            >
              {{ tf }}
            </button>
            <a
              :href="selectedSignal.mexcUrl"
              target="_blank" rel="noopener"
              :class="selectedSignal.direction === 'LONG'
                ? 'bg-profit text-black hover:bg-green-400'
                : 'bg-loss text-white hover:bg-red-400'"
              class="ml-auto flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors"
            >
              {{ selectedSignal.direction === 'LONG' ? '▲ LONG su MEXC' : '▼ SHORT su MEXC' }}
              <i class="pi pi-external-link text-xs" />
            </a>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Button from 'primevue/button'
import Select from 'primevue/select'
import ToggleButton from 'primevue/togglebutton'
import { useScannerStore, type ScannerSignal } from '@/stores/scanner'
import { useSound, soundEnabled, armAudio } from '@/composables/useSound'
import PriceChart   from '@/components/PriceChart.vue'
import SparkChart   from '@/components/SparkChart.vue'

const scannerStore = useScannerStore()
const { playSignal } = useSound()

const audioArmed   = ref(false)
const filterGrade  = ref<string>('C')
const filterDir    = ref<string>('ALL')
const onlyMTF      = ref(false)

const selectedSignal  = ref<ScannerSignal | null>(null)
const chartTimeframe  = ref('1m')

const chartLines = computed(() => {
  const s = selectedSignal.value
  if (!s) return []
  return [
    { price: s.entry,       color: '#94a3b8', label: 'Entry' },
    { price: s.stopLoss,    color: '#ef4444', label: 'SL',  dashed: true },
    { price: s.takeProfit1, color: '#22c55e', label: 'TP1', dashed: true },
    { price: s.takeProfit2, color: '#16a34a', label: 'TP2', dashed: true },
  ]
})

function openChart(sig: ScannerSignal) {
  selectedSignal.value = sig
  chartTimeframe.value = '1m'
}

let debugTimer: ReturnType<typeof setInterval> | null = null

const gradeOptions = [
  { label: 'Tutti (C+)', value: 'C' },
  { label: 'B o superiore', value: 'B' },
  { label: 'A o superiore', value: 'A' },
  { label: 'Solo A+', value: 'A+' },
]
const dirOptions = [
  { label: 'Tutti', value: 'ALL' },
  { label: '▲ Solo LONG', value: 'LONG' },
  { label: '▼ Solo SHORT', value: 'SHORT' },
]

const gradeOrder: Record<string, number> = { 'C': 0, 'B': 1, 'A': 2, 'A+': 3 }

const { status } = scannerStore

const DEBUG_LABELS: Record<string, string> = {
  L0_error:     'API error',
  L0_no_data:   'no data',
  F1_lateral:   'F1 laterale EMA34',
  F1_flat:      'F1 EMA34 piatta',
  F2_far:       'F2 lontano EMA34',
  F2_no_touch:  'F2 wick non tocca EMA',
  F2_trig_far:  'F2 bounce già partito',
  F3_dir:       'F3 no conferma dir',
  F3_body:      'F3 doji/spinning top',
  SL_wide:      'SL troppo largo',
  SCORE:        'score < min',
}

const debugEntries = computed(() =>
  Object.entries(DEBUG_LABELS).map(([key, label]) => ({
    key,
    label,
    value: (scannerStore.debug[key] as number) ?? 0,
  })),
)

const debugTimestamp = computed(() =>
  scannerStore.debug.timestamp
    ? new Date(scannerStore.debug.timestamp as string).toLocaleTimeString('it-IT')
    : '—',
)

const lastScanFormatted = computed(() =>
  scannerStore.status.lastScanAt
    ? new Date(scannerStore.status.lastScanAt).toLocaleTimeString('it-IT')
    : '—',
)
const scannedPairs = computed(() => scannerStore.status.scannedPairs || '…')

const filteredSignals = computed(() =>
  scannerStore.signals.filter((s) => {
    if (filterDir.value !== 'ALL' && s.direction !== filterDir.value) return false
    if (gradeOrder[s.grade] < gradeOrder[filterGrade.value]) return false
    if (onlyMTF.value && !s.timeframeConfirm) return false
    return true
  }),
)

const longCount  = computed(() => scannerStore.signals.filter((s) => s.direction === 'LONG').length)
const shortCount = computed(() => scannerStore.signals.filter((s) => s.direction === 'SHORT').length)
const gradeACount = computed(() => scannerStore.signals.filter((s) => s.grade === 'A' || s.grade === 'A+').length)
const mtfCount   = computed(() => scannerStore.signals.filter((s) => s.timeframeConfirm).length)

function gradeBadgeClass(grade: string) {
  return {
    'A+': 'bg-yellow-400 text-black',
    'A':  'bg-yellow-400/70 text-black',
    'B':  'bg-blue-400/30 text-blue-300 border border-blue-400/30',
    'C':  'bg-gray-500/20 text-gray-400 border border-gray-500/20',
  }[grade] ?? 'bg-gray-500/20 text-gray-400'
}

function rsiColor(rsi: number) {
  if (rsi >= 70) return 'text-loss'
  if (rsi <= 30) return 'text-profit'
  return 'text-gray-300'
}

function formatPrice(p: number): string {
  if (p < 0.0001) return p.toExponential(3)
  if (p < 0.01)   return p.toFixed(6)
  if (p < 1)      return p.toFixed(4)
  if (p < 1000)   return p.toFixed(2)
  return p.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('it-IT')
}

function toggleSound() { soundEnabled.value = !soundEnabled.value }

function testSound() { activateAudio(); playSignal('PUMP') }

function activateAudio() { armAudio(); audioArmed.value = true }

onMounted(() => {
  scannerStore.fetchSignals()
  scannerStore.fetchStatus()
  scannerStore.fetchDebug()
  debugTimer = setInterval(() => scannerStore.fetchDebug(), 15_000)
})

onUnmounted(() => {
  if (debugTimer) clearInterval(debugTimer)
})
</script>

<style scoped>
.signal-list-enter-active { transition: all 0.35s ease; }
.signal-list-enter-from   { opacity: 0; transform: translateY(-10px) scale(0.99); }
.signal-list-leave-to     { opacity: 0; transform: translateX(40px); }

.modal-fade-enter-active,
.modal-fade-leave-active  { transition: opacity 0.2s ease; }
.modal-fade-enter-from,
.modal-fade-leave-to      { opacity: 0; }
</style>
