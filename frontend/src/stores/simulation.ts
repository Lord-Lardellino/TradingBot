import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface SimTrade {
  id: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  entry: number
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  leverage: number
  riskEur: number
  positionSize: number
  marginEur: number
  grade: string
  score: number
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
  // live fields populated by sim:positions events
  currentPrice?: number
  unrealizedPnl?: number
  unrealizedPnlPct?: number
}

export interface SimAnalytics {
  startingCapital: number
  currentCapital: number
  totalPnl: number
  totalPnlPct: number
  totalGrossPnl: number
  totalFeesPaid: number
  feeRatePct: number
  totalTrades: number
  openTrades: number
  wins: number
  losses: number
  winRate: number
  avgWinEur: number
  avgLossEur: number
  rrActual: number
  profitFactor: number
  maxDrawdownPct: number
  bestTrade: SimTrade | null
  worstTrade: SimTrade | null
  byGrade: Record<string, { trades: number; wins: number; pnl: number; winRate: number }>
  equityCurve: { date: string; capital: number }[]
  config: { startingCapital: number; marginPerTrade: number; targetTP: string; maxConcurrent: number; autoEnter: boolean }
}

export const useSimulationStore = defineStore('simulation', () => {
  const analytics = ref<SimAnalytics | null>(null)
  const trades = ref<SimTrade[]>([])
  const loading = ref(false)

  async function fetchAnalytics() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/simulation/analytics')
      analytics.value = data
    } finally {
      loading.value = false
    }
  }

  // Refresh silenzioso in-place — aggiorna i singoli campi senza sostituire l'oggetto
  // evitando che Vue ri-renderizzi l'intero template
  async function refreshAnalytics() {
    try {
      const { data } = await axios.get('/api/simulation/analytics')
      if (analytics.value) {
        Object.assign(analytics.value, data)
      } else {
        analytics.value = data
      }
    } catch { /* silenzioso */ }
  }

  async function fetchTrades() {
    const { data } = await axios.get('/api/simulation/trades?limit=200')
    trades.value = data
  }

  async function updateConfig(cfg: Partial<SimAnalytics['config']>) {
    await axios.put('/api/simulation/config', cfg)
    await fetchAnalytics()
  }

  async function reset() {
    await axios.post('/api/simulation/reset')
    trades.value = []
    analytics.value = null
    await fetchAnalytics()
  }

  async function closeManual(id: string) {
    await axios.post(`/api/simulation/close/${id}`)
    await Promise.all([fetchAnalytics(), fetchTrades()])
  }

  function addLiveTrade(trade: SimTrade) {
    const idx = trades.value.findIndex((t) => t.id === trade.id)
    if (idx >= 0) {
      // Aggiorna in-place: preserva i campi live e non sostituisce l'oggetto
      const t = trades.value[idx]
      Object.assign(t, trade)
      if (trade.currentPrice == null && t.currentPrice != null) t.currentPrice = t.currentPrice
      // Analytics: solo se il trade è stato chiuso (capitale cambiato)
      if (trade.status !== 'open') void refreshAnalytics()
    } else {
      trades.value.unshift(trade)
      // Trade appena aperto: incrementa solo il contatore senza full refresh
      if (analytics.value) analytics.value.openTrades++
    }
  }

  function updatePositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const pos of positions) {
      const idx = trades.value.findIndex((t) => t.id === pos.id)
      // Object.assign in-place: aggiorna solo i 3 campi live senza toccare il resto
      if (idx >= 0) Object.assign(trades.value[idx], pos)
    }
  }

  return { analytics, trades, loading, fetchAnalytics, refreshAnalytics, fetchTrades, updateConfig, reset, closeManual, addLiveTrade, updatePositions }
})
