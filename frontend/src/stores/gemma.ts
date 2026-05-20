import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface GemmaMessage {
  role: 'user' | 'model'
  text: string
  ts: string
  imagePreview?: string
}

export interface GemmaContext {
  openPositions?: { symbol: string; direction: string; entry: number; pnl?: number; grade?: string; scanner?: string }[]
  recentSignals?: { symbol: string; direction: string; pattern?: string; score?: number; grade?: string; scanner?: string }[]
  liveEnabled?: boolean
  livePositionCount?: number
}

export const useGemmaStore = defineStore('gemma', () => {
  const messages = ref<GemmaMessage[]>([])
  const isOpen   = ref(false)
  const isLoading = ref(false)

  async function sendMessage(text: string, context?: GemmaContext, image?: { data: string; mimeType: string; preview: string }) {
    messages.value.push({ role: 'user', text, ts: new Date().toISOString(), imagePreview: image?.preview })
    isLoading.value = true
    try {
      const history = messages.value
        .slice(0, -1)
        .map((m) => ({ role: m.role, text: m.text }))

      const payload: any = { message: text, history, context }
      if (image) payload.image = { data: image.data, mimeType: image.mimeType }

      const { data } = await axios.post('/api/gemma/chat', payload)
      messages.value.push({ role: 'model', text: data.reply, ts: new Date().toISOString() })
    } catch {
      messages.value.push({ role: 'model', text: '⚠️ Errore di connessione. Riprova.', ts: new Date().toISOString() })
    } finally {
      isLoading.value = false
    }
  }

  function clearHistory() {
    messages.value = []
  }

  return { messages, isOpen, isLoading, sendMessage, clearHistory }
})
