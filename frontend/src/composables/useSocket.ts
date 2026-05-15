import { io, Socket } from 'socket.io-client'
import { ref, onUnmounted } from 'vue'
import { useBotStore } from '@/stores/bot'
import { useTradesStore } from '@/stores/trades'
import { useSignalsStore } from '@/stores/signals'
import { useScannerStore } from '@/stores/scanner'
import { useSimulationStore } from '@/stores/simulation'
import { useLiveStore } from '@/stores/live'
import { useIntraStore } from '@/stores/intra'
import { useSound } from '@/composables/useSound'

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

    socket.on('scanner:signal', (data: any) => {
      useScannerStore().addLive(data)
      const { playSignal } = useSound()
      playSignal(data.direction === 'LONG' ? 'PUMP' : 'DUMP')
    })

    socket.on('scanner:status', (data: any) => {
      useScannerStore().updateStatus(data)
    })

    socket.on('sim:trade', (data: any) => {
      useSimulationStore().addLiveTrade(data)
    })

    socket.on('sim:positions', (data: any[]) => {
      useSimulationStore().updatePositions(data)
    })

    socket.on('live:update', (data: { account: any; positions: any[] }) => {
      useLiveStore().setFromSocket(data)
    })

    socket.on('live:trade', (data: any) => {
      useLiveStore().addLiveTrade(data)
    })

    socket.on('intra:signal', (data: any) => {
      useIntraStore().addLiveSignal(data)
    })

    socket.on('intra:trade', (data: any) => {
      useIntraStore().addLiveTrade(data)
    })

    socket.on('intra:positions', (data: any[]) => {
      useIntraStore().updatePositions(data)
    })
  }

  function disconnect() {
    socket?.disconnect()
  }

  onUnmounted(() => {
    // Keep the shared socket alive across navigation; only disconnect if explicitly called
  })

  return { connected, connect, disconnect }
}
