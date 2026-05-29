import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import { io, Socket } from 'socket.io-client'

export const useEma34ScannerStore = defineStore('ema34-scanner', () => {
  const analytics = ref<any>(null)
  const signals   = ref<any[]>([])
  const positions = ref<Record<string, any>>({})
  const loading   = ref(false)

  async function loadAnalytics() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/ema34-scanner/analytics')
      analytics.value = data
      if (data.recentSignals) signals.value = data.recentSignals
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(patch: Record<string, any>) {
    const { data } = await axios.patch('/api/ema34-scanner/config', patch)
    if (analytics.value) analytics.value.config = data
    return data
  }

  async function toggleLive() {
    const current = analytics.value?.config?.liveEnabled ?? false
    await updateConfig({ liveEnabled: !current })
  }

  async function resetSim() {
    await axios.post('/api/ema34-scanner/reset')
    await loadAnalytics()
  }

  let sock: Socket | null = null
  function connect() {
    if (sock) return
    sock = io('/', { transports: ['websocket', 'polling'] })

    sock.on('ema34:signal', (sig: any) => {
      signals.value = signals.value.filter(s => !(s.symbol === sig.symbol && s.direction === sig.direction))
      signals.value.unshift(sig)
      if (signals.value.length > 200) signals.value = signals.value.slice(0, 200)
    })

    sock.on('ema34:trade', () => { loadAnalytics() })

    sock.on('ema34:status', (s: any) => {
      if (analytics.value) analytics.value.scannerStatus = s
    })

    sock.on('ema34:positions', (pos: any[]) => {
      for (const p of pos) positions.value[p.id] = p
    })
  }

  function disconnect() { sock?.disconnect(); sock = null }

  return { analytics, signals, positions, loading, loadAnalytics, updateConfig, toggleLive, resetSim, connect, disconnect }
})
