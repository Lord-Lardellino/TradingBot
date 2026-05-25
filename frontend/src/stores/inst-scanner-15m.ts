import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export interface Inst15mSignal {
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

export interface Inst15mTrade {
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

export interface Inst15mConfig {
  id: number
  startingCapital: number
  maxConcurrent: number
  autoEnter: boolean
  minScore: number
  atrSlMult: number
  tpRr: number
  liveEnabled: boolean
}

export interface Inst15mAnalytics {
  totalTrades: number
  openTrades: number
  closedTrades: number
  tp1Count: number
  slCount: number
  totalPnl: number
  totalFees: number
  winRate: number | null
  capital: number
  config: Inst15mConfig
  recentSignals: Inst15mSignal[]
  scannerStatus: {
    lastScanAt: string | null
    scannedPairs: number
    lastRawSignals: number
    lastEmitted: number
    isScanning: boolean
  }
}

export const useInst15mStore = defineStore('inst-scanner-15m', () => {
  const analytics = ref<Inst15mAnalytics | null>(null)
  const trades    = ref<Inst15mTrade[]>([])
  const loading   = ref(false)
  const positions = ref<Record<string, { currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }>>({})
  const status = ref({ lastScanAt: null as string | null, scannedPairs: 0, lastRawSignals: 0, lastEmitted: 0, isScanning: false })

  const openTrades   = computed(() => trades.value.filter(t => t.status === 'open'))
  const closedTrades = computed(() => trades.value.filter(t => t.status !== 'open'))

  async function fetchAnalytics() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/inst-scanner-15m/analytics')
      analytics.value = data
    } finally { loading.value = false }
  }

  async function fetchTrades(limit = 200) {
    const { data } = await axios.get(`/api/inst-scanner-15m/trades?limit=${limit}`)
    trades.value = data
  }

  async function updateConfig(patch: Partial<Inst15mConfig>) {
    const { data } = await axios.patch('/api/inst-scanner-15m/config', patch)
    if (analytics.value) analytics.value.config = data
    return data
  }

  async function resetSim() {
    await axios.post('/api/inst-scanner-15m/reset')
    analytics.value = null
    trades.value = []
    await fetchAnalytics()
  }

  function addLiveSignal(sig: Inst15mSignal) {
    if (!analytics.value) return
    analytics.value.recentSignals.unshift(sig)
    if (analytics.value.recentSignals.length > 200) analytics.value.recentSignals.pop()
  }

  function addLiveTrade(trade: Inst15mTrade) {
    const idx = trades.value.findIndex(t => t.id === trade.id)
    if (idx >= 0) trades.value[idx] = trade
    else trades.value.unshift(trade)
    if (analytics.value) {
      analytics.value.totalTrades = trades.value.length
      analytics.value.openTrades  = trades.value.filter(t => t.status === 'open').length
    }
  }

  function updatePositions(data: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const p of data) positions.value[p.id] = { currentPrice: p.currentPrice, unrealizedPnl: p.unrealizedPnl, unrealizedPnlPct: p.unrealizedPnlPct }
  }

  return {
    analytics, trades, loading, positions, status,
    openTrades, closedTrades,
    fetchAnalytics, fetchTrades, updateConfig, resetSim,
    addLiveSignal, addLiveTrade, updatePositions,
  }
})
