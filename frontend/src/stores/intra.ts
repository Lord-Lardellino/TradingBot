import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export interface IntraTrade {
  id: string
  symbol: string
  direction: 'LONG'
  entry: number
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  takeProfit3: number
  leverage: number
  slPct: number
  marginEur: number
  positionSize: number
  riskEur: number
  grade: string
  score: number
  pumpPct: number
  distToEma34: number
  targetTP: string
  status: string
  closePrice?: number
  pnl?: number
  pnlCapPct?: number
  fees: number
  capitalBefore: number
  capitalAfter?: number
  openedAt: string
  closedAt?: string
  // live fields
  currentPrice?: number
  unrealizedPnl?: number
  unrealizedPnlPct?: number
}

export interface IntraSignal {
  id: string
  symbol: string
  direction: 'LONG'
  entry: number
  pumpCandle4hPct: number
  distToEma34: number
  trigBodyRatio: number
  trigVolRatio: number
  ema34_4h: number
  score: number
  grade: 'A+' | 'A' | 'B' | 'C'
  quoteVolume24h: number
  timestamp: string
  mexcUrl: string
}

export const useIntraStore = defineStore('intra', () => {
  const signals   = ref<IntraSignal[]>([])
  const trades    = ref<IntraTrade[]>([])
  const analytics = ref<any | null>(null)
  const cfg       = ref<any | null>(null)
  const status    = ref<any>({ isScanning: false, lastScanAt: null, signalCount: 0 })
  const loading   = ref(false)

  const openTrades   = computed(() => trades.value.filter((t) => t.status === 'open'))
  const closedTrades = computed(() => trades.value.filter((t) => t.status !== 'open'))

  async function fetchAll() {
    loading.value = true
    try {
      const [sigs, trds, an, config, st] = await Promise.all([
        axios.get('/api/intra/signals?limit=100').then((r) => r.data),
        axios.get('/api/intra/trades?limit=200').then((r) => r.data),
        axios.get('/api/intra/analytics').then((r) => r.data),
        axios.get('/api/intra/config').then((r) => r.data),
        axios.get('/api/intra/status').then((r) => r.data),
      ])
      signals.value   = sigs
      trades.value    = trds
      analytics.value = an
      cfg.value       = config
      status.value    = st
    } finally {
      loading.value = false
    }
  }

  async function refreshAnalytics() {
    try {
      const { data } = await axios.get('/api/intra/analytics')
      if (analytics.value) Object.assign(analytics.value, data)
      else analytics.value = data
    } catch { /* silent */ }
  }

  async function updateConfig(data: any) {
    await axios.put('/api/intra/config', data)
    cfg.value = { ...cfg.value, ...data }
  }

  async function reset() {
    await axios.post('/api/intra/reset')
    trades.value    = []
    analytics.value = null
    await fetchAll()
  }

  async function closeManual(id: string) {
    await axios.post(`/api/intra/close/${id}`)
    await Promise.all([refreshAnalytics(), axios.get('/api/intra/trades?limit=200').then((r) => { trades.value = r.data })])
  }

  function addLiveSignal(sig: IntraSignal) {
    signals.value = signals.value.filter((s) => s.symbol !== sig.symbol)
    signals.value.unshift(sig)
    if (signals.value.length > 100) signals.value.pop()
  }

  function addLiveTrade(trade: IntraTrade) {
    const idx = trades.value.findIndex((t) => t.id === trade.id)
    if (idx >= 0) {
      Object.assign(trades.value[idx], trade)
      if (trade.status !== 'open') void refreshAnalytics()
    } else {
      trades.value.unshift(trade)
      if (analytics.value) analytics.value.openTrades++
    }
  }

  function updatePositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const pos of positions) {
      const idx = trades.value.findIndex((t) => t.id === pos.id)
      if (idx >= 0) Object.assign(trades.value[idx], pos)
    }
  }

  return {
    signals, trades, analytics, cfg, status, loading,
    openTrades, closedTrades,
    fetchAll, refreshAnalytics, updateConfig, reset, closeManual,
    addLiveSignal, addLiveTrade, updatePositions,
  }
})
