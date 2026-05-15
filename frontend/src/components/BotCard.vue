<template>
  <div class="stat-card flex flex-col gap-3">
    <!-- Header -->
    <div class="flex items-start justify-between">
      <div>
        <div class="flex items-center gap-2">
          <span class="font-semibold text-white">{{ bot.name }}</span>
          <span class="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-brand/20 text-brand-light">
            {{ bot.strategy }}
          </span>
        </div>
        <div class="text-xs text-gray-500 mt-0.5 font-mono">
          {{ bot.symbol }} · {{ bot.timeframe }}
          <span v-if="bot.testMode" class="ml-2 text-yellow-500">[PAPER]</span>
        </div>
      </div>
      <!-- Status indicator -->
      <div :class="bot.status === 'running' ? 'status-running' : 'status-stopped'" class="text-xs font-medium">
        <span :class="bot.status === 'running' ? 'pulse-dot' : 'w-2 h-2 rounded-full bg-gray-500'" />
        {{ bot.status }}
      </div>
    </div>

    <!-- Live price -->
    <div v-if="livePrice" class="flex items-baseline gap-2">
      <span class="text-xl font-mono font-bold text-white">${{ livePrice.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 }) }}</span>
      <span :class="livePrice.changePct >= 0 ? 'profit' : 'loss'" class="text-xs font-mono">
        {{ livePrice.changePct >= 0 ? '+' : '' }}{{ livePrice.changePct?.toFixed(2) }}%
      </span>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-3 gap-2 text-center text-xs">
      <div class="bg-surface-200 rounded p-2">
        <div class="text-gray-500">Trades</div>
        <div class="font-semibold text-white">{{ bot._count?.trades ?? 0 }}</div>
      </div>
      <div class="bg-surface-200 rounded p-2">
        <div class="text-gray-500">Signals</div>
        <div class="font-semibold text-white">{{ bot._count?.signals ?? 0 }}</div>
      </div>
      <div class="bg-surface-200 rounded p-2">
        <div class="text-gray-500">Win%</div>
        <div class="font-semibold" :class="stats?.winRate >= 50 ? 'profit' : 'loss'">
          {{ stats?.winRate?.toFixed(0) ?? '—' }}{{ stats ? '%' : '' }}
        </div>
      </div>
    </div>

    <!-- Actions -->
    <div class="flex gap-2">
      <Button
        v-if="bot.status !== 'running'"
        @click="$emit('start', bot.id)"
        size="small"
        label="Start"
        icon="pi pi-play"
        class="flex-1"
        severity="success"
      />
      <Button
        v-else
        @click="$emit('stop', bot.id)"
        size="small"
        label="Stop"
        icon="pi pi-stop"
        class="flex-1"
        severity="warning"
      />
      <Button
        @click="$emit('delete', bot.id)"
        size="small"
        icon="pi pi-trash"
        severity="danger"
        text
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Button from 'primevue/button'
import { useBotStore } from '@/stores/bot'
import type { Bot } from '@/stores/bot'

const props = defineProps<{ bot: Bot }>()
defineEmits<{ start: [id: number]; stop: [id: number]; delete: [id: number] }>()

const botStore = useBotStore()
const stats = ref<any>(null)

const livePrice = computed(() => botStore.prices[props.bot.symbol])

onMounted(async () => {
  stats.value = await botStore.getStats(props.bot.id)
})
</script>
