import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import { io, Socket } from 'socket.io-client'

export const useEngulfingStore = defineStore('engulfing', () => {
  const analytics = ref<any>(null)
  const signals = ref<any[]>([])
  const positions = ref<Record<string, any>>({})
  const loading = ref(false)

  async function loadAnalytics() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/engulfing/analytics')
      analytics.value = data
      if (data.recentSignals) signals.value = data.recentSignals
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(patch: Record<string, any>) {
    const { data } = await axios.patch('/api/engulfing/config', patch)
    if (analytics.value) analytics.value.config = data
    return data
  }

  async function resetSim() {
    await axios.post('/api/engulfing/reset')
    await loadAnalytics()
  }

  let sock: Socket | null = null
  function connect() {
    if (sock) return
    sock = io('/', { transports: ['websocket', 'polling'] })

    sock.on('engulfing:signal', (sig: any) => {
      signals.value.unshift(sig)
      if (signals.value.length > 250) signals.value.pop()
    })

    sock.on('engulfing:trade', () => { loadAnalytics() })

    sock.on('engulfing:status', (s: any) => {
      if (analytics.value) analytics.value.scannerStatus = s
    })

    sock.on('engulfing:positions', (pos: any[]) => {
      for (const p of pos) positions.value[p.id] = p
    })
  }

  function disconnect() { sock?.disconnect(); sock = null }

  return { analytics, signals, positions, loading, loadAnalytics, updateConfig, resetSim, connect, disconnect }
})
