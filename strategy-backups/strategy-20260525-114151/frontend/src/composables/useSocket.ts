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

    socket.on('inst:signal',   (data: any)   => { import('@/stores/inst-scanner').then(m => m.useInstScannerStore().addLiveSignal(data)) })
    socket.on('inst:trade',    (data: any)   => { import('@/stores/inst-scanner').then(m => m.useInstScannerStore().addLiveTrade(data)) })
    socket.on('inst:positions',(data: any[]) => { import('@/stores/inst-scanner').then(m => m.useInstScannerStore().updatePositions(data)) })
    socket.on('inst:status',   (data: any)   => { import('@/stores/inst-scanner').then(m => { Object.assign(m.useInstScannerStore().status, data) }) })

    socket.on('inst15m:signal',   (data: any)   => { import('@/stores/inst-scanner-15m').then(m => m.useInst15mStore().addLiveSignal(data)) })
    socket.on('inst15m:trade',    (data: any)   => { import('@/stores/inst-scanner-15m').then(m => m.useInst15mStore().addLiveTrade(data)) })
    socket.on('inst15m:positions',(data: any[]) => { import('@/stores/inst-scanner-15m').then(m => m.useInst15mStore().updatePositions(data)) })
    socket.on('inst15m:status',   (data: any)   => { import('@/stores/inst-scanner-15m').then(m => { Object.assign(m.useInst15mStore().status, data) }) })

    socket.on('inst1h:signal',   (data: any)   => { import('@/stores/inst-scanner-1h').then(m => m.useInst1hStore().addLiveSignal(data)) })
    socket.on('inst1h:trade',    (data: any)   => { import('@/stores/inst-scanner-1h').then(m => m.useInst1hStore().addLiveTrade(data)) })
    socket.on('inst1h:positions',(data: any[]) => { import('@/stores/inst-scanner-1h').then(m => m.useInst1hStore().updatePositions(data)) })
    socket.on('inst1h:status',   (data: any)   => { import('@/stores/inst-scanner-1h').then(m => { Object.assign(m.useInst1hStore().status, data) }) })
  }

  function disconnect() {
    socket?.disconnect()
  }

  onUnmounted(() => {
    // Keep the shared socket alive across navigation; only disconnect if explicitly called
  })

  return { connected, connect, disconnect }
}
