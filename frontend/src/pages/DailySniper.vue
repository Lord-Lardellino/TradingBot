<template>
  <div class="p-4 md:p-6 max-w-6xl mx-auto space-y-5">

    <!-- Header -->
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">🎯 Top-Down Daily <span class="text-xs font-mono text-gray-500">{{ cfg.symbol }}</span></h1>
        <p class="text-xs text-gray-500 mt-0.5">Cascata 1W → 1D → 4H → 1H · 1 trade/giorno · rischio {{ cfg.riskPct }}% · TP {{ cfg.riskReward }}R (+{{ (cfg.riskPct*cfg.riskReward).toFixed(0) }}%)</p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="toggleLive" :class="['px-3 py-1.5 rounded-lg text-xs font-semibold border', cfg.liveEnabled ? 'bg-red-500/20 text-red-400 border-red-500/40' : 'bg-surface-200 text-gray-400 border-white/10']">
          {{ cfg.liveEnabled ? '🔴 LIVE ON' : '⚪ Sim' }}
        </button>
        <button @click="reset" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-200 text-gray-400 border border-white/10 hover:text-white">Reset</button>
      </div>
    </div>

    <div v-if="cfg.liveEnabled" class="text-xs bg-red-500/10 border border-red-500/30 text-red-300 rounded-lg px-3 py-2">
      ⚠️ Live ON: al primo setup valido viene aperto un ordine REALE su MEXC con SL/TP nativi.
    </div>

    <!-- Bias multi-TF -->
    <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Prezzo</div>
        <div class="text-lg font-bold text-white font-mono">{{ fmt(m.price) }}</div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">1W Macro</div>
        <div :class="tfClass(m.weekly)">{{ tfLabel(m.weekly) }}</div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">1D Bias</div>
        <div :class="tfClass(m.daily)">{{ tfLabel(m.daily) }}</div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">4H Momentum</div>
        <div :class="tfClass(m.h4)">{{ tfLabel(m.h4) }} <span class="text-[10px] text-gray-500">RSI {{ m.h4?.rsi ?? '—' }}</span></div>
      </div>
      <div class="bg-surface-50 rounded-xl p-3 border border-white/5">
        <div class="text-[10px] text-gray-500 uppercase tracking-wide">Finestra</div>
        <div :class="['text-sm font-bold', m.windowOpen?'text-profit':'text-gray-500']">{{ m.windowOpen ? 'aperta' : 'chiusa (EOD)' }} <span class="text-[10px] text-gray-500">{{ m.utcHour!=null ? m.utcHour+':00 UTC' : '' }}</span></div>
      </div>
    </div>

    <!-- Direzione del giorno + innesco 1H -->
    <div class="grid md:grid-cols-2 gap-4">
      <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
        <div class="text-xs font-semibold text-gray-400 mb-2">Direzione del giorno (confluenza)</div>
        <div :class="['text-lg font-bold', m.bias==='long'?'text-profit':m.bias==='short'?'text-loss':'text-gray-400']">
          {{ m.bias==='long'?'▲ LONG':m.bias==='short'?'▼ SHORT':'— nessuna (TF in conflitto)' }}
        </div>
        <p class="text-[11px] text-gray-500 mt-1">Long solo se 1W + 1D + 4H rialzisti; short se tutti ribassisti.</p>
      </div>
      <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
        <div class="text-xs font-semibold text-gray-400 mb-2">Innesco 1H</div>
        <div v-if="m.trigger" :class="['text-lg font-bold mb-2', m.trigger==='long'?'text-profit':'text-loss']">✅ INNESCO {{ m.trigger==='long'?'LONG':'SHORT' }}</div>
        <div v-else class="text-sm text-gray-500 mb-2">In attesa di pullback EMA20 1H + break struttura</div>
        <div v-if="m.h1" class="grid grid-cols-2 gap-1 text-[10px]">
          <span :class="chip(m.h1.pulledLong||m.h1.pulledShort)">pullback EMA20 1H</span>
          <span :class="chip(m.h1.breakUp||m.h1.breakDown)">break struttura</span>
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
        <label class="text-xs text-gray-400">Capitale $<input v-model.number="cfg.capitalUsdt" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">Rischio %<input v-model.number="cfg.riskPct" type="number" step="0.5" class="inp" /></label>
        <label class="text-xs text-gray-400">R:R (TP)<input v-model.number="cfg.riskReward" type="number" step="0.1" class="inp" /></label>
        <label class="text-xs text-gray-400">Leva<input v-model.number="cfg.leverage" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">Swing SL (candele 1H)<input v-model.number="cfg.swingLookback" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">SL max %<input v-model.number="cfg.maxStopPct" type="number" step="0.1" class="inp" /></label>
        <label class="text-xs text-gray-400">SL min %<input v-model.number="cfg.minStopPct" type="number" step="0.1" class="inp" /></label>
        <label class="text-xs text-gray-400">Flatten ora UTC<input v-model.number="cfg.flattenHour" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">RSI long min<input v-model.number="cfg.rsiLongMin" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400">RSI short max<input v-model.number="cfg.rsiShortMax" type="number" class="inp" /></label>
        <label class="text-xs text-gray-400 flex flex-col">Gate settimanale
          <button @click="cfg.requireWeekly=!cfg.requireWeekly" :class="['mt-1 px-2 py-1.5 rounded text-xs', cfg.requireWeekly?'bg-brand/30 text-white':'bg-surface-200 text-gray-500']">{{ cfg.requireWeekly?'ON':'OFF' }}</button>
        </label>
      </div>
      <button @click="saveConfig" class="mt-3 px-4 py-2 rounded-lg bg-brand text-white text-sm font-semibold hover:opacity-90">Salva configurazione</button>
    </div>

    <!-- Trades -->
    <div class="bg-surface-50 rounded-xl p-4 border border-white/5">
      <div class="text-xs font-semibold text-gray-400 mb-2">Ultimi trade</div>
      <div v-if="!recent.length" class="text-sm text-gray-500 py-4 text-center">Nessun trade ancora.</div>
      <table v-else class="w-full text-xs">
        <thead><tr class="text-gray-500 text-left"><th class="py-1">Data</th><th>Lato</th><th>Mode</th><th>Entry</th><th>Exit</th><th>Esito</th><th class="text-right">R</th><th class="text-right">PnL</th></tr></thead>
        <tbody>
          <tr v-for="t in recent" :key="t.id" class="border-t border-white/5 font-mono">
            <td class="py-1.5 text-gray-500">{{ t.tradeDate }}</td>
            <td :class="t.side==='long'?'text-profit':'text-loss'">{{ t.side==='long'?'L':'S' }}</td>
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

const cfg = ref<any>({ symbol: 'BTC/USDT:USDT', riskReward: 2, capitalUsdt: 100, riskPct: 5, leverage: 5, swingLookback: 6, maxStopPct: 2, minStopPct: 0.4, flattenHour: 21, rsiLongMin: 52, rsiShortMax: 48, requireWeekly: true, liveEnabled: false })
const m = ref<any>({})
const open = ref<any>(null)
const recent = ref<any[]>([])
const stats = ref<any>({ closed: 0, wins: 0, losses: 0, winRate: 0, totalR: 0, pnl: 0 })
let timer: any = null

const fmt = (v: any) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const chip = (ok: boolean) => ['px-1.5 py-1 rounded text-center', ok ? 'bg-profit/20 text-profit' : 'bg-surface-200 text-gray-600']
const tfLabel = (t: any) => !t ? '—' : t.up ? '▲ RIALZO' : t.down ? '▼ RIBASSO' : '— neutro'
const tfClass = (t: any) => ['text-sm font-bold', !t ? 'text-gray-400' : t.up ? 'text-profit' : t.down ? 'text-loss' : 'text-gray-400']

const livePnl = computed(() => open.value?.livePnl ?? 0)

async function load() {
  try {
    const { data } = await axios.get('/api/daily-sniper/dashboard')
    cfg.value = data.config
    m.value = data.market || {}
    open.value = data.openTrade
    recent.value = data.recent || []
    stats.value = data.stats
  } catch {}
}
async function saveConfig() { await axios.patch('/api/daily-sniper/config', cfg.value); await load() }
async function toggleLive() { await axios.patch('/api/daily-sniper/config', { liveEnabled: !cfg.value.liveEnabled }); await load() }
async function closeOpen() { await axios.post('/api/daily-sniper/close'); await load() }
async function reset() { if (confirm('Reset di tutti i trade Top-Down Daily?')) { await axios.post('/api/daily-sniper/reset'); await load() } }

onMounted(() => { load(); timer = setInterval(load, 3000) })
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.inp { @apply mt-1 w-full bg-surface-0 border border-white/10 rounded px-2 py-1.5 text-white text-sm font-mono; }
</style>
