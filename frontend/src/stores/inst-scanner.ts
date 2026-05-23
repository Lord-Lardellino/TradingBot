import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export interface InstSignal {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  patternType: number
  patternName: string
  entry: number
  stopLoss: number
  takeProfit1: number
  slPct: number
  tpPct: number
  suggestedLeverage: number
  volumeRatio: number
  rsi14: number
  atrPct: number
  score: number
  grade: 'A+' | 'A' | 'B'
  reasons: string[]
  timestamp: string
  mexcUrl: string
  sparkline: { t: number; o: number; h: number; l: number; c: number }[]
}

export interface InstTrade {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  patternType: number
  patternName: string
  entry: number
  stopLoss: number
  takeProfit1: number
  leverage: number
  marginEur: number
  positionSize: number
  grade: string
  score: number
  status: 'open' | 'tp1' | 'sl' | 'manual'
  closePrice: number | null
  pnl: number | null
  fees: number
  capitalBefore: number
  capitalAfter: number | null
  openedAt: string
  closedAt: string | null
}

export interface InstConfig {
  id: number
  startingCapital: number
  maxConcurrent: number
  autoEnter: boolean
  minScore: number
  atrSlMult: number
  tpRr: number
  liveEnabled: boolean
}

export interface InstAnalytics {
  totalTrades: number
  openTrades: number
  closedTrades: number
  tp1Count: number
  slCount: number
  totalPnl: number
  totalFees: number
  winRate: number | null
  capital: number
  byPattern: Record<string, { tp: number; sl: number }>
  config: InstConfig
  recentSignals: InstSignal[]
  scannerStatus: {
    lastScanAt: string | null
    scannedPairs: number
    lastRawSignals: number
    lastEmitted: number
    isScanning: boolean
  }
}

export const useInstScannerStore = defineStore('inst-scanner', () => {
  const analytics  = ref<InstAnalytics | null>(null)
  const trades     = ref<InstTrade[]>([])
  const loading    = ref(false)
  const positions  = ref<Record<string, { currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }>>({})

  const status = ref({
    lastScanAt: null as string | null,
    scannedPairs: 0, lastRawSignals: 0, lastEmitted: 0, isScanning: false,
    candidates: 0, debug: {} as Record<string, number>,
    config: { minScore: 50, atrSlMult: 0.5, tpRr: 3.0 },
  })

  const openTrades   = computed(() => trades.value.filter(t => t.status === 'open'))
  const closedTrades = computed(() => trades.value.filter(t => t.status !== 'open'))

  async function fetchAnalytics() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/inst-scanner/analytics')
      analytics.value = data
      trades.value    = data.recentSignals ? trades.value : trades.value
    } finally { loading.value = false }
  }

  async function fetchTrades(limit = 200) {
    const { data } = await axios.get(`/api/inst-scanner/trades?limit=${limit}`)
    trades.value = data
  }

  async function updateConfig(patch: Partial<InstConfig>) {
    const { data } = await axios.patch('/api/inst-scanner/config', patch)
    if (analytics.value) analytics.value.config = data
    return data
  }

  async function resetSim() {
    await axios.post('/api/inst-scanner/reset')
    analytics.value = null
    trades.value    = []
    await fetchAnalytics()
  }

  function addLiveSignal(sig: InstSignal) {
    if (!analytics.value) return
    analytics.value.recentSignals.unshift(sig)
    if (analytics.value.recentSignals.length > 200) analytics.value.recentSignals.pop()
  }

  function addLiveTrade(trade: InstTrade) {
    const idx = trades.value.findIndex(t => t.id === trade.id)
    if (idx >= 0) trades.value[idx] = trade
    else trades.value.unshift(trade)
    if (analytics.value) {
      analytics.value.totalTrades = trades.value.length
      analytics.value.openTrades  = trades.value.filter(t => t.status === 'open').length
    }
  }

  function updatePositions(data: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const p of data) {
      positions.value[p.id] = { currentPrice: p.currentPrice, unrealizedPnl: p.unrealizedPnl, unrealizedPnlPct: p.unrealizedPnlPct }
    }
  }

  return {
    analytics, trades, loading, positions, status,
    openTrades, closedTrades,
    fetchAnalytics, fetchTrades, updateConfig, resetSim,
    addLiveSignal, addLiveTrade, updatePositions,
  }
})
