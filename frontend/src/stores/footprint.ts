import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'
import { io, Socket } from 'socket.io-client'

export const useFootprintStore = defineStore('footprint', () => {
  const analytics = ref<any>(null)
  const signals = ref<any[]>([])
  const positions = ref<Record<string, any>>({})
  const loading = ref(false)

  async function loadAnalytics() {
    loading.value = true
    try {
      const { data } = await axios.get('/api/footprint/analytics')
      analytics.value = data
      if (data.recentSignals) signals.value = data.recentSignals
    } finally {
      loading.value = false
    }
  }

  async function updateConfig(patch: Record<string, any>) {
    const { data } = await axios.patch('/api/footprint/config', patch)
    if (analytics.value) analytics.value.config = data
    return data
  }

  async function resetSim() {
    await axios.post('/api/footprint/reset')
    await loadAnalytics()
  }

  let sock: Socket | null = null
  function connect() {
    if (sock) return
    sock = io('/', { transports: ['websocket', 'polling'] })

    sock.on('footprint:signal', (sig: any) => {
      // Rimuovi segnale precedente per lo stesso simbolo+direzione, tieni solo il più recente
      signals.value = signals.value.filter(s => !(s.symbol === sig.symbol && s.direction === sig.direction))
      signals.value.unshift(sig)
      if (signals.value.length > 200) signals.value = signals.value.slice(0, 200)
    })

    sock.on('footprint:trade', () => { loadAnalytics() })

    sock.on('footprint:status', (s: any) => {
      if (analytics.value) analytics.value.scannerStatus = s
    })

    sock.on('footprint:positions', (pos: any[]) => {
      for (const p of pos) positions.value[p.id] = p
    })
  }

  function disconnect() { sock?.disconnect(); sock = null }

  return { analytics, signals, positions, loading, loadAnalytics, updateConfig, resetSim, connect, disconnect }
})
