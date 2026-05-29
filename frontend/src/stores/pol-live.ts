import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import axios from 'axios'

export interface PolConfig {
  id: number
  enabled: boolean
  liveEnabled: boolean
  symbol: string
  riskUsdt: number
  tpRr: number
  leverage: number
  maxConcurrent: number
  minBodyRangeRatio: number
  maxCloseWickRange: number
  maxOppositeWickRange: number
  minRangeAtr: number
  minSlPct: number
  maxSlPct: number
  maxSpreadPct: number
  breakoutLookback: number
}

export interface PolSignal {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  signalType: 'BASE_BREAKOUT' | 'IMPULSE_CLOSE'
  entry: number
  stopLoss: number
  takeProfit: number
  slPct: number
  tpPct: number
  riskUsdt: number
  rewardUsdt: number
  positionSize: number
  marginUsdt: number
  leverage: number
  spreadPct: number
  bodyRangeRatio: number
  closeWickRange: number
  oppositeWickRange: number
  rangeAtr: number
  baseRangePct: number
  score: number
  grade: 'A+' | 'A' | 'B'
  reasons: string[]
  timestamp: string
  candleCloseAgeMs: number
  mexcUrl: string
}

export interface PolTrade {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  entry: number
  stopLoss: number
  takeProfit: number
  leverage: number
  marginEur: number
  positionSize: number
  contracts: number
  grade: string
  score: number
  status: string
  closePrice: number | null
  pnl: number | null
  feesOpen: number | null
  feesClose: number | null
  openedAt: string
  closedAt: string | null
  note: string | null
}

export interface PolStatus {
  source: string
  symbol: string
  timeframe: string
  lastScanAt: string | null
  lastSignalAt: string | null
  isScanning: boolean
  lastError: string | null
  market: null | {
    last: number
    bid: number
    ask: number
    spreadPct: number
    amount24: number
    fundingRate: number
    ts: number
  }
  debug: Record<string, number>
  config: PolConfig
}

export interface PolAnalytics {
  totalTrades: number
  openTrades: number
  closedTrades: number
  wins: number
  losses: number
  winRate: number | null
  totalPnl: number
  totalFees: number
  avgWin: number
  avgLoss: number
  rrActual: number | null
}

export const usePolLiveStore = defineStore('pol-live', () => {
  const status = ref<PolStatus | null>(null)
  const analytics = ref<PolAnalytics | null>(null)
  const signals = ref<PolSignal[]>([])
  const trades = ref<PolTrade[]>([])
  const loading = ref(false)
  const configLoading = ref(false)

  const config = computed(() => status.value?.config ?? null)
  const openTrades = computed(() => trades.value.filter(t => ['open', 'pending'].includes(t.status)))

  async function fetchAll() {
    loading.value = true
    try {
      const [statusRes, analyticsRes, signalsRes, tradesRes] = await Promise.all([
        axios.get('/api/pol-live/status'),
        axios.get('/api/pol-live/analytics'),
        axios.get('/api/pol-live/signals?limit=100'),
        axios.get('/api/pol-live/trades?limit=100'),
      ])
      status.value = statusRes.data
      analytics.value = analyticsRes.data
      signals.value = signalsRes.data
      trades.value = tradesRes.data
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(patch: Partial<PolConfig>) {
    configLoading.value = true
    try {
      const { data } = await axios.patch('/api/pol-live/config', patch)
      if (status.value) status.value.config = data
      return data
    } finally {
      configLoading.value = false
    }
  }

  return {
    status, analytics, signals, trades, loading, configLoading, config, openTrades,
    fetchAll, updateConfig,
  }
})
