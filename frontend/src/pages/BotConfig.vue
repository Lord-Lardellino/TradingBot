<template>
  <div class="p-6 space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-white">Bot Manager</h1>
        <p class="text-sm text-gray-500 mt-0.5">Create and manage your trading bots</p>
      </div>
      <Button label="New Bot" icon="pi pi-plus" @click="showDialog = true" />
    </div>

    <!-- Bots grid -->
    <div v-if="botStore.loading" class="flex justify-center py-12">
      <ProgressSpinner />
    </div>
    <div v-else-if="botStore.bots.length" class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <BotCard
        v-for="bot in botStore.bots"
        :key="bot.id"
        :bot="bot"
        @start="handleStart"
        @stop="handleStop"
        @delete="handleDelete"
      />
    </div>
    <div v-else class="stat-card text-center py-12">
      <i class="pi pi-android text-4xl text-gray-700 mb-3" />
      <p class="text-gray-500">No bots yet. Create your first bot to start trading.</p>
    </div>

    <!-- Create bot dialog -->
    <Dialog v-model:visible="showDialog" header="Create New Bot" :style="{ width: '420px' }" modal>
      <div class="space-y-4 py-2">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Bot Name</label>
          <InputText v-model="form.name" placeholder="My Scalper" class="w-full" />
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-gray-400">Strategy</label>
            <Select
              v-model="form.strategy"
              :options="strategies"
              option-label="label"
              option-value="value"
              class="w-full"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label class="text-xs text-gray-400">Timeframe</label>
            <Select v-model="form.timeframe" :options="timeframes" class="w-full" />
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Symbol</label>
          <Select v-model="form.symbol" :options="popularPairs" editable class="w-full" />
        </div>

        <!-- Strategy params -->
        <Fieldset legend="Strategy Parameters" toggleable collapsed class="text-xs">
          <div class="grid grid-cols-2 gap-3 mt-2">
            <div v-if="form.strategy === 'scalping'" class="col-span-2 grid grid-cols-2 gap-3">
              <div class="flex flex-col gap-1">
                <label class="text-xs text-gray-500">Stop Loss %</label>
                <InputNumber v-model="form.config.stopLossPct" :min="0.1" :max="5" :step="0.1" :min-fraction-digits="1" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs text-gray-500">Take Profit %</label>
                <InputNumber v-model="form.config.takeProfitPct" :min="0.1" :max="10" :step="0.1" :min-fraction-digits="1" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs text-gray-500">RSI Oversold</label>
                <InputNumber v-model="form.config.rsiOversold" :min="10" :max="40" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs text-gray-500">RSI Overbought</label>
                <InputNumber v-model="form.config.rsiOverbought" :min="60" :max="90" />
              </div>
            </div>
            <div v-if="form.strategy === 'pump'" class="col-span-2 grid grid-cols-2 gap-3">
              <div class="flex flex-col gap-1">
                <label class="text-xs text-gray-500">Volume Spike ×</label>
                <InputNumber v-model="form.config.volumeRatioThreshold" :min="1.5" :max="10" :step="0.5" :min-fraction-digits="1" />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-xs text-gray-500">Price Change %</label>
                <InputNumber v-model="form.config.priceChangePct" :min="0.5" :max="20" :step="0.5" :min-fraction-digits="1" />
              </div>
            </div>
          </div>
        </Fieldset>

        <div class="flex items-center gap-2">
          <ToggleSwitch v-model="form.testMode" />
          <span class="text-sm text-gray-400">
            Paper trading <span class="text-xs text-yellow-500">(no real orders)</span>
          </span>
        </div>
      </div>

      <template #footer>
        <div class="flex gap-2 justify-end">
          <Button label="Cancel" severity="secondary" text @click="showDialog = false" />
          <Button label="Create Bot" icon="pi pi-plus" @click="handleCreate" :loading="creating" />
        </div>
      </template>
    </Dialog>

    <ConfirmDialog />
    <Toast />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import Select from 'primevue/select'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Fieldset from 'primevue/fieldset'
import ToggleSwitch from 'primevue/toggleswitch'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import Toast from 'primevue/toast'
import BotCard from '@/components/BotCard.vue'
import { useBotStore } from '@/stores/bot'

const botStore = useBotStore()
const confirm = useConfirm()
const toast = useToast()

const showDialog = ref(false)
const creating = ref(false)
const popularPairs = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT', 'DOGE/USDT', 'PEPE/USDT']
const timeframes = ['1m', '3m', '5m', '15m']
const strategies = [
  { label: 'Scalping (EMA + RSI + MACD)', value: 'scalping' },
  { label: 'Pump Detector (Volume spike)', value: 'pump' },
]

const form = reactive({
  name: '',
  strategy: 'scalping',
  symbol: 'BTC/USDT',
  timeframe: '1m',
  testMode: true,
  config: {
    stopLossPct: 0.5,
    takeProfitPct: 1.0,
    rsiOversold: 35,
    rsiOverbought: 65,
    volumeRatioThreshold: 3.0,
    priceChangePct: 2.0,
  },
})

async function handleCreate() {
  if (!form.name) return toast.add({ severity: 'warn', summary: 'Name required', life: 3000 })
  creating.value = true
  try {
    await botStore.create({ ...form })
    showDialog.value = false
    toast.add({ severity: 'success', summary: 'Bot created', life: 3000 })
  } finally {
    creating.value = false
  }
}

async function handleStart(id: number) {
  await botStore.start(id)
  toast.add({ severity: 'success', summary: 'Bot started', life: 2000 })
}

async function handleStop(id: number) {
  await botStore.stop(id)
  toast.add({ severity: 'info', summary: 'Bot stopped', life: 2000 })
}

function handleDelete(id: number) {
  confirm.require({
    message: 'Delete this bot and all its data?',
    header: 'Confirm Delete',
    icon: 'pi pi-trash',
    rejectProps: { label: 'Cancel', severity: 'secondary', text: true },
    acceptProps: { label: 'Delete', severity: 'danger' },
    accept: async () => {
      await botStore.remove(id)
      toast.add({ severity: 'success', summary: 'Bot deleted', life: 2000 })
    },
  })
}

onMounted(() => botStore.fetchAll())
</script>
