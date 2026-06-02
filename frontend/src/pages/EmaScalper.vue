<template>
  <div class="p-4 md:p-6 max-w-6xl mx-auto space-y-5">

    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">📈 3 EMA Scalper <span class="text-xs font-mono text-gray-500">{{ cfg.symbol }} · {{ cfg.timeframe }}</span></h1>
        <p class="text-xs text-gray-500 mt-0.5">EMA {{ cfg.emaFast }}/{{ cfg.emaMid }}/{{ cfg.emaSlow }} · pullback entry · SL swing · TP {{ cfg.riskReward }}R</p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="toggleLive" :class="['px-3 py-1.5 rounded-lg text-xs font-semibold border', cfg.liveEnabled ? 'bg-red-500/20 text-red-400 border-red-500/40' : 'bg-surface-200 text-gray-400 border-white/10']">
          {{ cfg.liveEnabled ? '🔴 LIVE ON' : '⚪ Sim' }}
        </button>
        <button @click="reset" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-200 text-gray-400 border border-white/10 hover:text-white">Reset</button>
      </div>
    </div>

    <div v-if="cfg.liveEnabled" class="text-xs bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg px-3 py-2">
      ⚠️ Live ON: ad ogni setup valido vengono eseguiti ordini REALI su MEXC con SL/TP gestiti dal bot.
    </div>

    <!-- Market + Trend -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Prezzo</div>
        <div class="text-lg font-bold text-white font-mono">{{ fmt(m.price) }}</div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Trend</div>
        <div :class="['text-lg font-bold', m.trend==='up'?'text-profit':m.trend==='down'?'text-loss':'text-gray-400']">
          {{ m.trend==='up'?'▲ RIALZO':m.trend==='down'?'▼ RIBASSO':'— LATERALE' }}
        </div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Spread EMA</div>
        <div :class="['text-lg font-bold font-mono', m.choppy?'text-loss':'text-white']">{{ m.ema ? m.ema.spreadPct+'%' : '—' }}</div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Sessione</div>
        <div :class="['text-sm font-bold', m.session?.active?'text-profit':'text-gray-500']">
          {{ m.session ? (m.session.london?'London ':'')+(m.session.ny?'NY':'')||'fuori' : '—' }}
        </div>
      </div>
    </div>

    <!-- EMA values + setup -->
    <div class="grid md:grid-cols-2 gap-4">
      <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
        <div class="text-xs font-semibold text-gray-400 mb-2">Medie EMA (candela chiusa)</div>
        <div class="space-y-1.5 text-sm font-mono">
          <div class="flex justify-between"><span class="text-amber-400">EMA {{ cfg.emaFast }} (veloce)</span><span class="text-white">{{ m.ema ? fmt(m.ema.fast) : '—' }}</span></div>
          <div class="flex justify-between"><span class="text-sky-400">EMA {{ cfg.emaMid }} (media)</span><span class="text-white">{{ m.ema ? fmt(m.ema.mid) : '—' }}</span></div>
          <div class="flex justify-between"><span class="text-purple-400">EMA {{ cfg.emaSlow }} (lenta)</span><span class="text-white">{{ m.ema ? fmt(m.ema.slow) : '—' }}</span></div>
        </div>
      </div>

      <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
        <div class="text-xs font-semibold text-gray-400 mb-2">Setup corrente</div>
        <div v-if="m.setup" :class="['text-lg font-bold mb-2', m.setup==='long'?'text-profit':'text-loss']">
          ✅ SETUP {{ m.setup==='long'?'LONG':'SHORT' }} pronto
        </div>
        <div v-else class="text-sm text-gray-500 mb-2">Nessun setup — in attesa di pullback + rientro</div>
        <div v-if="m.signals" class="grid grid-cols-3 gap-1 text-[10px]">
          <span :class="chip(m.signals.touchedFastLong||m.signals.touchedFastShort)">pullback EMA{{ cfg.emaFast }}</span>
          <span :class="chip(m.signals.heldSlowLong||m.signals.heldSlowShort)">tiene EMA{{ cfg.emaSlow }}</span>
          <span :class="chip(m.signals.triggerLong||m.signals.triggerShort)">candela rientro</span>
        </div>
      </div>
    </div>

    <!-- Open trade -->
    <div v-if="open" class="bg-surface-50 rounded-xl p-4 border border-white/10">
      <div class="flex items-center justify-between mb-2">
        <div class="text-sm font-bold" :class="open.side==='long'?'text-profit':'text-loss'">
          {{ open.side==='long'?'▲ LONG':'▼ SHORT' }} APERTO <span class="text-[10px] font-mono px-1.5 py-0.5 rounded ml-1" :class="open.mode==='live'?'bg-red-500/20 text-red-400':'bg-surface-200 text-gray-400'">{{ open.mode }}</span>
        </div>
        <button @click="closeOpen" class="text-xs px-2 py-1 rounded bg-surface-200 text-gray-400 hover:text-white">Chiudi</button>
      </div>
      <div class="grid grid-cols-4 gap-2 text-sm font-mono">
        <div><div class="text-[10px] text-gray-500">Entry</div><div class="text-white">{{ fmt(open.entry) }}</div></div>
        <div><div class="text-[10px] text-gray-500">Stop Loss</div><div class="text-loss">{{ fmt(open.stopLoss) }}</div></div>
        <div><div class="text-[10px] text-gray-500">Take Profit</div><div class="text-profit">{{ fmt(open.takeProfit) }}</div></div>
        <div><div class="text-[10px] text-gray-500">PnL vivo</div><div :class="livePnl>=0?'text-profit':'text-loss'">${{ livePnl.toFixed(3) }}</div></div>
      </div>
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-3 md:grid-cols-6 gap-3">
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5"><div class="text-[10px] text-gray-500 uppercase">Trade</div><div class="text-lg font-bold text-white">{{ stats.closed }}</div></div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5"><div class="text-[10px] text-gray-500 uppercase">Win rate</div><div class="text-lg font-bold text-white">{{ stats.winRate }}%</div></div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5"><div class="text-[10px] text-gray-500 uppercase">Win</div><div class="text-lg font-bold text-profit">{{ stats.wins }}</div></div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5"><div class="text-[10px] text-gray-500 uppercase">Loss</div><div class="text-lg font-bold text-loss">{{ stats.losses }}</div></div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5"><div class="text-[10px] text-gray-500 uppercase">Totale R</div><div :class="['text-lg font-bold', stats.totalR>=0?'text-profit':'text-loss']">{{ stats.totalR }}R</div></div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5"><div class="text-[10px] text-gray-500 uppercase">PnL</div><div :class="['text-lg font-bold', stats.pnl>=0?'text-profit':'text-loss']">${{ stats.pnl }}</div></div>
    </div>

    <!-- Config -->
    <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
      <div class="text-xs font-semibold text-gray-400 mb-3">Configurazione</div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label class="text-xs text-gray-400">EMA veloce<input v-model.number="cfg.emaFast" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">EMA media<input v-model.number="cfg.emaMid" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">EMA lenta<input v-model.number="cfg.emaSlow" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">R:R (TP)<input v-model.number="cfg.riskReward" type="number" step="0.1" class="inp" /></label>
        <label class="text-xs text-gray-400">Capitale $<input v-model.number="cfg.capitalUsdt" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">Leva<input v-model.number="cfg.leverage" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">Swing SL (candele)<input v-model.number="cfg.swingLookback" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400 flex flex-col">Solo London/NY
          <button @click="cfg.sessionFilter=!cfg.sessionFilter" :class="['mt-1 px-2 py-1.5 rounded text-xs', cfg.sessionFilter?'bg-brand/30 text-white':'bg-surface-200 text-gray-500']">{{ cfg.sessionFilter?'ON':'OFF' }}</button>
        </label>
      </div>
      <button @click="saveConfig" class="mt-3 px-4 py-2 rounded-lg bg-brand text-white text-sm font-semibold hover:opacity-90">Salva configurazione</button>
    </div>

    <!-- Trades -->
    <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
      <div class="text-xs font-semibold text-gray-400 mb-2">Ultimi trade</div>
      <div v-if="!recent.length" class="text-sm text-gray-500 py-4 text-center">Nessun trade ancora.</div>
      <table v-else class="w-full text-xs">
        <thead><tr class="text-gray-500 text-left"><th class="py-1">Lato</th><th>Mode</th><th>Entry</th><th>Exit</th><th>Esito</th><th class="text-right">R</th><th class="text-right">PnL</th></tr></thead>
        <tbody>
          <tr v-for="t in recent" :key="t.id" class="border-t border-white/5 font-mono">
            <td class="py-1.5" :class="t.side==='long'?'text-profit':'text-loss'">{{ t.side==='long'?'L':'S' }}</td>
            <td class="text-gray-500">{{ t.mode }}</td>
            <td class="text-gray-300">{{ fmt(t.entry) }}</td>
            <td class="text-gray-300">{{ fmt(t.exitPrice) }}</td>
            <td :class="t.status==='win'?'text-profit':t.status==='loss'?'text-loss':'text-gray-400'">{{ t.reason||t.status }}</td>
            <td class="text-right" :class="(t.rMultiple||0)>=0?'text-profit':'text-loss'">{{ (t.rMultiple||0).toFixed(2) }}R</td>
            <td class="text-right" :class="(t.pnl||0)>=0?'text-profit':'text-loss'">${{ (t.pnl||0).toFixed(3) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'

const cfg = ref<any>({ symbol: 'BTC/USDT:USDT', timeframe: '1m', emaFast: 50, emaMid: 100, emaSlow: 200, riskReward: 2, capitalUsdt: 20, leverage: 5, swingLookback: 10, sessionFilter: false, liveEnabled: false })
const m = ref<any>({})
const open = ref<any>(null)
const recent = ref<any[]>([])
const stats = ref<any>({ closed: 0, wins: 0, losses: 0, winRate: 0, totalR: 0, pnl: 0 })
let timer: any = null

const fmt = (v: any) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const chip = (ok: boolean) => ['px-1.5 py-1 rounded text-center', ok ? 'bg-profit/20 text-profit' : 'bg-surface-200 text-gray-600']

const livePnl = computed(() => open.value?.livePnl ?? 0)

async function load() {
  try {
    const { data } = await axios.get('/api/ema-scalper/dashboard')
    cfg.value = data.config
    m.value = data.market || {}
    open.value = data.openTrade
    recent.value = data.recent || []
    stats.value = data.stats
  } catch {}
}
async function saveConfig() { await axios.patch('/api/ema-scalper/config', cfg.value); await load() }
async function toggleLive() { await axios.patch('/api/ema-scalper/config', { liveEnabled: !cfg.value.liveEnabled }); await load() }
async function closeOpen() { await axios.post('/api/ema-scalper/close'); await load() }
async function reset() { if (confirm('Reset di tutti i trade dello scalper?')) { await axios.post('/api/ema-scalper/reset'); await load() } }

onMounted(() => { load(); timer = setInterval(load, 3000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.inp { @apply mt-1 w-full bg-surface-0 border border-white/10 rounded px-2 py-1.5 text-white text-sm font-mono; }
</style>
