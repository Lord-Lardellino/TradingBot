import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface Bot {
  id: number
  name: string
  strategy: string
  symbol: string
  timeframe: string
  status: string
  testMode: boolean
  config: string
  createdAt: string
  _count?: { trades: number; signals: number }
}

export const useBotStore = defineStore('bot', () => {
  const bots = ref<Bot[]>([])
  const loading = ref(false)
  const prices = ref<Record<string, { price: number; changePct: number }>>({})

  async function fetchAll() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/bots')
      bots.value = data
    } finally {
      loading.value = false
    }
  }

  async function create(payload: Partial<Bot>) {
    const { data } = await axios.post('/api/bots', payload)
    bots.value.unshift(data)
    return data
  }

  async function remove(id: number) {
    await axios.delete(`/api/bots/${id}`)
    bots.value = bots.value.filter((b) => b.id !== id)
  }

  async function start(id: number) {
    const { data } = await axios.post(`/api/bots/${id}/start`)
    updateStatus(id, data.status)
  }

  async function stop(id: number) {
    const { data } = await axios.post(`/api/bots/${id}/stop`)
    updateStatus(id, data.status)
  }

  function updateStatus(id: number, status: string) {
    const bot = bots.value.find((b) => b.id === id)
    if (bot) bot.status = status
  }

  function updatePrice(symbol: string, price: number, changePct: number) {
    prices.value[symbol] = { price, changePct }
  }

  async function getStats(id: number) {
    const { data } = await axios.get(`/api/bots/${id}/stats`)
    return data
  }

  return { bots, loading, prices, fetchAll, create, remove, start, stop, updateStatus, updatePrice, getStats }
})
