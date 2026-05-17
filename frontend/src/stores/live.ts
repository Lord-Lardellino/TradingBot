import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import axios from 'axios'

export interface LiveAccount {
  connected: boolean
  error?: string
  totalBalance: number
  availableBalance: number
  usedMargin: number
  unrealizedPnl: number
  equity: number
  marginRatio: number
  currency: string
}

export interface LivePosition {
  symbol: string
  side: 'long' | 'short'
  contracts: number
  notional: number
  entryPrice: number
  markPrice: number
  liquidationPrice: number
  leverage: number
  unrealizedPnl: number
  unrealizedPnlPct: number
  collateral: number
  initialMarginPct: number
}

export interface LiveOrder {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  type: string
  amount: number
  price: number
  filled: number
  remaining: number
  status: string
  timestamp: number
  reduceOnly: boolean
}

export interface LiveTrade {
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
  orderId: string
  grade: string
  score: number
  status: 'open' | 'tp' | 'sl' | 'manual' | 'error'
  closePrice: number | null
  pnl: number | null
  feesOpen: number
  feesClose: number | null
  openedAt: string
  closedAt: string | null
  note: string | null
}

export interface LiveTradingConfig {
  enabled: boolean
  autoClose: boolean
  marginPerTrade: number
  minGrade: string
  maxConcurrent: number
}

export interface LiveTradingAnalytics {
  totalTrades: number
  tradesWithPnl: number
  openTrades: number
  totalPnl: number | null
  totalFees: number
  winRate: number | null
  avgFeeOpen: number
  avgFeeClose: number | null
  feeRatePct: number | null
}

export const useLiveStore = defineStore('live', () => {
  const account    = ref<LiveAccount | null>(null)
  const positions  = ref<LivePosition[]>([])
  const orders     = ref<LiveOrder[]>([])
  const loading    = ref(false)
  const lastUpdate = ref<Date | null>(null)

  const trades    = ref<LiveTrade[]>([])
  const config    = ref<LiveTradingConfig | null>(null)
  const analytics = ref<LiveTradingAnalytics | null>(null)
  const configLoading = ref(false)

  const totalUnrealizedPnl = computed(() =>
    positions.value.reduce((s, p) => s + p.unrealizedPnl, 0),
  )

  const openTrades  = computed(() => trades.value.filter(t => t.status === 'open'))
  const closedTrades = computed(() => trades.value.filter(t => t.status !== 'open'))

  async function fetchAll() {
    loading.value = true
    try {
      const [accRes, posRes, ordRes, tradesRes, cfgRes, anaRes] = await Promise.all([
        axios.get('/api/live/account'),
        axios.get('/api/live/positions'),
        axios.get('/api/live/orders'),
        axios.get('/api/live/trades'),
        axios.get('/api/live/config'),
        axios.get('/api/live/analytics'),
      ])
      account.value    = accRes.data
      positions.value  = posRes.data
      orders.value     = ordRes.data
      trades.value     = tradesRes.data
      config.value     = cfgRes.data
      analytics.value  = anaRes.data
      lastUpdate.value = new Date()
    } finally {
      loading.value = false
    }
  }

  async function fetchAccount() {
    const { data } = await axios.get('/api/live/account')
    account.value = data
    lastUpdate.value = new Date()
  }

  async function fetchPositions() {
    const { data } = await axios.get('/api/live/positions')
    positions.value = data
  }

  async function updateConfig(patch: Partial<LiveTradingConfig>) {
    configLoading.value = true
    try {
      const { data } = await axios.put('/api/live/config', patch)
      config.value = data
    } finally {
      configLoading.value = false
    }
  }

  async function closeTrade(id: string) {
    await axios.post(`/api/live/close/${id}`)
    const t = trades.value.find(x => x.id === id)
    if (t) t.status = 'manual'
  }

  function addLiveTrade(trade: LiveTrade) {
    const idx = trades.value.findIndex(t => t.id === trade.id)
    if (idx >= 0) trades.value[idx] = trade
    else trades.value.unshift(trade)
  }

  function setFromSocket(data: { account: LiveAccount; positions: LivePosition[] }) {
    account.value   = data.account
    positions.value = data.positions
    lastUpdate.value = new Date()
  }

  return {
    account, positions, orders, loading, lastUpdate, totalUnrealizedPnl,
    trades, config, analytics, configLoading, openTrades, closedTrades,
    fetchAll, fetchAccount, fetchPositions, updateConfig, closeTrade, addLiveTrade, setFromSocket,
  }
})
