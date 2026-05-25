<template>
  <ConfirmDialog />
  <div class="p-3 sm:p-6 space-y-4">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
          Inst1h Scanner
          <span class="text-xs font-normal text-gray-500">Liquidity Sweep · FVG · BOS — 1h istituzionale</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          {{ analytics?.scannerStatus.scannedPairs ?? 0 }} coppie ·
          {{ analytics?.scannerStatus.lastRawSignals ?? 0 }} segnali ciclo ·
          scan ogni ora · batch paralleli
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[10px] font-mono px-2 py-1 rounded-full bg-surface-200 text-gray-400">
          minScore: {{ analytics?.config?.minScore ?? 55 }}
        </span>
        <span class="text-[10px] font-mono px-2 py-1 rounded-full bg-surface-200 text-gray-400">
          RR: 1:{{ analytics?.config?.tpRr ?? 1.5 }}
        </span>
        <span :class="['text-[10px] font-mono px-2 py-1 rounded-full', status.isScanning ? 'bg-amber-500/20 text-amber-400 animate-pulse' : 'bg-surface-200 text-gray-500']">
          {{ status.isScanning ? '⚡ Scan...' : '● Idle' }}
        </span>
        <Button size="small" icon="pi pi-refresh" label="Aggiorna" severity="secondary" :loading="loading" @click="refresh" />
        <Button size="small" icon="pi pi-trash" label="Reset" severity="danger" outlined @click="confirmReset" />
      </div>
    </div>

    <!-- ── Stats ──────────────────────────────────────────────────────────── -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">Win Rate</div>
        <div class="text-2xl font-bold font-mono" :class="(analytics?.winRate ?? 0) >= 50 ? 'text-green-400' : 'text-red-400'">
          {{ analytics?.winRate !== null ? `${analytics!.winRate}%` : '—' }}
        </div>
        <div class="text-xs text-gray-600 mt-0.5">{{ analytics?.tp1Count ?? 0 }}W / {{ analytics?.slCount ?? 0 }}L</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">P&L Totale</div>
        <div class="text-2xl font-bold font-mono" :class="(analytics?.totalPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
          {{ analytics?.totalPnl !== undefined ? `${analytics!.totalPnl >= 0 ? '+' : ''}€${analytics!.totalPnl.toFixed(2)}` : '—' }}
        </div>
        <div class="text-xs text-gray-600 mt-0.5">fee: -€{{ analytics?.totalFees?.toFixed(2) ?? '0.00' }}</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">Totale Trade</div>
        <div class="text-2xl font-bold font-mono text-white">{{ analytics?.totalTrades ?? 0 }}</div>
        <div class="text-xs text-gray-600 mt-0.5">{{ analytics?.openTrades ?? 0 }} aperti</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500 mb-1">Capitale Sim</div>
        <div class="text-xl font-bold font-mono text-amber-400">€{{ analytics?.capital?.toFixed(2) ?? '500.00' }}</div>
        <div class="text-xs text-gray-600 mt-0.5">start €500</div>
      </div>
    </div>

    <!-- ── Tabs ───────────────────────────────────────────────────────────── -->
    <div class="flex border-b border-white/5 gap-1">
      <button v-for="tab in tabs" :key="tab.id"
        @click="activeTab = tab.id"
        :class="['px-4 py-2 text-sm font-medium transition-colors rounded-t-lg', activeTab === tab.id ? 'text-white bg-surface-200 border border-white/10 border-b-surface-200' : 'text-gray-500 hover:text-gray-300']"
      >
        {{ tab.label }}
        <span v-if="tab.badge" class="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400">{{ tab.badge }}</span>
      </button>
    </div>

    <!-- ── TAB: Segnali ───────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'signals'">
      <div v-if="!recentSignals.length" class="flex flex-col items-center justify-center py-20 text-gray-600">
        <i class="pi pi-chart-line text-4xl mb-3" />
        <p class="text-sm">Nessun segnale — scanner in attesa del prossimo ciclo (1h)</p>
      </div>
      <div v-else class="space-y-2">
        <div v-for="sig in recentSignals.slice(0, 30)" :key="sig.id"
          class="stat-card flex flex-wrap items-center gap-3 !py-3"
        >
          <div :class="['w-14 text-center text-xs font-bold py-1 rounded-lg', sig.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400']">
            {{ sig.direction }}
          </div>
          <div class="flex-1 min-w-0">
            <a :href="sig.mexcUrl" target="_blank" class="font-semibold text-white text-sm hover:text-amber-400 transition-colors">
              {{ sig.symbol.replace('/USDT:USDT', '') }}
            </a>
            <div class="text-xs text-gray-500 font-mono mt-0.5">
              {{ patternLabel(sig.patternName) }} · {{ sig.reasons.slice(1).join(' · ') }}
            </div>
          </div>
          <div class="text-xs font-mono text-right hidden sm:block">
            <div class="text-gray-400">Entry <span class="text-white">{{ sig.entry.toPrecision(5) }}</span></div>
            <div class="text-red-400">SL -{{ sig.slPct.toFixed(2) }}%</div>
            <div class="text-green-400">TP +{{ sig.tpPct.toFixed(2) }}%</div>
          </div>
          <div class="text-right">
            <div :class="['text-xs font-bold px-2 py-1 rounded-full', gradeClass(sig.grade)]">{{ sig.grade }}</div>
            <div class="text-xs text-gray-500 mt-0.5 font-mono">{{ sig.score }}pt</div>
          </div>
          <div class="text-right text-xs font-mono hidden md:block">
            <div class="text-gray-500">RSI <span class="text-white">{{ sig.rsi14 }}</span></div>
            <div class="text-gray-500">Vol <span class="text-amber-300">×{{ sig.volumeRatio }}</span></div>
          </div>
          <div class="text-sm font-mono text-gray-600 hidden lg:block">{{ sparkline(sig) }}</div>
          <div class="text-xs text-gray-600 font-mono whitespace-nowrap">{{ timeAgo(sig.timestamp) }}</div>
        </div>
      </div>
    </div>

    <!-- ── TAB: Simulazione ───────────────────────────────────────────────── -->
    <div v-if="activeTab === 'sim'">
      <div v-if="!trades.length" class="flex flex-col items-center justify-center py-20 text-gray-600">
        <i class="pi pi-inbox text-4xl mb-3" />
        <p class="text-sm">Nessun trade simulato ancora</p>
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left py-2 px-3">Symbol</th>
              <th class="text-left py-2 px-3">Pattern</th>
              <th class="text-left py-2 px-3">Dir</th>
              <th class="text-right py-2 px-3">Entry</th>
              <th class="text-right py-2 px-3">SL%</th>
              <th class="text-right py-2 px-3">TP%</th>
              <th class="text-right py-2 px-3">PnL</th>
              <th class="text-center py-2 px-3">Status</th>
              <th class="text-right py-2 px-3">Aperto</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in sortedTrades" :key="t.id"
              class="border-b border-white/5 hover:bg-surface-200 transition-colors"
            >
              <td class="py-2 px-3 text-white font-semibold">{{ t.symbol.replace('/USDT:USDT','') }}</td>
              <td class="py-2 px-3">
                <span :class="['px-1.5 py-0.5 rounded text-[10px]', patternBadgeClass(t.patternName)]">
                  {{ patternLabel(t.patternName ?? '') }}
                </span>
              </td>
              <td class="py-2 px-3" :class="t.direction === 'LONG' ? 'text-green-400' : 'text-red-400'">{{ t.direction }}</td>
              <td class="py-2 px-3 text-right text-gray-300">{{ t.entry.toPrecision(5) }}</td>
              <td class="py-2 px-3 text-right text-red-400">-{{ ((Math.abs(t.entry - t.stopLoss) / t.entry) * 100).toFixed(2) }}%</td>
              <td class="py-2 px-3 text-right text-green-400">+{{ ((Math.abs(t.takeProfit1 - t.entry) / t.entry) * 100).toFixed(2) }}%</td>
              <td class="py-2 px-3 text-right" :class="(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
                <template v-if="t.pnl !== null">{{ t.pnl >= 0 ? '+' : '' }}€{{ t.pnl.toFixed(3) }}</template>
                <template v-else>
                  <span class="text-gray-500">{{ livePnl(t) }}</span>
                </template>
              </td>
              <td class="py-2 px-3 text-center">
                <span :class="['px-2 py-0.5 rounded-full text-[10px] font-semibold', statusClass(t.status)]">
                  {{ t.status.toUpperCase() }}
                </span>
              </td>
              <td class="py-2 px-3 text-right text-gray-500">{{ timeAgo(t.openedAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── TAB: Config ────────────────────────────────────────────────────── -->
    <div v-if="activeTab === 'config'" class="stat-card space-y-5">
      <h3 class="text-sm font-semibold text-white">Configurazione Scanner 1h</h3>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div>
          <div class="text-xs text-gray-500 mb-1.5">Score minimo</div>
          <InputNumber v-model="draft.minScore" :min="20" :max="90" :step="1" :disabled="saving" size="small" fluid />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1.5">ATR SL Mult</div>
          <InputNumber v-model="draft.atrSlMult" :min="0.1" :max="3.0" :step="0.1" :minFractionDigits="1" :maxFractionDigits="1" :disabled="saving" size="small" fluid />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1.5">TP Risk/Reward</div>
          <InputNumber v-model="draft.tpRr" :min="1.0" :max="8.0" :step="0.5" :minFractionDigits="1" :maxFractionDigits="1" :disabled="saving" size="small" fluid />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1.5">Max trade concurrent</div>
          <InputNumber v-model="draft.maxConcurrent" :min="1" :max="10" :step="1" :disabled="saving" size="small" fluid />
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1.5">Auto-enter simulazione</div>
          <div class="flex items-center gap-2 h-[30px]">
            <ToggleSwitch v-model="draft.autoEnter" :disabled="saving" />
            <span class="text-xs text-gray-400">{{ draft.autoEnter ? 'Sì' : 'No' }}</span>
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-500 mb-1.5">Live trading</div>
          <div class="flex items-center gap-2 h-[30px]">
            <ToggleSwitch v-model="draft.liveEnabled" :disabled="saving" @update:model-value="v => saveConfig({ liveEnabled: v })" />
            <span :class="['text-xs font-semibold', draft.liveEnabled ? 'text-red-400' : 'text-gray-400']">
              {{ draft.liveEnabled ? '🔴 LIVE ON' : 'LIVE OFF' }}
            </span>
          </div>
          <p v-if="draft.liveEnabled" class="text-[10px] text-red-400 mt-1">Ordini reali su MEXC!</p>
        </div>
      </div>
      <div class="flex justify-end">
        <Button size="small" icon="pi pi-check" label="Salva" severity="secondary" :loading="saving" @click="saveConfig(draft)" />
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useInst1hStore } from '@/stores/inst-scanner-1h'
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import ToggleSwitch from 'primevue/toggleswitch'
import { useConfirm } from 'primevue/useconfirm'
import ConfirmDialog from 'primevue/confirmdialog'

const store   = useInst1hStore()
const confirm = useConfirm()

const loading       = computed(() => store.loading)
const analytics     = computed(() => store.analytics)
const trades        = computed(() => store.trades)
const status        = computed(() => store.status)
const recentSignals = computed(() => analytics.value?.recentSignals ?? [])
const sortedTrades  = computed(() => [...trades.value].sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()))

const activeTab = ref('signals')
const saving    = ref(false)

const tabs = computed(() => [
  { id: 'signals', label: 'Segnali', badge: recentSignals.value.length || null },
  { id: 'sim',     label: 'Simulazione', badge: trades.value.length || null },
  { id: 'config',  label: 'Config' },
])

const draft = ref({ minScore: 55, atrSlMult: 0.5, tpRr: 1.5, maxConcurrent: 2, autoEnter: true, liveEnabled: false })
watch(analytics, (a) => {
  if (!a?.config) return
  draft.value = { ...draft.value, ...a.config }
}, { immediate: true })

async function refresh() { await store.fetchAnalytics(); await store.fetchTrades() }

async function saveConfig(patch: any) {
  saving.value = true
  try { await store.updateConfig(patch) } finally { saving.value = false }
}

async function confirmReset() {
  confirm.require({
    message: 'Cancella tutti i trade simulati e azzera il capitale?',
    header: 'Conferma Reset',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Annulla', severity: 'secondary', outlined: true },
    acceptProps: { label: 'Reset', severity: 'danger' },
    accept: () => store.resetSim(),
  })
}

function gradeClass(g: string) {
  return g === 'A+' ? 'bg-yellow-500/20 text-yellow-400' : g === 'A' ? 'bg-green-500/20 text-green-400' : 'bg-surface-200 text-gray-400'
}

function patternLabel(name: string) {
  return name === 'LIQ_SWEEP' ? '🎯 LiqSweep' : name === 'FVG_FILL' ? '⚡ FVG' : name === 'BOS_RETEST' ? '📐 BOS' : name
}

function patternBadgeClass(name: string) {
  return name === 'LIQ_SWEEP' ? 'bg-indigo-500/20 text-indigo-400' : name === 'FVG_FILL' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-green-500/20 text-green-400'
}

function statusClass(s: string) {
  return s === 'open' ? 'bg-blue-500/20 text-blue-400' : s === 'tp1' ? 'bg-green-500/20 text-green-400' : s === 'sl' ? 'bg-red-500/20 text-red-400' : 'bg-surface-200 text-gray-500'
}

function sparkline(sig: any): string {
  const bars = sig.sparkline?.slice(-20) ?? []
  if (!bars.length) return ''
  const closes = bars.map((b: any) => b.c)
  const min = Math.min(...closes), max = Math.max(...closes)
  const range = max - min || 1
  const BLOCKS = ['▁','▂','▃','▄','▅','▆','▇','█']
  return closes.map((p: number) => BLOCKS[Math.round((p - min) / range * 7)]).join('')
}

function livePnl(t: any): string {
  const pos = store.positions[t.id]
  if (!pos) return 'open'
  return `${pos.unrealizedPnl >= 0 ? '+' : ''}€${pos.unrealizedPnl.toFixed(3)}`
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'ora'
  if (m < 60) return `${m}m fa`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h fa`
  return `${Math.floor(h / 24)}g fa`
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  await refresh()
  timer = setInterval(refresh, 120_000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>
