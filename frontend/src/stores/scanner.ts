import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface ScannerSignal {
  id: string
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
  priceChange5m: number
  priceChange15m: number
  volumeRatio: number
  rsi5m: number
  rsi15m: number
  macdConfirm: boolean
  emaConfirm: boolean
  timeframeConfirm: boolean
  score: number
  grade: 'A+' | 'A' | 'B' | 'C'
  reasons: string[]
  quoteVolume24h: number
  timestamp: string
  mexcUrl: string
  sparkline?: { t: number; o: number; h: number; l: number; c: number }[]
  ema34spark?: number[]
}

export interface ScannerStatus {
  lastScanAt: string | null
  scannedPairs: number
  candidates: number
  rawSignals: number
  emitted: number
  totalSignals: number
  isScanning: boolean
}

export interface ScannerDebug {
  L1_no_sqz?: number
  L1_no_comp?: number
  L1_vol_hi?: number
  L2_no_brk?: number
  L2_dir?: number
  L2_body?: number
  L2_vol?: number
  L2_range?: number
  L2_chase?: number
  L3_rsi?: number
  L3_atr?: number
  SL_wide?: number
  TP_unreach?: number
  SCORE?: number
  _max?: number
  timestamp?: string
  [key: string]: number | string | undefined
}

export const useScannerStore = defineStore('scanner', () => {
  const signals = ref<ScannerSignal[]>([])
  const status  = ref<ScannerStatus>({ lastScanAt: null, scannedPairs: 0, candidates: 0, rawSignals: 0, emitted: 0, totalSignals: 0, isScanning: false })
  const debug   = ref<ScannerDebug>({})
  const loading = ref(false)

  async function fetchSignals() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/scanner/signals?limit=100')
      signals.value = data
    } finally {
      loading.value = false
    }
  }

  async function fetchStatus() {
    const { data } = await axios.get('/api/scanner/status')
    status.value = { ...status.value, ...data }
  }

  async function fetchDebug() {
    const { data } = await axios.get('/api/scanner/debug')
    debug.value = data
  }

  function addLive(signal: ScannerSignal) {
    // Deduplicate: remove older signal for same symbol
    signals.value = signals.value.filter((s) => s.symbol !== signal.symbol)
    signals.value.unshift(signal)
    if (signals.value.length > 200) signals.value.pop()
  }

  function updateStatus(s: Partial<ScannerStatus>) {
    status.value = { ...status.value, ...s }
  }

  return { signals, status, debug, loading, fetchSignals, fetchStatus, fetchDebug, addLive, updateStatus }
})
