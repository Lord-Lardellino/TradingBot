import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface Trade {
  id: number
  botId: number
  symbol: string
  side: string
  quantity: number
  entryPrice: number
  exitPrice?: number
  total: number
  pnl?: number
  pnlPct?: number
  status: string
  openedAt: string
  closedAt?: string
  bot?: { name: string; strategy: string }
  event?: string
}

export const useTradesStore = defineStore('trades', () => {
  const trades = ref<Trade[]>([])
  const summary = ref({ totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, openTrades: 0 })
  const loading = ref(false)

  async function fetchAll(botId?: number, status?: string) {
    loading.value = true
    try {
      const params: any = { limit: 100 }
      if (botId) params.botId = botId
      if (status) params.status = status
      const { data } = await axios.get('/api/trades', { params })
      trades.value = data
    } finally {
      loading.value = false
    }
  }

  async function fetchSummary() {
    const { data } = await axios.get('/api/trades/summary')
    summary.value = data
  }

  function addLive(trade: Trade) {
    const idx = trades.value.findIndex((t) => t.id === trade.id)
    if (idx >= 0) {
      trades.value[idx] = trade
    } else {
      trades.value.unshift(trade)
    }
    fetchSummary()
  }

  return { trades, summary, loading, fetchAll, fetchSummary, addLive }
})
