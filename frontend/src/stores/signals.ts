import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface Signal {
  id: number
  botId: number
  symbol: string
  type: string
  price: number
  rsi?: number
  macd?: number
  ema9?: number
  ema21?: number
  volumeRatio?: number
  executed: boolean
  createdAt: string
  reason?: string
  bot?: { name: string; strategy: string }
}

export const useSignalsStore = defineStore('signals', () => {
  const signals = ref<Signal[]>([])
  const live = ref<Signal[]>([])   // last 20 live signals from WebSocket
  const loading = ref(false)

  async function fetchAll(botId?: number) {
    loading.value = true
    try {
      const params: any = { limit: 100 }
      if (botId) params.botId = botId
      const { data } = await axios.get('/api/signals', { params })
      signals.value = data
    } finally {
      loading.value = false
    }
  }

  function addLive(signal: Signal) {
    live.value.unshift(signal)
    if (live.value.length > 20) live.value.pop()
    // Also prepend to main list
    signals.value.unshift(signal)
  }

  return { signals, live, loading, fetchAll, addLive }
})
