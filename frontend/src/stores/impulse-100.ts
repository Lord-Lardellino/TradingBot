import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import axios from 'axios'

export interface Impulse100Signal {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  patternName:
    | 'CONTINUATION_PULLBACK_LONG'
    | 'CONTINUATION_PULLBACK_SHORT'
    | 'FAILED_MOVE_REVERSAL_LONG'
    | 'FAILED_MOVE_REVERSAL_SHORT'
  entry: number
  stopLoss: number
  takeProfit1: number
  slPct: number
  tpPct: number
  suggestedLeverage: number
  riskUsdt: number
  rewardUsdt: number
  positionSize: number
  marginUsdt: number
  spreadPct: number
  volume24h: number
  volumeRatio: number
  bodyRangeRatio: number
  closeWickRange: number
  oppositeWickRange: number
  rangeAtr: number
  breakStrengthPct: number
  feeRate: number
  isZeroFee: boolean
  score: number
  grade: 'A+' | 'A' | 'B'
  reasons: string[]
  timestamp: string
  triggerTs: number
  candleCloseAgeMs: number
  mexcUrl: string
}

export interface Impulse100Trade {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  patternName: string
  entry: number
  stopLoss: number
  takeProfit1: number
  leverage: number
  riskEur: number
  positionSize: number
  marginEur: number
  grade: string
  score: number
  status: 'open' | 'tp1' | 'sl' | 'manual'
  closePrice: number | null
  pnl: number | null
  feeRate: number
  fees: number
  capitalBefore: number
  capitalAfter: number | null
  openedAt: string
  closedAt: string | null
}

export interface Impulse100Config {
  id: number
  startingCapital: number
  riskUsdt: number
  tpRr: number
  leverage: number
  maxConcurrent: number
  maxSignalsPerScan: number
  enabled: boolean
  autoEnter: boolean
  liveEnabled: boolean
  minScore: number
  topPairs: number
  breakLookback: number
  minBodyRangeRatio: number
  maxCloseWickRange: number
  maxOppositeWickRange: number
  minRangeAtr: number
  maxRangeAtr: number
  minSlPct: number
  maxSlPct: number
  maxSpreadPct: number
  minVolume24h: number
  cooldownMinutes: number
  feeRate: number
}

export interface Impulse100Status {
  lastScanAt: string | null
  scannedPairs: number
  lastRawSignals: number
  lastEmitted: number
  isScanning: boolean
  lastError: string | null
  debug: Record<string, number>
  feeTableSymbols?: number
  zeroFeeSymbols?: number
}

export interface Impulse100Analytics {
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
  capital: number
  byPattern: Record<string, { tp: number; sl: number }>
  config: Impulse100Config
  recentSignals: Impulse100Signal[]
  scannerStatus: Impulse100Status
}

export const useImpulse100Store = defineStore('impulse-100', () => {
  const analytics = ref<Impulse100Analytics | null>(null)
  const trades = ref<Impulse100Trade[]>([])
  const signals = ref<Impulse100Signal[]>([])
  const loading = ref(false)
  const configLoading = ref(false)
  const positions = ref<Record<string, { currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }>>({})
  const status = ref<Impulse100Status>({
    lastScanAt: null,
    scannedPairs: 0,
    lastRawSignals: 0,
    lastEmitted: 0,
    isScanning: false,
    lastError: null,
    debug: {},
    feeTableSymbols: 0,
    zeroFeeSymbols: 0,
  })

  const openTrades = computed(() => trades.value.filter(t => t.status === 'open'))
  const closedTrades = computed(() => trades.value.filter(t => t.status !== 'open'))

  async function fetchAll() {
    loading.value = true
    try {
      const [analyticsRes, tradesRes, signalsRes, statusRes] = await Promise.all([
        axios.get('/api/impulse-100/analytics'),
        axios.get('/api/impulse-100/trades?limit=250'),
        axios.get('/api/impulse-100/signals?limit=100'),
        axios.get('/api/impulse-100/status'),
      ])
      analytics.value = analyticsRes.data
      trades.value = tradesRes.data
      signals.value = signalsRes.data
      status.value = statusRes.data
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(patch: Partial<Impulse100Config>) {
    configLoading.value = true
    try {
      const { data } = await axios.patch('/api/impulse-100/config', patch)
      if (analytics.value) analytics.value.config = data
      return data
    } finally {
      configLoading.value = false
    }
  }

  async function resetSim() {
    await axios.post('/api/impulse-100/reset')
    analytics.value = null
    trades.value = []
    signals.value = []
    positions.value = {}
    await fetchAll()
  }

  function addLiveSignal(signal: Impulse100Signal) {
    signals.value.unshift(signal)
    if (signals.value.length > 100) signals.value.pop()
    if (analytics.value) {
      analytics.value.recentSignals.unshift(signal)
      if (analytics.value.recentSignals.length > 100) analytics.value.recentSignals.pop()
    }
  }

  function addLiveTrade(trade: Impulse100Trade) {
    const idx = trades.value.findIndex(t => t.id === trade.id)
    if (idx >= 0) trades.value[idx] = trade
    else trades.value.unshift(trade)
  }

  function updatePositions(data: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const p of data) positions.value[p.id] = p
  }

  function updateStatus(data: Partial<Impulse100Status>) {
    status.value = { ...status.value, ...data }
  }

  return {
    analytics, trades, signals, status, positions, loading, configLoading,
    openTrades, closedTrades,
    fetchAll, updateConfig, resetSim, addLiveSignal, addLiveTrade, updatePositions, updateStatus,
  }
})
