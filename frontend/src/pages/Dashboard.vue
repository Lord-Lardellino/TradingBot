<template>
  <div class="p-6 space-y-6">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-white">Dashboard</h1>
        <p class="text-sm text-gray-500 mt-0.5">Live overview of all bots and performance</p>
      </div>
      <div class="text-xs text-gray-600 font-mono">{{ now }}</div>
    </div>

    <!-- Stat cards -->
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <div class="stat-card">
        <div class="text-xs text-gray-500 mb-1">Running Bots</div>
        <div class="text-2xl font-bold text-white">{{ dashSummary?.bots?.running ?? '—' }}</div>
        <div class="text-xs text-gray-600">of {{ dashSummary?.bots?.total ?? 0 }} total</div>
      </div>
      <div class="stat-card">
        <div class="text-xs text-gray-500 mb-1">Total PnL</div>
        <div
          class="text-2xl font-bold font-mono"
          :class="(dashSummary?.trades?.totalPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'"
        >
          {{ (dashSummary?.trades?.totalPnl ?? 0) >= 0 ? '+' : '' }}${{ dashSummary?.trades?.totalPnl?.toFixed(2) ?? '0.00' }}
        </div>
        <div class="text-xs text-gray-600">{{ dashSummary?.trades?.totalTrades ?? 0 }} closed trades</div>
      </div>
      <div class="stat-card">
        <div class="text-xs text-gray-500 mb-1">Win Rate</div>
        <div
          class="text-2xl font-bold"
          :class="(dashSummary?.trades?.winRate ?? 0) >= 50 ? 'text-profit' : 'text-loss'"
        >
          {{ dashSummary?.trades?.winRate?.toFixed(1) ?? '—' }}%
        </div>
        <div class="text-xs text-gray-600">
          {{ dashSummary?.trades?.wins ?? 0 }}W / {{ dashSummary?.trades?.losses ?? 0 }}L
        </div>
      </div>
      <div class="stat-card">
        <div class="text-xs text-gray-500 mb-1">Signals Today</div>
        <div class="text-2xl font-bold text-white">{{ dashSummary?.signalsToday ?? '—' }}</div>
        <div class="text-xs text-gray-600">{{ dashSummary?.trades?.openTrades ?? 0 }} open positions</div>
      </div>
    </div>

    <!-- Chart + live signals -->
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <!-- Price chart -->
      <div class="stat-card lg:col-span-2">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-sm font-semibold text-white">Price Chart</span>
          </div>
          <div class="flex gap-2">
            <Select
              v-model="selectedSymbol"
              :options="popularPairs"
              size="small"
              class="text-xs"
            />
            <Select
              v-model="selectedTf"
              :options="timeframes"
              size="small"
              class="text-xs"
            />
          </div>
        </div>
        <PriceChart :symbol="selectedSymbol" :timeframe="selectedTf" :height="300" />
      </div>

      <!-- Live signals -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-semibold text-white">Live Signals</span>
          <span class="text-xs text-gray-600">{{ signalsStore.live.length }} recent</span>
        </div>
        <SignalsList :signals="signalsStore.live" />
      </div>
    </div>

    <!-- Recent trades -->
    <div class="stat-card">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-semibold text-white">Recent Trades</span>
        <RouterLink to="/trades" class="text-xs text-brand-light hover:underline">View all</RouterLink>
      </div>
      <TradeTable :trades="tradesStore.trades.slice(0, 10)" :loading="tradesStore.loading" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import Select from 'primevue/select'
import PriceChart from '@/components/PriceChart.vue'
import SignalsList from '@/components/SignalsList.vue'
import TradeTable from '@/components/TradeTable.vue'
import { useSignalsStore } from '@/stores/signals'
import { useTradesStore } from '@/stores/trades'

const signalsStore = useSignalsStore()
const tradesStore = useTradesStore()

const dashSummary = ref<any>(null)
const selectedSymbol = ref('BTC/USDT')
const selectedTf = ref('1m')
const popularPairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT']
const timeframes = ['1m', '3m', '5m', '15m', '1h']
const now = ref('')

let ticker: ReturnType<typeof setInterval>

async function load() {
  const { data } = await axios.get('/api/dashboard')
  dashSummary.value = data
}

onMounted(() => {
  load()
  signalsStore.fetchAll()
  tradesStore.fetchAll()
  tradesStore.fetchSummary()
  ticker = setInterval(() => {
    now.value = new Date().toLocaleTimeString('it-IT')
    load()
  }, 30_000)
  now.value = new Date().toLocaleTimeString('it-IT')
})

onUnmounted(() => clearInterval(ticker))
</script>
