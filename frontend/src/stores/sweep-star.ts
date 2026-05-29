import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import axios from 'axios'

export interface SweepStarSignal {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  patternType: 1 | 2
  patternName: 'SWEEP_STAR_LONG' | 'SWEEP_STAR_SHORT'
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
  volumeRatio: number
  bodyRangeRatio: number
  closeWickRange: number
  oppositeWickRange: number
  sweepWickRange: number
  atrPct: number
  feeRate: number
  isZeroFee: boolean
  score: number
  grade: 'A+' | 'A' | 'B'
  reasons: string[]
  timestamp: string
  triggerTs: number
  mexcUrl: string
  sparkline: { t: number; o: number; h: number; l: number; c: number }[]
}

export interface SweepStarTrade {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  patternType: number
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

export interface SweepStarConfig {
  id: number
  startingCapital: number
  riskUsdt: number
  tpRr: number
  leverage: number
  maxConcurrent: number
  autoEnter: boolean
  liveEnabled: boolean
  minScore: number
  topPairs: number
  liquidityLookback: number
  minBodyRangeRatio: number
  maxCloseWickRange: number
  maxOppositeWickRange: number
  minSweepWickRange: number
  minConfirmBodyAtr: number
  minVolumeRatio: number
  minSlPct: number
  maxSlPct: number
  maxSpreadPct: number
  feeRate: number
}

export interface SweepStarAnalytics {
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
  config: SweepStarConfig
  recentSignals: SweepStarSignal[]
  scannerStatus: SweepStarStatus
}

export interface SweepStarStatus {
  lastScanAt: string | null
  scannedPairs: number
  lastRawSignals: number
  lastEmitted: number
  isScanning: boolean
  debug: Record<string, number>
  feeTableSymbols?: number
  zeroFeeSymbols?: number
}

export const useSweepStarStore = defineStore('sweep-star', () => {
  const analytics = ref<SweepStarAnalytics | null>(null)
  const trades = ref<SweepStarTrade[]>([])
  const signals = ref<SweepStarSignal[]>([])
  const loading = ref(false)
  const configLoading = ref(false)
  const positions = ref<Record<string, { currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }>>({})
  const status = ref<SweepStarStatus>({
    lastScanAt: null,
    scannedPairs: 0,
    lastRawSignals: 0,
    lastEmitted: 0,
    isScanning: false,
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
        axios.get('/api/sweep-star/analytics'),
        axios.get('/api/sweep-star/trades?limit=250'),
        axios.get('/api/sweep-star/signals?limit=100'),
        axios.get('/api/sweep-star/status'),
      ])
      analytics.value = analyticsRes.data
      trades.value = tradesRes.data
      signals.value = signalsRes.data
      status.value = statusRes.data
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(patch: Partial<SweepStarConfig>) {
    configLoading.value = true
    try {
      const { data } = await axios.patch('/api/sweep-star/config', patch)
      if (analytics.value) analytics.value.config = data
      return data
    } finally {
      configLoading.value = false
    }
  }

  async function resetSim() {
    await axios.post('/api/sweep-star/reset')
    analytics.value = null
    trades.value = []
    signals.value = []
    positions.value = {}
    await fetchAll()
  }

  function addLiveSignal(signal: SweepStarSignal) {
    signals.value.unshift(signal)
    if (signals.value.length > 100) signals.value.pop()
    if (analytics.value) {
      analytics.value.recentSignals.unshift(signal)
      if (analytics.value.recentSignals.length > 100) analytics.value.recentSignals.pop()
    }
  }

  function addLiveTrade(trade: SweepStarTrade) {
    const idx = trades.value.findIndex(t => t.id === trade.id)
    if (idx >= 0) trades.value[idx] = trade
    else trades.value.unshift(trade)
  }

  function updatePositions(data: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const p of data) positions.value[p.id] = p
  }

  function updateStatus(data: Partial<SweepStarStatus>) {
    status.value = { ...status.value, ...data }
  }

  return {
    analytics, trades, signals, status, positions, loading, configLoading,
    openTrades, closedTrades,
    fetchAll, updateConfig, resetSim, addLiveSignal, addLiveTrade, updatePositions, updateStatus,
  }
})
