<template>
  <div class="overflow-x-auto -mx-1">
  <DataTable
    :value="trades"
    :loading="loading"
    size="small"
    scrollable
    scroll-height="400px"
    :row-class="rowClass"
    class="text-xs min-w-[600px]"
  >
    <Column field="symbol" header="Symbol" class="font-mono font-semibold" />
    <Column header="Side">
      <template #body="{ data }">
        <span :class="`badge-${data.side.toLowerCase()}`">{{ data.side }}</span>
      </template>
    </Column>
    <Column header="Entry" class="font-mono">
      <template #body="{ data }">
        ${{ data.entryPrice?.toFixed(4) }}
      </template>
    </Column>
    <Column header="Exit" class="font-mono">
      <template #body="{ data }">
        <span v-if="data.exitPrice">${{ data.exitPrice?.toFixed(4) }}</span>
        <span v-else class="text-gray-500">open</span>
      </template>
    </Column>
    <Column header="PnL">
      <template #body="{ data }">
        <span
          v-if="data.pnl !== null && data.pnl !== undefined"
          :class="data.pnl >= 0 ? 'profit' : 'loss'"
          class="font-mono font-semibold"
        >
          {{ data.pnl >= 0 ? '+' : '' }}{{ data.pnl?.toFixed(4) }}
          <span class="text-xs opacity-70">({{ data.pnlPct?.toFixed(2) }}%)</span>
        </span>
        <span v-else class="text-gray-500">—</span>
      </template>
    </Column>
    <Column header="Status">
      <template #body="{ data }">
        <span :class="data.status === 'open' ? 'text-yellow-400' : data.pnl >= 0 ? 'profit' : 'loss'">
          {{ data.status }}
        </span>
      </template>
    </Column>
    <Column header="Bot" class="text-gray-400">
      <template #body="{ data }">{{ data.bot?.name ?? `#${data.botId}` }}</template>
    </Column>
    <Column header="Time" class="font-mono text-gray-500">
      <template #body="{ data }">
        {{ formatTime(data.openedAt) }}
      </template>
    </Column>
    <template #empty>
      <div class="text-center text-gray-600 py-6">No trades found</div>
    </template>
  </DataTable>
  </div>
</template>

<script setup lang="ts">
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import type { Trade } from '@/stores/trades'

defineProps<{ trades: Trade[]; loading?: boolean }>()

function rowClass(data: Trade) {
  if (data.status === 'open') return 'opacity-80'
  return ''
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('it-IT', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}
</script>
