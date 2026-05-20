import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'
import { useBotStore } from '@/stores/bot'
import { useTradesStore } from '@/stores/trades'
import { useSignalsStore } from '@/stores/signals'
import { useLiveStore } from '@/stores/live'

let socket: Socket | null = null

export function useSocket() {
  const connected = ref(false)

  function connect() {
    if (socket?.connected) return

    socket = io('/', { transports: ['websocket', 'polling'] })

    socket.on('connect', () => {
      connected.value = true
      console.log('[Socket] connected:', socket?.id)
    })

    socket.on('disconnect', () => {
      connected.value = false
      console.log('[Socket] disconnected')
    })

    socket.on('price', (data: { symbol: string; price: number; changePct: number }) => {
      useBotStore().updatePrice(data.symbol, data.price, data.changePct)
    })

    socket.on('signal', (data: any) => {
      useSignalsStore().addLive(data)
    })

    socket.on('trade', (data: any) => {
      useTradesStore().addLive(data)
    })

    socket.on('bot:status', (data: { botId: number; status: string }) => {
      useBotStore().updateStatus(data.botId, data.status)
    })

    socket.on('live:update', (data: { account: any; positions: any[] }) => {
      useLiveStore().setFromSocket(data)
    })

    socket.on('live:trade', (data: any) => {
      useLiveStore().addLiveTrade(data)
    })

    socket.on('smart:config',   (data: any)   => { import('@/stores/smart-scanner').then(m => {
      const store = m.useSmartScannerStore()
      if (store.analytics?.config) Object.assign(store.analytics.config, data)
    }) })
    socket.on('smart:signal',   (data: any)   => { import('@/stores/smart-scanner').then(m => m.useSmartScannerStore().addLiveSignal(data)) })
    socket.on('smart:trade',    (data: any)   => { import('@/stores/smart-scanner').then(m => m.useSmartScannerStore().addLiveTrade(data)) })
    socket.on('smart:positions',(data: any[]) => { import('@/stores/smart-scanner').then(m => m.useSmartScannerStore().updatePositions(data)) })
    socket.on('smart:status',   (data: any)   => { import('@/stores/smart-scanner').then(m => { Object.assign(m.useSmartScannerStore().status, data) }) })
    socket.on('smart:opt-log',  (data: any)   => { import('@/stores/smart-scanner').then(m => m.useSmartScannerStore().addOptLog(data)) })
  }

  function disconnect() {
    socket?.disconnect()
  }

  onUnmounted(() => {
    // Keep the shared socket alive across navigation; only disconnect if explicitly called
  })

  return { connected, connect, disconnect }
}
