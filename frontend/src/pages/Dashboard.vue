<template>
  <div class="p-3 sm:p-6 space-y-4 sm:space-y-6">

    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-white">Dashboard</h1>
        <p class="text-sm text-gray-500 mt-0.5">Smart Scanner · Live Trading overview</p>
      </div>
      <div class="flex items-center gap-3">
        <div v-if="smartStore.analytics?.config?.liveEnabled"
          class="text-[10px] font-mono px-2 py-1 rounded-full bg-red-500/20 text-red-400 border border-red-500/30 animate-pulse">
          🔴 LIVE ON
        </div>
        <div class="text-xs text-gray-600 font-mono">{{ now }}</div>
      </div>
    </div>

    <!-- Smart Scanner stats -->
    <div>
      <div class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Smart AI Scanner</div>
      <div class="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Win Rate</div>
          <div class="text-2xl font-bold" :class="(smartStore.analytics?.winRate ?? 0) >= 50 ? 'text-profit' : 'text-loss'">
            {{ smartStore.analytics?.winRate ?? '—' }}%
          </div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">P&L Sim</div>
          <div class="text-2xl font-bold font-mono" :class="(smartStore.analytics?.totalPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'">
            {{ (smartStore.analytics?.totalPnl ?? 0) >= 0 ? '+' : '' }}€{{ (smartStore.analytics?.totalPnl ?? 0).toFixed(2) }}
          </div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Trade Chiusi</div>
          <div class="text-2xl font-bold text-white">{{ smartStore.analytics?.totalTrades ?? '—' }}</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Aperti</div>
          <div class="text-2xl font-bold text-brand">{{ smartStore.analytics?.openTrades ?? '—' }}</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Profit Factor</div>
          <div class="text-2xl font-bold text-white">{{ smartStore.analytics?.profitFactor ?? '—' }}</div>
        </div>
      </div>
    </div>

    <!-- Live Trading stats -->
    <div>
      <div class="text-xs font-semibold text-gray-500 uppercase tracking-widest mb-2">Live Trading</div>
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Equity</div>
          <div class="text-2xl font-bold text-white">
            {{ liveStore.account?.equity != null ? '$' + liveStore.account.equity.toFixed(2) : '—' }}
          </div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">PnL Non Real.</div>
          <div class="text-2xl font-bold font-mono" :class="totalUnrealized >= 0 ? 'text-profit' : 'text-loss'">
            {{ totalUnrealized >= 0 ? '+' : '' }}${{ totalUnrealized.toFixed(2) }}
          </div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Posizioni Aperte</div>
          <div class="text-2xl font-bold text-brand">{{ liveStore.positions?.length ?? 0 }}</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Trade Live</div>
          <div class="text-2xl font-bold text-white">{{ liveStore.trades?.length ?? 0 }}</div>
        </div>
      </div>
    </div>

    <!-- Recent smart signals + price chart -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-4">
      <div class="stat-card lg:col-span-2">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-semibold text-white">Price Chart</span>
          <div class="flex gap-2">
            <Select v-model="selectedSymbol" :options="popularPairs" size="small" class="text-xs" />
            <Select v-model="selectedTf" :options="timeframes" size="small" class="text-xs" />
          </div>
        </div>
        <PriceChart :symbol="selectedSymbol" :timeframe="selectedTf" :height="280" />
      </div>

      <!-- Ultimi segnali Smart Scanner -->
      <div class="stat-card overflow-hidden">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-semibold text-white">Ultimi Segnali AI</span>
          <RouterLink to="/smart" class="text-xs text-brand hover:underline">Vedi tutti</RouterLink>
        </div>
        <div v-if="!smartStore.signals.length" class="text-xs text-gray-600 text-center py-8">Nessun segnale</div>
        <div v-else class="space-y-1.5 overflow-y-auto max-h-64">
          <div v-for="sig in smartStore.signals.slice(0, 15)" :key="sig.id"
            class="flex items-center gap-2 text-xs py-1 border-b border-white/5">
            <span :class="['font-bold px-1.5 py-0.5 rounded text-[10px]', sig.direction === 'LONG' ? 'bg-profit/20 text-profit' : 'bg-loss/20 text-loss']">{{ sig.direction }}</span>
            <span class="text-white font-mono">{{ sig.symbol.replace('/USDT:USDT', '') }}</span>
            <span :class="['ml-auto text-[10px] font-bold', sig.gemmaApproved ? 'text-profit' : sig.gemmaApproved === false ? 'text-loss' : 'text-gray-500']">
              {{ sig.gemmaApproved ? '✅' : sig.gemmaApproved === false ? '❌' : '⏳' }}
            </span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Select from 'primevue/select'
import PriceChart from '@/components/PriceChart.vue'
import { useSmartScannerStore } from '@/stores/smart-scanner'
import { useLiveStore } from '@/stores/live'

const smartStore = useSmartScannerStore()
const liveStore  = useLiveStore()

const selectedSymbol = ref('BTC/USDT')
const selectedTf = ref('1m')
const popularPairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT']
const timeframes = ['1m', '3m', '5m', '15m', '1h']
const now = ref('')

const totalUnrealized = computed(() =>
  (liveStore.positions ?? []).reduce((s: number, p: any) => s + (p.unrealizedPnl ?? 0), 0)
)

let ticker: ReturnType<typeof setInterval>

onMounted(() => {
  smartStore.fetchAnalytics()
  smartStore.fetchSignals()
  ticker = setInterval(() => {
    now.value = new Date().toLocaleTimeString('it-IT')
    smartStore.fetchAnalytics()
  }, 30_000)
  now.value = new Date().toLocaleTimeString('it-IT')
})

onUnmounted(() => clearInterval(ticker))
</script>
