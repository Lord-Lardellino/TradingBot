import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import axios from 'axios'

export interface SmartSignal {
  id: string; symbol: string; direction: 'LONG' | 'SHORT'
  patternType: 1 | 2 | 3 | 4; patternName: string
  entry: number; stopLoss: number; takeProfit: number
  slPct: number; tpPct: number; suggestedLeverage: number
  volumeRatio: number; rsi3: number; atrPct: number
  score: number; grade: 'A+' | 'A' | 'B' | 'C'
  reasons: string[]; timestamp: string; mexcUrl: string
  gemmaApproved?: boolean; gemmaReason?: string
}

export interface SmartTrade {
  id: string; symbol: string; direction: 'LONG' | 'SHORT'
  patternType: number; entry: number; stopLoss: number
  takeProfit1: number; takeProfit2: number; leverage: number
  riskEur: number; positionSize: number; marginEur: number
  grade: string; score: number; status: string
  closePrice?: number; pnl?: number; fees: number
  capitalBefore: number; capitalAfter?: number
  openedAt: string; closedAt?: string
  currentPrice?: number; unrealizedPnl?: number; unrealizedPnlPct?: number
}

export interface SmartOptLog {
  id: number; createdAt: string; tradesAnalyzed: number
  analysis: string; changes: string; reason: string; applied: boolean
}

export const useSmartScannerStore = defineStore('smart-scanner', () => {
  const signals   = ref<SmartSignal[]>([])
  const trades    = ref<SmartTrade[]>([])
  const optLogs   = ref<SmartOptLog[]>([])
  const analytics = ref<any>(null)
  const status    = reactive({ lastScanAt: null as string | null, scannedPairs: 0, candidates: 0, rawSignals: 0, emitted: 0, isScanning: false, config: {} as any })

  async function fetchSignals()   { const { data } = await axios.get('/api/smart-scanner/signals?limit=100'); signals.value = data }
  async function fetchStatus()    { const { data } = await axios.get('/api/smart-scanner/status'); Object.assign(status, data) }
  async function fetchAnalytics() { const { data } = await axios.get('/api/smart-scanner/analytics'); analytics.value = data }
  async function fetchOptLogs()   { const { data } = await axios.get('/api/smart-scanner/opt-logs'); optLogs.value = data }
  async function fetchTrades() {
    const [openRes, closedRes] = await Promise.all([
      axios.get('/api/smart-scanner/trades/open'),
      axios.get('/api/smart-scanner/trades/closed?limit=200'),
    ])
    const all: SmartTrade[] = [...openRes.data, ...closedRes.data]
    all.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
    trades.value = all
  }

  async function updateConfig(cfg: any)  { await axios.post('/api/smart-scanner/config', cfg); await fetchAnalytics() }
  async function reset()                 { await axios.post('/api/smart-scanner/reset'); trades.value = []; analytics.value = null; await fetchAnalytics() }
  async function triggerOptimize()       { await axios.post('/api/smart-scanner/optimize'); await fetchOptLogs() }
  async function toggleLive()            { await updateConfig({ liveEnabled: !analytics.value?.config?.liveEnabled }) }

  function addLiveSignal(sig: SmartSignal) {
    signals.value = signals.value.filter((s) => s.symbol !== sig.symbol)
    signals.value.unshift(sig)
    if (signals.value.length > 200) signals.value.pop()
  }
  function addLiveTrade(trade: SmartTrade) {
    const idx = trades.value.findIndex((t) => t.id === trade.id)
    if (idx >= 0) { Object.assign(trades.value[idx], trade); if (trade.status !== 'open') void fetchAnalytics() }
    else trades.value.unshift(trade)
  }
  function updatePositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const pos of positions) { const t = trades.value.find((t) => t.id === pos.id); if (t) Object.assign(t, pos) }
  }
  function addOptLog(log: SmartOptLog) {
    optLogs.value.unshift(log)
    if (optLogs.value.length > 20) optLogs.value.pop()
  }

  return { signals, trades, optLogs, analytics, status, fetchSignals, fetchStatus, fetchAnalytics, fetchOptLogs, fetchTrades, updateConfig, reset, triggerOptimize, toggleLive, addLiveSignal, addLiveTrade, updatePositions, addOptLog }
})
