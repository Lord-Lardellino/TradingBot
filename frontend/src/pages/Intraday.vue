<template>
  <div class="p-6 space-y-6">

    <!-- Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-bold text-white">Intraday 4H — PHR v1</h1>
        <p class="text-xs text-gray-500 mt-0.5">Pump-Halt-Retest · EMA34 4H · LONG · No SL · Liq or TP</p>
      </div>
      <div class="flex items-center gap-3">
        <span :class="store.status.isScanning ? 'text-yellow-400' : 'text-gray-500'" class="text-xs font-mono">
          {{ store.status.isScanning ? 'Scanning...' : store.status.lastScanAt ? 'Last: ' + fmtTime(store.status.lastScanAt) : 'Waiting' }}
        </span>
        <button
          class="px-3 py-1.5 rounded text-xs bg-red-900/40 text-red-400 border border-red-800/50 hover:bg-red-800/50"
          @click="confirmReset"
        >Reset</button>
      </div>
    </div>

    <!-- Analytics cards -->
    <div v-if="store.analytics" class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3">
        <div class="text-[10px] text-gray-500 mb-0.5">Capital</div>
        <div class="font-bold text-white text-sm">€{{ fmt(store.analytics.currentCapital) }}</div>
        <div :class="store.analytics.totalPnl >= 0 ? 'text-profit' : 'text-loss'" class="text-[10px] mt-0.5">
          {{ store.analytics.totalPnl >= 0 ? '+' : '' }}€{{ fmt(Math.abs(store.analytics.totalPnl)) }}
          ({{ fmt(store.analytics.totalPnlPct) }}%)
        </div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3">
        <div class="text-[10px] text-gray-500 mb-0.5">Trades</div>
        <div class="font-bold text-white text-sm">{{ store.analytics.totalTrades }}</div>
        <div class="text-[10px] text-gray-500 mt-0.5">{{ store.analytics.openTrades }} open</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3">
        <div class="text-[10px] text-gray-500 mb-0.5">Win Rate</div>
        <div :class="store.analytics.winRate >= 50 ? 'text-profit' : 'text-loss'" class="font-bold text-sm">
          {{ fmt(store.analytics.winRate) }}%
        </div>
        <div class="text-[10px] text-gray-500 mt-0.5">{{ store.analytics.wins }}W / {{ store.analytics.losses }}L</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3">
        <div class="text-[10px] text-gray-500 mb-0.5">Profit Factor</div>
        <div :class="store.analytics.profitFactor >= 1 ? 'text-profit' : 'text-loss'" class="font-bold text-sm">
          {{ store.analytics.profitFactor }}
        </div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3">
        <div class="text-[10px] text-gray-500 mb-0.5">Avg Win</div>
        <div class="font-bold text-profit text-sm">€{{ fmt(store.analytics.avgWinEur) }}</div>
      </div>
      <div class="bg-surface-50 border border-white/5 rounded-xl p-3">
        <div class="text-[10px] text-gray-500 mb-0.5">Max DD</div>
        <div :class="store.analytics.maxDrawdownPct < 20 ? 'text-white' : 'text-loss'" class="font-bold text-sm">
          {{ fmt(store.analytics.maxDrawdownPct) }}%
        </div>
      </div>
    </div>

    <!-- Signals + Open Positions -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">

      <!-- Signals -->
      <div class="bg-surface-50 rounded-xl border border-white/5 p-4">
        <h2 class="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <i class="pi pi-bell text-yellow-400" />
          4H Signals — Pump-Halt-Retest
          <span class="ml-auto text-xs text-gray-500">{{ store.signals.length }}</span>
        </h2>
        <div v-if="store.signals.length === 0" class="text-xs text-gray-600 py-6 text-center">
          Waiting for next 4H scan (every 5 min)…
        </div>
        <div v-else class="space-y-2 max-h-80 overflow-y-auto pr-1">
          <div v-for="sig in store.signals" :key="sig.id" class="bg-surface-100 rounded-lg p-3 text-xs border border-white/5">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-2">
                <span class="font-bold text-white">{{ shortSym(sig.symbol) }}</span>
                <span class="text-[10px] text-gray-500">EMA34 {{ sig.ema34_4h?.toPrecision(5) }}</span>
              </div>
              <span :class="gradeCls(sig.grade)" class="text-[10px] font-bold border rounded px-1.5 py-0.5">
                {{ sig.grade }} · {{ sig.score }}
              </span>
            </div>
            <div class="grid grid-cols-3 gap-x-3 gap-y-0.5 text-gray-400">
              <span>Pump <b class="text-green-400">{{ sig.pumpCandle4hPct?.toFixed(1) }}%</b></span>
              <span>Retest <b class="text-blue-400">{{ sig.distToEma34?.toFixed(2) }}%</b></span>
              <span>Vol <b class="text-white">{{ sig.trigVolRatio?.toFixed(1) }}×</b></span>
              <span>Entry <b class="text-white">{{ sig.entry?.toPrecision(6) }}</b></span>
              <span>Body <b class="text-white">{{ (sig.trigBodyRatio * 100)?.toFixed(0) }}%</b></span>
              <span class="text-gray-600">{{ fmtTime(sig.timestamp) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Open Positions -->
      <div class="bg-surface-50 rounded-xl border border-white/5 p-4">
        <h2 class="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <i class="pi pi-chart-line text-blue-400" />
          Open Positions
          <span class="ml-auto text-xs text-gray-500">{{ store.openTrades.length }} active</span>
        </h2>
        <div v-if="store.openTrades.length === 0" class="text-xs text-gray-600 py-6 text-center">
          No open intraday positions
        </div>
        <div v-else class="space-y-2 max-h-80 overflow-y-auto pr-1">
          <div v-for="trade in store.openTrades" :key="trade.id" class="bg-surface-100 rounded-lg p-3 text-xs border border-white/5">
            <div class="flex items-center justify-between mb-1.5">
              <div class="flex items-center gap-2">
                <span class="font-bold text-white">{{ shortSym(trade.symbol) }}</span>
                <span class="text-[10px] text-gray-500">{{ trade.leverage }}×</span>
              </div>
              <div class="flex items-center gap-2">
                <span :class="(trade.unrealizedPnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'" class="font-mono font-bold">
                  {{ trade.unrealizedPnl != null ? ((trade.unrealizedPnl >= 0 ? '+' : '') + '€' + trade.unrealizedPnl.toFixed(2)) : '…' }}
                </span>
                <span :class="gradeCls(trade.grade)" class="text-[10px] font-bold border rounded px-1.5 py-0.5">
                  {{ trade.grade }}
                </span>
              </div>
            </div>
            <div class="grid grid-cols-3 gap-x-3 gap-y-0.5 text-gray-400">
              <span>Entry <b class="text-white">{{ trade.entry?.toPrecision(6) }}</b></span>
              <span>Liq <b class="text-red-400">{{ trade.stopLoss?.toPrecision(6) }}</b></span>
              <span>TP2 <b class="text-profit">{{ trade.takeProfit2?.toPrecision(6) }}</b></span>
              <span>Live <b class="text-white">{{ trade.currentPrice?.toPrecision(6) ?? '…' }}</b></span>
              <span>Pump <b class="text-green-400">{{ trade.pumpPct?.toFixed(1) }}%</b></span>
              <span>
                <button class="text-red-400 hover:text-red-300 underline" @click="store.closeManual(trade.id)">
                  close
                </button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Trade History -->
    <div class="bg-surface-50 rounded-xl border border-white/5 p-4">
      <h2 class="text-sm font-semibold text-white mb-3 flex items-center gap-2">
        <i class="pi pi-list" /> Trade History
      </h2>
      <div v-if="store.closedTrades.length === 0" class="text-xs text-gray-600 py-4 text-center">
        No closed trades yet
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-xs">
          <thead>
            <tr class="text-gray-500 border-b border-white/5">
              <th class="text-left pb-2 pr-3">Symbol</th>
              <th class="text-left pb-2 pr-3">Grade</th>
              <th class="text-right pb-2 pr-3">Entry</th>
              <th class="text-right pb-2 pr-3">Close</th>
              <th class="text-right pb-2 pr-3">PnL €</th>
              <th class="text-right pb-2 pr-3">PnL %cap</th>
              <th class="text-right pb-2 pr-3">Lev</th>
              <th class="text-right pb-2 pr-3">Pump</th>
              <th class="text-right pb-2">Result</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in store.closedTrades" :key="t.id" class="border-b border-white/5 hover:bg-surface-100">
              <td class="py-1.5 pr-3 font-mono text-white">{{ shortSym(t.symbol) }}</td>
              <td class="pr-3">
                <span :class="gradeCls(t.grade)" class="text-[10px] font-bold border rounded px-1 py-0.5">{{ t.grade }}</span>
              </td>
              <td class="text-right pr-3 text-gray-400">{{ t.entry?.toPrecision(5) }}</td>
              <td class="text-right pr-3 text-gray-400">{{ t.closePrice?.toPrecision(5) ?? '—' }}</td>
              <td :class="(t.pnl ?? 0) >= 0 ? 'text-profit' : 'text-loss'" class="text-right pr-3 font-mono font-bold">
                {{ (t.pnl ?? 0) >= 0 ? '+' : '' }}{{ Math.abs(t.pnl ?? 0).toFixed(2) }}
              </td>
              <td :class="(t.pnlCapPct ?? 0) >= 0 ? 'text-profit' : 'text-loss'" class="text-right pr-3 font-mono">
                {{ (t.pnlCapPct ?? 0) >= 0 ? '+' : '' }}{{ Math.abs(t.pnlCapPct ?? 0).toFixed(1) }}%
              </td>
              <td class="text-right pr-3 text-gray-400">{{ t.leverage }}×</td>
              <td class="text-right pr-3 text-green-400">{{ t.pumpPct?.toFixed(1) }}%</td>
              <td class="text-right">
                <span :class="statusCls(t.status)" class="font-mono uppercase text-[10px]">{{ t.status }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Config -->
    <div v-if="store.cfg" class="bg-surface-50 rounded-xl border border-white/5 p-4">
      <h2 class="text-sm font-semibold text-white mb-1">Config</h2>
      <p class="text-[10px] text-gray-600 mb-3">Nessun SL — posizione ride fino a TP o liquidazione (margine azzerato)</p>
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div>
          <label class="block text-[10px] text-gray-500 mb-1">Margin €</label>
          <input type="number" min="1" max="1000"
            :value="store.cfg.marginPerTrade"
            @change="store.updateConfig({ marginPerTrade: +($event.target as HTMLInputElement).value })"
            class="w-full bg-surface-100 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none" />
        </div>
        <div>
          <label class="block text-[10px] text-gray-500 mb-1">Leverage</label>
          <input type="number" min="2" max="50"
            :value="store.cfg.leverage"
            @change="store.updateConfig({ leverage: +($event.target as HTMLInputElement).value })"
            class="w-full bg-surface-100 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none" />
        </div>
        <div>
          <label class="block text-[10px] text-gray-500 mb-1">Target TP</label>
          <select
            :value="store.cfg.targetTP"
            @change="store.updateConfig({ targetTP: ($event.target as HTMLSelectElement).value })"
            class="w-full bg-surface-100 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none"
          >
            <option v-for="o in ['TP1','TP2','TP3']" :key="o" :value="o">{{ o }}</option>
          </select>
        </div>
        <div>
          <label class="block text-[10px] text-gray-500 mb-1">Max Concurrent</label>
          <input type="number" min="1" max="20"
            :value="store.cfg.maxConcurrent"
            @change="store.updateConfig({ maxConcurrent: +($event.target as HTMLInputElement).value })"
            class="w-full bg-surface-100 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none" />
        </div>
        <div>
          <label class="block text-[10px] text-gray-500 mb-1">Min Grade</label>
          <select
            :value="store.cfg.minGrade"
            @change="store.updateConfig({ minGrade: ($event.target as HTMLSelectElement).value })"
            class="w-full bg-surface-100 border border-white/10 rounded px-2 py-1 text-xs text-white focus:outline-none"
          >
            <option v-for="o in ['A+','A','B']" :key="o" :value="o">{{ o }}</option>
          </select>
        </div>
        <div class="flex items-center gap-2 pt-4">
          <input type="checkbox"
            :checked="store.cfg.autoEnter"
            @change="store.updateConfig({ autoEnter: ($event.target as HTMLInputElement).checked })"
            class="accent-brand" />
          <label class="text-xs text-gray-400">Auto Enter</label>
        </div>
        <div class="flex items-end pb-1">
          <button
            class="px-3 py-1.5 rounded text-xs bg-blue-900/40 text-blue-400 border border-blue-800/50 hover:bg-blue-800/50 w-full"
            @click="syncCapital"
          >
            Sync Capital
          </button>
        </div>
      </div>
      <!-- TP preview -->
      <div v-if="store.cfg" class="mt-3 flex gap-6 text-[10px] text-gray-500 font-mono">
        <span>Liq: <b class="text-red-400">-{{ (100 / store.cfg.leverage).toFixed(1) }}% price</b> → €-{{ store.cfg.marginPerTrade }}</span>
        <span>TP1: <b class="text-profit">+{{ (200 / store.cfg.leverage).toFixed(1) }}% price</b> → €+{{ (store.cfg.marginPerTrade * 2).toFixed(0) }}</span>
        <span>TP2: <b class="text-profit">+{{ (500 / store.cfg.leverage).toFixed(1) }}% price</b> → €+{{ (store.cfg.marginPerTrade * 5).toFixed(0) }}</span>
        <span>TP3: <b class="text-profit">+{{ (1000 / store.cfg.leverage).toFixed(1) }}% price</b> → €+{{ (store.cfg.marginPerTrade * 10).toFixed(0) }}</span>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useIntraStore } from '@/stores/intra'

const store = useIntraStore()

async function confirmReset() {
  if (!confirm('Reset the intraday simulation? All trades will be deleted.')) return
  await store.reset()
}

async function syncCapital() {
  await import('axios').then(({ default: axios }) => axios.post('/api/intra/sync-capital'))
  await store.fetchAll()
}

let pollInterval: ReturnType<typeof setInterval>
onMounted(() => {
  store.fetchAll()
  pollInterval = setInterval(() => {
    import('axios').then(({ default: axios }) =>
      axios.get('/api/intra/status').then((r) => Object.assign(store.status, r.data))
    )
  }, 30_000)
})
onUnmounted(() => clearInterval(pollInterval))

function fmt(v: number, d = 2) {
  return v?.toFixed(d) ?? '0.00'
}
function shortSym(s: string) {
  return s?.replace('/USDT:USDT', '') ?? s
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
}
function gradeCls(g: string) {
  if (g === 'A+') return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'
  if (g === 'A')  return 'bg-green-500/20 text-green-300 border-green-500/30'
  if (g === 'B')  return 'bg-blue-500/20 text-blue-300 border-blue-500/30'
  return 'bg-gray-500/20 text-gray-400 border-gray-600'
}
function statusCls(s: string) {
  if (s?.startsWith('tp')) return 'text-profit'
  if (s === 'liq')          return 'text-red-500'
  if (s === 'manual')       return 'text-gray-400'
  return 'text-blue-400'
}
</script>
