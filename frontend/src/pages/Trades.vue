<template>
  <div class="p-3 sm:p-6 space-y-4 sm:space-y-6">
    <h1 class="text-xl font-bold text-white">Trade History</h1>

    <!-- Summary strip -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500">Total</div>
        <div class="text-lg font-bold text-white">{{ summary.totalTrades }}</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500">Wins</div>
        <div class="text-lg font-bold profit">{{ summary.wins }}</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500">Losses</div>
        <div class="text-lg font-bold loss">{{ summary.losses }}</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500">Win Rate</div>
        <div class="text-lg font-bold" :class="summary.winRate >= 50 ? 'profit' : 'loss'">
          {{ summary.winRate?.toFixed(1) }}%
        </div>
      </div>
      <div class="stat-card text-center">
        <div class="text-xs text-gray-500">Net PnL</div>
        <div
          class="text-lg font-bold font-mono"
          :class="summary.totalPnl >= 0 ? 'profit' : 'loss'"
        >
          {{ summary.totalPnl >= 0 ? '+' : '' }}${{ summary.totalPnl?.toFixed(2) }}
        </div>
      </div>
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3">
      <Select
        v-model="filterStatus"
        :options="statusOptions"
        option-label="label"
        option-value="value"
        placeholder="All statuses"
        show-clear
        class="text-sm"
      />
      <Button
        label="Refresh"
        icon="pi pi-refresh"
        size="small"
        severity="secondary"
        @click="load"
      />
    </div>

    <!-- Table -->
    <div class="stat-card">
      <TradeTable :trades="tradesStore.trades" :loading="tradesStore.loading" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import Select from 'primevue/select'
import Button from 'primevue/button'
import TradeTable from '@/components/TradeTable.vue'
import { useTradesStore } from '@/stores/trades'
import { storeToRefs } from 'pinia'

const tradesStore = useTradesStore()
const { summary } = storeToRefs(tradesStore)

const filterStatus = ref<string | null>(null)
const statusOptions = [
  { label: 'Open', value: 'open' },
  { label: 'Closed', value: 'closed' },
]

async function load() {
  await Promise.all([
    tradesStore.fetchAll(undefined, filterStatus.value ?? undefined),
    tradesStore.fetchSummary(),
  ])
}

watch(filterStatus, load)
onMounted(load)
</script>
