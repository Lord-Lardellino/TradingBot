<template>
  <div class="p-3 sm:p-6 max-w-xl space-y-4 sm:space-y-6">
    <div>
      <h1 class="text-xl font-bold text-white">Settings</h1>
      <p class="text-sm text-gray-500 mt-0.5">Configure MEXC API and global trading parameters</p>
    </div>

    <div class="stat-card space-y-5">
      <h2 class="text-sm font-semibold text-white border-b border-white/5 pb-2">MEXC API Credentials</h2>

      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-gray-400">API Key</label>
        <InputText v-model="form.apiKey" placeholder="mx0v..." class="w-full font-mono text-sm" />
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-xs text-gray-400">API Secret</label>
        <Password v-model="form.apiSecret" placeholder="Enter secret..." class="w-full" :feedback="false" toggle-mask />
      </div>

      <div class="flex items-center gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
        <i class="pi pi-exclamation-triangle text-yellow-500" />
        <p class="text-xs text-yellow-400">
          Enable <strong>Paper Trading</strong> mode on each bot while testing. Real orders require valid API keys with Spot trading permissions.
        </p>
      </div>
    </div>

    <div class="stat-card space-y-5">
      <h2 class="text-sm font-semibold text-white border-b border-white/5 pb-2">Global Trading Parameters</h2>

      <div class="grid grid-cols-2 gap-4">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Stake Amount (USDT)</label>
          <InputNumber v-model="form.stakeAmount" :min="1" :max="10000" :step="1" class="w-full" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Max Open Trades</label>
          <InputNumber v-model="form.maxOpenTrades" :min="1" :max="20" class="w-full" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Default Stop Loss %</label>
          <InputNumber v-model="form.stopLossPct" :min="0.1" :max="10" :step="0.1" :min-fraction-digits="1" class="w-full" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Default Take Profit %</label>
          <InputNumber v-model="form.takeProfitPct" :min="0.1" :max="20" :step="0.1" :min-fraction-digits="1" class="w-full" />
        </div>
      </div>
    </div>

    <Button
      label="Save Settings"
      icon="pi pi-check"
      class="w-full"
      :loading="saving"
      @click="save"
    />

    <Toast />
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, onMounted } from 'vue'
import axios from 'axios'
import { useToast } from 'primevue/usetoast'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Password from 'primevue/password'
import Button from 'primevue/button'
import Toast from 'primevue/toast'

const toast = useToast()
const saving = ref(false)

const form = reactive({
  apiKey: '',
  apiSecret: '',
  stakeAmount: 10,
  maxOpenTrades: 3,
  stopLossPct: 0.5,
  takeProfitPct: 1.0,
})

async function load() {
  const { data } = await axios.get('/api/settings')
  form.apiKey = data.apiKey
  form.stakeAmount = data.stakeAmount
  form.maxOpenTrades = data.maxOpenTrades
  form.stopLossPct = data.stopLossPct
  form.takeProfitPct = data.takeProfitPct
}

async function save() {
  saving.value = true
  try {
    const payload: any = { ...form }
    if (!payload.apiSecret || payload.apiSecret === '••••••••') delete payload.apiSecret
    await axios.put('/api/settings', payload)
    toast.add({ severity: 'success', summary: 'Settings saved', life: 3000 })
  } catch {
    toast.add({ severity: 'error', summary: 'Save failed', life: 3000 })
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>
