<template>
  <!-- Floating toggle button -->
  <button
    v-if="!store.isOpen"
    @click="store.isOpen = true"
    class="fixed bottom-5 right-5 z-[9999] w-12 h-12 rounded-full bg-brand shadow-lg shadow-brand/40 flex items-center justify-center hover:scale-110 transition-transform"
    title="Gemma AI Assistant"
  >
    <i class="pi pi-microchip-ai text-white text-xl" />
    <span
      v-if="store.messages.length > 0"
      class="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-profit border-2 border-surface-0"
    />
  </button>

  <!-- Chat panel -->
  <Transition name="chat">
    <div
      v-if="store.isOpen"
      class="fixed bottom-5 right-5 z-[9999] w-[380px] h-[520px] bg-surface-50 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
    >
      <!-- Header -->
      <div class="flex items-center gap-2 px-4 py-3 border-b border-white/10 shrink-0">
        <div class="w-7 h-7 rounded-full bg-brand flex items-center justify-center">
          <i class="pi pi-microchip-ai text-white text-xs" />
        </div>
        <div class="flex-1 min-w-0">
          <span class="text-sm font-semibold text-white">Gemma 4</span>
          <span class="ml-2 text-[10px] font-mono text-gray-500 bg-surface-200 px-1.5 py-0.5 rounded">gemma-4-31b-it</span>
        </div>
        <button @click="store.clearHistory()" title="Pulisci chat" class="text-gray-500 hover:text-gray-300 text-xs px-1">
          <i class="pi pi-trash" />
        </button>
        <button @click="store.isOpen = false" class="text-gray-500 hover:text-white p-1">
          <i class="pi pi-times text-sm" />
        </button>
      </div>

      <!-- Messages -->
      <div ref="messagesEl" class="flex-1 overflow-y-auto px-4 py-3 space-y-3 scroll-smooth">
        <div v-if="store.messages.length === 0" class="h-full flex flex-col items-center justify-center gap-2 text-center">
          <i class="pi pi-microchip-ai text-brand text-3xl opacity-40" />
          <p class="text-gray-500 text-xs max-w-[220px]">Chiedimi di analizzare segnali, posizioni o invia uno screenshot del grafico.</p>
        </div>

        <template v-for="msg in store.messages" :key="msg.ts">
          <div :class="['flex flex-col', msg.role === 'user' ? 'items-end' : 'items-start']">
            <img
              v-if="msg.imagePreview"
              :src="msg.imagePreview"
              class="max-w-[200px] rounded-xl mb-1 border border-white/10"
            />
            <div
              :class="[
                'max-w-[85%] px-3 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap break-words',
                msg.role === 'user'
                  ? 'bg-brand text-white rounded-br-sm'
                  : 'bg-surface-200 text-gray-200 rounded-bl-sm',
              ]"
            >{{ msg.text }}</div>
          </div>
        </template>

        <!-- Typing indicator -->
        <div v-if="store.isLoading" class="flex justify-start">
          <div class="bg-surface-200 px-4 py-3 rounded-2xl rounded-bl-sm flex gap-1.5 items-center">
            <span v-for="i in 3" :key="i" class="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" :style="`animation-delay: ${(i - 1) * 0.15}s`" />
          </div>
        </div>
      </div>

      <!-- Image preview bar -->
      <div v-if="pendingImage" class="px-3 pt-2 shrink-0 flex items-center gap-2">
        <img :src="pendingImage.preview" class="w-10 h-10 rounded-lg object-cover border border-white/10" />
        <span class="text-xs text-gray-400 flex-1 truncate">{{ pendingImageName }}</span>
        <button @click="clearImage" class="text-gray-500 hover:text-red-400">
          <i class="pi pi-times text-xs" />
        </button>
      </div>

      <!-- Input row -->
      <div class="px-3 pb-3 shrink-0 border-t border-white/10 pt-2">
        <div class="flex gap-2 items-end">
          <input ref="fileInputEl" type="file" accept="image/*" class="hidden" @change="onFileChange" />
          <button
            @click="fileInputEl?.click()"
            :disabled="store.isLoading"
            title="Allega immagine"
            class="shrink-0 w-9 h-9 rounded-xl bg-surface-200 flex items-center justify-center text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
          >
            <i class="pi pi-image text-sm" />
          </button>
          <textarea
            ref="inputEl"
            v-model="draft"
            @keydown.enter.exact.prevent="send"
            @paste="onPaste"
            rows="1"
            placeholder="Scrivi o incolla uno screenshot… (Invio per inviare)"
            class="flex-1 resize-none bg-surface-200 border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand/60 min-h-[38px] max-h-24 overflow-y-auto"
            :disabled="store.isLoading"
          />
          <button
            @click="send"
            :disabled="store.isLoading || (!draft.trim() && !pendingImage)"
            class="shrink-0 w-9 h-9 rounded-xl bg-brand flex items-center justify-center disabled:opacity-40 hover:bg-brand/80 transition-colors"
          >
            <i class="pi pi-send text-white text-sm" />
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useGemmaStore } from '@/stores/gemma'
import { useSmartScannerStore } from '@/stores/smart-scanner'
import { useLiveStore } from '@/stores/live'

const store       = useGemmaStore()
const smartStore  = useSmartScannerStore()
const liveStore   = useLiveStore()

const draft        = ref('')
const messagesEl   = ref<HTMLElement | null>(null)
const inputEl      = ref<HTMLTextAreaElement | null>(null)
const fileInputEl  = ref<HTMLInputElement | null>(null)

interface PendingImage { data: string; mimeType: string; preview: string }
const pendingImage     = ref<PendingImage | null>(null)
const pendingImageName = ref('')

function clearImage() {
  pendingImage.value = null
  pendingImageName.value = ''
  if (fileInputEl.value) fileInputEl.value.value = ''
}

function resizeAndEncode(file: File | Blob, maxPx = 1024): Promise<{ data: string; mimeType: string; preview: string }> {
  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
      const preview = canvas.toDataURL('image/jpeg', 0.85)
      resolve({ data: preview.split(',')[1], mimeType: 'image/jpeg', preview })
    }
    img.src = url
  })
}

async function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of Array.from(items)) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      pendingImageName.value = 'screenshot'
      pendingImage.value = await resizeAndEncode(file)
      return
    }
  }
}

async function onFileChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  pendingImageName.value = file.name
  pendingImage.value = await resizeAndEncode(file)
}

function gatherContext() {
  const openPositions = smartStore.trades
    .filter((t) => t.status === 'open')
    .slice(0, 8)
    .map((t) => ({ symbol: t.symbol, direction: t.direction, entry: t.entry, pnl: t.unrealizedPnl, grade: t.grade, scanner: 'SMART' }))
  return {
    openPositions,
    recentSignals: smartStore.signals.slice(0, 5).map((s) => ({
      symbol: s.symbol, direction: s.direction, pattern: s.patternName,
      score: s.score, grade: s.grade, approved: s.gemmaApproved, scanner: 'SMART',
    })),
    liveEnabled: smartStore.analytics?.config?.liveEnabled ?? false,
    livePositionCount: liveStore.positions?.length ?? 0,
  }
}

async function send() {
  const text = draft.value.trim()
  if ((!text && !pendingImage.value) || store.isLoading) return
  const img = pendingImage.value ?? undefined
  draft.value = ''
  clearImage()
  await store.sendMessage(text || 'Analizza questa immagine.', gatherContext(), img)
}

watch(() => store.messages.length, async () => {
  await nextTick()
  if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
})

watch(() => store.isOpen, async (open) => {
  if (open) {
    await nextTick()
    inputEl.value?.focus()
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight
  }
})
</script>

<style scoped>
.chat-enter-active, .chat-leave-active { transition: opacity 0.15s ease, transform 0.15s ease; }
.chat-enter-from, .chat-leave-to { opacity: 0; transform: translateY(12px) scale(0.97); }
</style>
