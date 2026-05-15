<template>
  <div class="space-y-2 max-h-80 overflow-y-auto pr-1">
    <TransitionGroup name="signal-list">
      <div
        v-for="signal in signals"
        :key="signal.id"
        class="flex items-center gap-3 p-2.5 rounded-lg bg-surface-100 border border-white/5 text-xs"
      >
        <!-- Type badge -->
        <span :class="`badge-${signal.type.toLowerCase()}`">
          {{ signal.type }}
        </span>

        <!-- Symbol + price -->
        <div class="flex-1 min-w-0">
          <div class="font-mono font-semibold text-white truncate">
            {{ signal.symbol }}
            <span class="text-gray-400 ml-1">${{ signal.price?.toFixed(4) }}</span>
          </div>
          <div v-if="signal.reason" class="text-gray-500 truncate mt-0.5">{{ signal.reason }}</div>
        </div>

        <!-- Indicators -->
        <div class="flex flex-col items-end gap-0.5 font-mono text-[10px] text-gray-500 shrink-0">
          <span v-if="signal.rsi">RSI {{ signal.rsi?.toFixed(1) }}</span>
          <span v-if="signal.volumeRatio">Vol ×{{ signal.volumeRatio?.toFixed(1) }}</span>
        </div>

        <!-- Time -->
        <div class="text-gray-600 text-[10px] shrink-0">
          {{ formatTime(signal.createdAt) }}
        </div>
      </div>
    </TransitionGroup>

    <div v-if="!signals.length" class="text-center text-gray-600 text-sm py-6">
      No signals yet
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Signal } from '@/stores/signals'

defineProps<{ signals: Signal[] }>()

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
</script>

<style scoped>
.signal-list-enter-active { transition: all 0.3s ease; }
.signal-list-enter-from   { opacity: 0; transform: translateY(-8px); }
.signal-list-leave-to     { opacity: 0; transform: translateX(20px); }
</style>
