<template>
  <div class="p-3 sm:p-6 space-y-4">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse" />
          Scanner Monitor
          <span class="text-xs font-normal text-gray-500">debug in tempo reale — cosa scannerizza e perché non emette</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Aggiornamento real-time via socket ·
          <span :class="scanning ? 'text-cyan-400 animate-pulse' : 'text-gray-600'">{{ scanning ? '⚡ Scanning...' : '● Idle' }}</span>
        </p>
      </div>
      <Button size="small" icon="pi pi-refresh" label="Aggiorna" severity="secondary" :loading="loading" @click="load" />
    </div>

    <!-- ── Filter Breakdown ──────────────────────────────────────────────── -->
    <div class="stat-card space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-white">Ultimo scan Inst5m</h3>
        <span class="text-xs text-gray-500 font-mono">{{ scannerStatus?.lastScanAt ? timeAgo(scannerStatus.lastScanAt) : '—' }}</span>
      </div>

      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div class="text-center p-2 rounded-lg bg-surface-200">
          <div class="text-lg font-bold font-mono text-white">{{ scannerStatus?.scannedPairs ?? 0 }}</div>
          <div class="text-[10px] text-gray-500">coppie scansionate</div>
        </div>
        <div class="text-center p-2 rounded-lg bg-surface-200">
          <div class="text-lg font-bold font-mono text-red-400">{{ dbg.fetch_err ?? 0 }}</div>
          <div class="text-[10px] text-gray-500">fetch error</div>
        </div>
        <div class="text-center p-2 rounded-lg bg-surface-200">
          <div class="text-lg font-bold font-mono text-yellow-400">{{ dbg.trend_ok ?? 0 }}</div>
          <div class="text-[10px] text-gray-500">trend OK</div>
        </div>
        <div class="text-center p-2 rounded-lg bg-surface-200">
          <div class="text-lg font-bold font-mono text-green-400">{{ scannerStatus?.lastRawSignals ?? 0 }}</div>
          <div class="text-[10px] text-gray-500">segnali emessi</div>
        </div>
      </div>

      <!-- Filter funnel -->
      <div class="space-y-1.5 pt-1">
        <div class="text-[10px] text-gray-600 uppercase tracking-wider mb-2">Funnel filtri (su {{ scannerStatus?.scannedPairs ?? 0 }} pair)</div>
        <FilterBar label="Fetch OK"       :val="(scannerStatus?.scannedPairs ?? 0) - (dbg.fetch_err ?? 0)" :total="scannerStatus?.scannedPairs ?? 1" color="bg-cyan-500" />
        <FilterBar label="Trend OK"       :val="dbg.trend_ok ?? 0"  :total="scannerStatus?.scannedPairs ?? 1" color="bg-blue-500" />
        <FilterBar label="Momentum OK"    :val="dbg.mom_ok ?? 0"    :total="scannerStatus?.scannedPairs ?? 1" color="bg-indigo-500" />
        <FilterBar label="Wick OK"        :val="dbg.wick_ok ?? 0"   :total="scannerStatus?.scannedPairs ?? 1" color="bg-violet-500" />
        <FilterBar label="Volume OK"      :val="dbg.vol_ok ?? 0"    :total="scannerStatus?.scannedPairs ?? 1" color="bg-purple-500" />
        <FilterBar label="Pattern found"  :val="dbg.raw_mom ?? 0"   :total="scannerStatus?.scannedPairs ?? 1" color="bg-yellow-500" />
        <FilterBar label="Score OK → ✅"  :val="scannerStatus?.lastRawSignals ?? 0" :total="scannerStatus?.scannedPairs ?? 1" color="bg-green-500" />
      </div>

      <!-- All debug counters raw -->
      <div class="flex flex-wrap gap-2 pt-2 border-t border-white/5">
        <span v-for="(v, k) in dbg" :key="k"
          class="text-[10px] font-mono px-2 py-0.5 rounded-full bg-surface-200 text-gray-400">
          {{ k }}: <span class="text-white font-semibold">{{ v }}</span>
        </span>
        <span v-if="!Object.keys(dbg).length" class="text-xs text-gray-600">nessun dato — attendi il prossimo scan</span>
      </div>
    </div>

    <!-- ── Trend Candidates ──────────────────────────────────────────────── -->
    <div class="stat-card space-y-3">
      <h3 class="text-sm font-semibold text-white">
        Trend OK ma pattern fallito
        <span class="ml-2 text-[10px] font-normal text-gray-500">{{ trendCandidates.length }} pair</span>
      </h3>
      <div v-if="!trendCandidates.length" class="text-xs text-gray-600 py-4 text-center">
        Nessuna coppia con trend nel ciclo corrente
      </div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left py-1.5 px-2">Symbol</th>
              <th class="text-left py-1.5 px-2">Dir</th>
              <th class="text-left py-1.5 px-2">Perché ha fallito</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in trendCandidates" :key="c.sym + c.dir"
              class="border-b border-white/5 hover:bg-surface-200">
              <td class="py-1.5 px-2 text-white font-semibold">{{ c.sym }}</td>
              <td class="py-1.5 px-2" :class="c.dir === 'L' ? 'text-green-400' : 'text-red-400'">
                {{ c.dir === 'L' ? 'LONG' : 'SHORT' }}
              </td>
              <td class="py-1.5 px-2 text-yellow-400">{{ c.reason }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Near Misses ────────────────────────────────────────────────────── -->
    <div class="stat-card space-y-3">
      <h3 class="text-sm font-semibold text-white">
        Pattern trovato ma bloccato (near miss)
        <span class="ml-2 text-[10px] font-normal text-gray-500">{{ nearMisses.length }} pair</span>
      </h3>
      <div v-if="!nearMisses.length" class="text-xs text-gray-600 py-4 text-center">
        Nessun near miss nel ciclo corrente — o tutti passano, o nessun pattern trovato
      </div>
      <div v-else class="space-y-1">
        <div v-for="nm in nearMisses" :key="nm.sym + nm.dir"
          class="flex items-center gap-3 px-3 py-2 rounded-lg bg-yellow-500/5 border border-yellow-500/20">
          <div :class="['w-12 text-center text-xs font-bold py-0.5 rounded', nm.dir === 'L' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400']">
            {{ nm.dir === 'L' ? 'LONG' : 'SHORT' }}
          </div>
          <div class="font-semibold text-white text-xs">{{ nm.sym }}</div>
          <div class="text-yellow-400 text-xs ml-auto">{{ nm.reason }}</div>
        </div>
      </div>
    </div>

    <!-- ── Last 100 Pairs scanned ─────────────────────────────────────────── -->
    <div class="stat-card space-y-3">
      <h3 class="text-sm font-semibold text-white">
        Coppie scansionate
        <span class="ml-2 text-[10px] font-normal text-gray-500">top {{ lastScanPairs.length }} per volume 24h</span>
      </h3>
      <div class="flex flex-wrap gap-1.5">
        <span v-for="sym in lastScanPairs" :key="sym"
          :class="['text-[10px] font-mono px-2 py-0.5 rounded-full', isNearMiss(sym) ? 'bg-yellow-500/20 text-yellow-400' : isTrendCand(sym) ? 'bg-blue-500/20 text-blue-400' : 'bg-surface-200 text-gray-500']">
          {{ sym }}
        </span>
        <span v-if="!lastScanPairs.length" class="text-xs text-gray-600">nessun dato — attendi il prossimo scan</span>
      </div>
      <div class="flex gap-4 text-[10px] text-gray-500 pt-1">
        <span><span class="inline-block w-2 h-2 rounded-full bg-yellow-400 mr-1" />near miss</span>
        <span><span class="inline-block w-2 h-2 rounded-full bg-blue-400 mr-1" />trend OK</span>
        <span><span class="inline-block w-2 h-2 rounded-full bg-surface-200 mr-1" />nessun pattern</span>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import axios from 'axios'
import { io, Socket } from 'socket.io-client'
import Button from 'primevue/button'

const loading        = ref(false)
const scanning       = ref(false)
const scannerStatus  = ref<any>(null)
const dbg            = ref<Record<string, number>>({})
const trendCandidates= ref<any[]>([])
const nearMisses     = ref<any[]>([])
const lastScanPairs  = ref<string[]>([])

const nearMissSet  = computed(() => new Set(nearMisses.value.map((n: any) => n.sym)))
const trendCandSet = computed(() => new Set(trendCandidates.value.map((n: any) => n.sym)))

function isNearMiss(sym: string)  { return nearMissSet.value.has(sym) }
function isTrendCand(sym: string) { return trendCandSet.value.has(sym) }

function applyStatus(d: any) {
  scannerStatus.value  = d
  dbg.value            = d.debug ?? {}
  trendCandidates.value= d.trendCandidates ?? []
  nearMisses.value     = d.nearMisses ?? []
  lastScanPairs.value  = d.lastScanPairs ?? []
  scanning.value       = d.isScanning ?? false
}

async function load() {
  loading.value = true
  try {
    const { data } = await axios.get('/api/inst-scanner/analytics')
    applyStatus({ ...data.scannerStatus, debug: data.debug, trendCandidates: data.trendCandidates, nearMisses: data.nearMisses, lastScanPairs: data.lastScanPairs })
  } finally { loading.value = false }
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s fa`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m fa`
  return `${Math.floor(m / 60)}h fa`
}

let sock: Socket | null = null
onMounted(async () => {
  await load()
  sock = io('/', { transports: ['websocket', 'polling'] })
  sock.on('inst:status', (d: any) => applyStatus(d))
})
onUnmounted(() => { sock?.disconnect() })
</script>

<script lang="ts">
import { defineComponent, h } from 'vue'

// Inline component per la barra filtri
export const FilterBar = defineComponent({
  props: { label: String, val: Number, total: Number, color: String },
  setup(props) {
    return () => {
      const pct = Math.round(((props.val ?? 0) / Math.max(props.total ?? 1, 1)) * 100)
      return h('div', { class: 'flex items-center gap-2' }, [
        h('div', { class: 'w-28 text-[10px] text-gray-500 text-right shrink-0' }, props.label),
        h('div', { class: 'flex-1 h-3 bg-surface-200 rounded-full overflow-hidden' }, [
          h('div', { class: `h-full rounded-full transition-all ${props.color}`, style: `width:${pct}%` })
        ]),
        h('div', { class: 'w-14 text-[10px] font-mono text-gray-400 text-right' }, `${props.val} (${pct}%)`),
      ])
    }
  }
})
</script>
