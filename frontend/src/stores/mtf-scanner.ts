import { defineStore } from 'pinia'
import { ref, reactive } from 'vue'
import axios from 'axios'

export interface MtfSignal {
  id: string
  tf: string
  symbol: string
  direction: 'LONG' | 'SHORT'
  entry: number
  stopLoss: number
  takeProfit1: number
  takeProfit2: number
  slPct: number
  tp1Pct: number
  tp2Pct: number
  suggestedLeverage: number
  volumeRatio: number
  rsi: number
  macdConfirm: boolean
  score: number
  grade: 'A+' | 'A' | 'B' | 'C'
  reasons: string[]
  quoteVolume24h: number
  timestamp: string
  mexcUrl: string
  atr14Pct: number
  sparkline?: { t: number; o: number; h: number; l: number; c: number }[]
  ema34spark?: number[]
}

export interface MtfStatus {
  tf: string
  lastScanAt: string | null
  scannedPairs: number
  candidates: number
  rawSignals: number
  emitted: number
  isScanning: boolean
}

export interface MtfTrade {
  id: string
  tf: string
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
  status: string
  closePrice?: number
  pnl?: number
  fees: number
  capitalBefore: number
  capitalAfter?: number
  openedAt: string
  closedAt?: string
  currentPrice?: number
  unrealizedPnl?: number
  unrealizedPnlPct?: number
}

export interface MtfAnalytics {
  tf: string
  startingCapital: number
  currentCapital: number
  totalPnl: number
  totalPnlPct: number
  totalGrossPnl: number
  totalFeesPaid: number
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
  bestTrade: MtfTrade | null
  worstTrade: MtfTrade | null
  byGrade: Record<string, { trades: number; wins: number; pnl: number; winRate: number }>
  equityCurve: { date: string; capital: number }[]
  config: { startingCapital: number; marginPerTrade: number; maxConcurrent: number; autoEnter: boolean }
}

const TFS = ['5m', '15m', '1h'] as const
type Tf = typeof TFS[number]

export const useMtfScannerStore = defineStore('mtf-scanner', () => {
  const signals   = reactive<Record<Tf, MtfSignal[]>>({ '5m': [], '15m': [], '1h': [] })
  const status    = reactive<Record<Tf, MtfStatus>>({
    '5m':  { tf: '5m',  lastScanAt: null, scannedPairs: 0, candidates: 0, rawSignals: 0, emitted: 0, isScanning: false },
    '15m': { tf: '15m', lastScanAt: null, scannedPairs: 0, candidates: 0, rawSignals: 0, emitted: 0, isScanning: false },
    '1h':  { tf: '1h',  lastScanAt: null, scannedPairs: 0, candidates: 0, rawSignals: 0, emitted: 0, isScanning: false },
  })
  const analytics = reactive<Record<Tf, MtfAnalytics | null>>({ '5m': null, '15m': null, '1h': null })
  const trades    = reactive<Record<Tf, MtfTrade[]>>({ '5m': [], '15m': [], '1h': [] })
  const loading   = ref(false)

  async function fetchSignals(tf: Tf) {
    loading.value = true
    try {
      const { data } = await axios.get(`/api/mtf-scanner/signals?tf=${tf}&limit=100`)
      signals[tf] = data
    } finally {
      loading.value = false
    }
  }

  async function fetchStatus(tf: Tf) {
    const { data } = await axios.get(`/api/mtf-scanner/status?tf=${tf}`)
    Object.assign(status[tf], data)
  }

  async function fetchAnalytics(tf: Tf) {
    const { data } = await axios.get(`/api/mtf-scanner/analytics?tf=${tf}`)
    analytics[tf] = data
  }

  async function refreshAnalytics(tf: Tf) {
    try {
      const { data } = await axios.get(`/api/mtf-scanner/analytics?tf=${tf}`)
      if (analytics[tf]) {
        Object.assign(analytics[tf]!, data)
      } else {
        analytics[tf] = data
      }
    } catch { /* silenzioso */ }
  }

  async function fetchTrades(tf: Tf) {
    const [openRes, closedRes] = await Promise.all([
      axios.get(`/api/mtf-scanner/trades/open?tf=${tf}`),
      axios.get(`/api/mtf-scanner/trades/closed?tf=${tf}&limit=200`),
    ])
    const all: MtfTrade[] = [...openRes.data, ...closedRes.data]
    all.sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
    trades[tf] = all
  }

  async function updateConfig(tf: Tf, cfg: Partial<MtfAnalytics['config']>) {
    await axios.post(`/api/mtf-scanner/config?tf=${tf}`, cfg)
    await fetchAnalytics(tf)
  }

  async function reset(tf: Tf) {
    await axios.post(`/api/mtf-scanner/reset?tf=${tf}`)
    trades[tf] = []
    analytics[tf] = null
    await fetchAnalytics(tf)
  }

  async function closeManual(id: string, tf: Tf) {
    await axios.post(`/api/mtf-scanner/close/${id}`)
    await Promise.all([fetchAnalytics(tf), fetchTrades(tf)])
  }

  function addLive(signal: MtfSignal) {
    const tf = signal.tf as Tf
    if (!signals[tf]) return
    signals[tf] = signals[tf].filter((s) => s.symbol !== signal.symbol)
    signals[tf].unshift(signal)
    if (signals[tf].length > 200) signals[tf].pop()
  }

  function updateStatus(s: MtfStatus) {
    const tf = s.tf as Tf
    if (!status[tf]) return
    Object.assign(status[tf], s)
  }

  function addLiveTrade(trade: MtfTrade) {
    const tf = trade.tf as Tf
    if (!trades[tf]) return
    const idx = trades[tf].findIndex((t) => t.id === trade.id)
    if (idx >= 0) {
      const t = trades[tf][idx]
      Object.assign(t, trade)
      if (trade.status !== 'open') void refreshAnalytics(tf)
    } else {
      trades[tf].unshift(trade)
      if (analytics[tf]) analytics[tf]!.openTrades++
    }
  }

  function updatePositions(positions: { id: string; currentPrice: number; unrealizedPnl: number; unrealizedPnlPct: number }[]) {
    for (const pos of positions) {
      for (const tf of TFS) {
        const idx = trades[tf].findIndex((t) => t.id === pos.id)
        if (idx >= 0) { Object.assign(trades[tf][idx], pos); break }
      }
    }
  }

  return {
    signals, status, analytics, trades, loading,
    fetchSignals, fetchStatus, fetchAnalytics, refreshAnalytics, fetchTrades,
    updateConfig, reset, closeManual,
    addLive, updateStatus, addLiveTrade, updatePositions,
  }
})
