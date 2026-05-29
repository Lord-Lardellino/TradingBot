<template>
  <div class="p-3 sm:p-6 space-y-4">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse" />
          ⭐ Morning / Evening Star
          <span class="text-xs font-normal text-gray-500">Price Action + EMA34 · 1m · Top 100</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Scan ogni minuto al :30 ·
          <span :class="status?.isScanning ? 'text-yellow-400 animate-pulse' : 'text-gray-600'">
            {{ status?.isScanning ? '⚡ Scanning...' : '● Idle' }}
          </span>
          <span v-if="status?.lastScanAt" class="ml-2">· {{ timeAgo(status.lastScanAt) }}</span>
          <span v-if="status?.symbols" class="ml-2 text-gray-600">· {{ status.symbols }} coppie</span>
        </p>
      </div>
      <Button size="small" icon="pi pi-refresh" label="Aggiorna" severity="secondary" :loading="store.loading" @click="store.loadAnalytics()" />
    </div>

    <!-- Stats -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono" :class="pnlColor(analytics?.totalPnl)">
          {{ analytics?.totalPnl != null ? (analytics.totalPnl >= 0 ? '+' : '') + analytics.totalPnl.toFixed(2) : '—' }}
        </div>
        <div class="text-sm text-gray-500 mt-1">PnL simulato (USDT)</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-white">{{ analytics?.winRate != null ? analytics.winRate + '%' : '—' }}</div>
        <div class="text-sm text-gray-500 mt-1">Win Rate</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-white">{{ analytics?.closedTrades ?? 0 }}</div>
        <div class="text-sm text-gray-500 mt-1">Trade chiusi</div>
      </div>
      <div class="stat-card text-center">
        <div class="text-3xl font-bold font-mono text-yellow-400">{{ analytics?.openTrades ?? 0 }}</div>
        <div class="text-sm text-gray-500 mt-1">Trade aperti</div>
      </div>
    </div>

    <!-- Config -->
    <div class="stat-card">
      <div class="flex flex-wrap gap-2 items-center">
        <span class="text-sm text-gray-500">Config:</span>
        <button @click="store.toggleEnabled()"
          :class="['text-sm px-3 py-1 rounded-full font-medium transition', analytics?.config?.enabled ? 'bg-yellow-500/20 text-yellow-400' : 'bg-surface-200 text-gray-500']">
          {{ analytics?.config?.enabled ? '⚡ Scan ON' : '⏸ Scan OFF' }}
        </button>
        <button @click="store.toggleAutoEnter()"
          :class="['text-sm px-3 py-1 rounded-full font-medium transition', analytics?.config?.autoEnter ? 'bg-green-500/20 text-green-400' : 'bg-surface-200 text-gray-500']">
          {{ analytics?.config?.autoEnter ? '📊 Sim ON' : '📊 Sim OFF' }}
        </button>
        <button @click="store.toggleLive()"
          :class="['text-sm px-3 py-1 rounded-full font-medium transition', analytics?.config?.liveEnabled ? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/40' : 'bg-surface-200 text-gray-500']">
          {{ analytics?.config?.liveEnabled ? '🔴 LIVE ON' : '⚫ Live OFF' }}
        </button>
        <span v-if="analytics?.config?.liveEnabled" class="text-xs text-red-400 font-medium animate-pulse">⚠ ordini reali</span>
        <span class="text-xs text-gray-600 font-mono ml-2">
          RR {{ analytics?.config?.tpRr ?? 1.5 }} · risk {{ analytics?.config?.riskUsdt ?? 0.1 }}$
        </span>
        <button @click="store.resetSim()" class="ml-auto text-sm px-3 py-1 rounded text-gray-600 hover:text-red-400 transition">Reset sim</button>
      </div>
    </div>

    <!-- Debug -->
    <div v-if="status?.debug && Object.keys(status.debug).length" class="stat-card">
      <div class="text-xs text-gray-500 mb-2">Debug filtri</div>
      <div class="flex flex-wrap gap-2">
        <span v-for="(v, k) in status.debug" :key="String(k)"
          :class="['text-xs font-mono px-2 py-0.5 rounded', String(k) === 'ok' ? 'bg-green-500/20 text-green-400' : 'bg-surface-200 text-gray-500']">
          {{ k }}: {{ v }}
        </span>
      </div>
    </div>

    <!-- Posizioni aperte -->
    <div v-if="openTrades.length" class="stat-card">
      <div class="text-sm text-gray-400 mb-3 font-medium">Posizioni aperte ({{ openTrades.length }})</div>
      <div class="space-y-2">
        <div v-for="t in openTrades" :key="t.id"
          class="flex items-center justify-between text-xs font-mono bg-surface-100 rounded-lg px-3 py-2 cursor-pointer hover:bg-surface-200 transition"
          @click="openDialog(t)">
          <div class="flex items-center gap-2">
            <span :class="t.direction === 'LONG' ? 'text-green-400' : 'text-red-400'" class="font-bold">{{ t.direction }}</span>
            <span class="text-white">{{ t.symbol?.replace('/USDT:USDT','') }}</span>
            <span class="text-yellow-400">{{ t.starCount }}★</span>
          </div>
          <div class="flex items-center gap-4">
            <span class="text-gray-400">SL {{ Number(t.slPct)?.toFixed(2) }}%</span>
            <span :class="Number(positions[t.id]?.unrealizedPnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
              {{ positions[t.id] ? ((Number(positions[t.id].unrealizedPnl) >= 0 ? '+' : '') + Number(positions[t.id].unrealizedPnl)?.toFixed(4)) : '—' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Segnali recenti -->
    <div class="stat-card">
      <div class="text-sm text-gray-400 mb-3 font-medium">Segnali recenti</div>
      <div v-if="store.signals.length" class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Symbol</th>
              <th class="text-left pb-2">Dir</th>
              <th class="text-right pb-2">⭐</th>
              <th class="text-right pb-2">Entry</th>
              <th class="text-right pb-2">SL%</th>
              <th class="text-right pb-2">Vol</th>
              <th class="text-right pb-2">Score</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in store.signals.slice(0,20)" :key="s.id"
              class="border-b border-white/3 hover:bg-surface-100 cursor-pointer transition"
              @click="openDialog(s)">
              <td class="py-1.5 text-white">{{ s.symbol?.replace('/USDT:USDT','') }}</td>
              <td class="py-1.5" :class="s.direction === 'LONG' ? 'text-green-400' : 'text-red-400'">{{ s.direction }}</td>
              <td class="py-1.5 text-right text-yellow-400">{{ s.starCount }}★</td>
              <td class="py-1.5 text-right text-gray-300">{{ s.entry }}</td>
              <td class="py-1.5 text-right text-gray-400">{{ Number(s.slPct)?.toFixed(2) }}%</td>
              <td class="py-1.5 text-right text-gray-400">{{ Number(s.volumeRatio)?.toFixed(1) }}x</td>
              <td class="py-1.5 text-right" :class="s.score >= 80 ? 'text-yellow-400' : s.score >= 60 ? 'text-sky-400' : 'text-gray-400'">
                {{ s.score }} <span class="text-gray-600">{{ s.grade }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="text-center py-6 text-gray-600">
        Nessun segnale Morning/Evening Star — attesa pattern...
      </div>
    </div>

    <!-- Trade history -->
    <div v-if="closedTrades.length" class="stat-card">
      <div class="text-sm text-gray-400 mb-3 font-medium">Ultimi trade chiusi</div>
      <div class="overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <thead>
            <tr class="text-gray-600 border-b border-white/5">
              <th class="text-left pb-2">Symbol</th>
              <th class="text-left pb-2">Dir</th>
              <th class="text-right pb-2">Esito</th>
              <th class="text-right pb-2">PnL</th>
              <th class="text-right pb-2">SL%</th>
              <th class="text-right pb-2">⭐</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in closedTrades.slice(0,30)" :key="t.id"
              class="border-b border-white/3 hover:bg-surface-100 cursor-pointer transition"
              @click="openDialog(t)">
              <td class="py-1.5 text-white">{{ t.symbol?.replace('/USDT:USDT','') }}</td>
              <td class="py-1.5" :class="t.direction === 'LONG' ? 'text-green-400' : 'text-red-400'">{{ t.direction }}</td>
              <td class="py-1.5 text-right" :class="t.status === 'tp' ? 'text-green-400' : 'text-red-400'">
                {{ t.status === 'tp' ? '✅ TP' : '❌ SL' }}
              </td>
              <td class="py-1.5 text-right" :class="Number(t.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'">
                {{ t.pnl != null ? ((Number(t.pnl) >= 0 ? '+' : '') + Number(t.pnl).toFixed(3)) : '—' }}
              </td>
              <td class="py-1.5 text-right text-gray-400">{{ Number(t.slPct)?.toFixed(2) }}%</td>
              <td class="py-1.5 text-right text-yellow-400">{{ t.starCount }}★</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ══════════ DIALOG GRAFICO ══════════ -->
    <Teleport to="body">
      <Transition name="dialog">
        <div v-if="selected" class="fixed inset-0 z-50 flex items-start justify-center p-4 pt-8 overflow-y-auto" @click.self="closeDialog">
          <div class="absolute inset-0 bg-black/85 backdrop-blur-sm" @click="closeDialog" />
          <div class="relative z-10 w-full max-w-5xl rounded-2xl bg-[#0d0f14] border border-white/10 shadow-2xl mb-8">

            <!-- Header dialog -->
            <div class="flex items-center gap-3 px-6 py-4 border-b border-white/8 sticky top-0 z-10 bg-[#0d0f14] rounded-t-2xl">
              <span class="text-2xl font-black text-white">{{ selected.symbol?.replace('/USDT:USDT','') }}</span>
              <span :class="['text-sm font-black px-3 py-1 rounded-xl', selected.direction === 'LONG' ? 'bg-green-500/25 text-green-400' : 'bg-red-500/25 text-red-400']">
                {{ selected.direction }}
              </span>
              <span class="text-yellow-400 font-bold">{{ selected.starCount }}★</span>
              <span class="text-xs font-mono px-2 py-1 rounded bg-yellow-500/15 text-yellow-300">
                EMA34 slope {{ Number(selected.emaSlope) >= 0 ? '+' : '' }}{{ Number(selected.emaSlope)?.toFixed(3) }}%
              </span>
              <span class="text-gray-400 text-sm">Score <span class="text-white font-bold text-lg">{{ selected.score }}</span></span>
              <div class="ml-auto flex items-center gap-3">
                <span class="text-sm text-gray-500">{{ timeAgo(selected.timestamp ?? selected.openedAt) }}</span>
                <button class="text-gray-500 hover:text-white transition p-1" @click="closeDialog">
                  <i class="pi pi-times text-lg" />
                </button>
              </div>
            </div>

            <div class="p-6 space-y-5">

              <!-- Grafico -->
              <div class="relative rounded-xl overflow-hidden bg-black/30 border border-white/5" style="height: 420px">
                <div v-if="chartLoading" class="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
                  <i class="pi pi-spin pi-spinner mr-2" /> Caricamento grafico...
                </div>
                <div ref="chartContainer" class="w-full h-full" />
              </div>

              <!-- Legenda -->
              <div class="flex flex-wrap gap-3 text-xs font-mono">
                <span class="flex items-center gap-1.5"><span class="w-4 h-0.5 bg-yellow-400 inline-block" />EMA34</span>
                <span class="flex items-center gap-1.5"><span class="w-4 h-0.5 bg-white inline-block" />Entry {{ selected.entry }}</span>
                <span class="flex items-center gap-2">
                  <span class="w-4 h-3 rounded-sm inline-block" style="background:rgba(239,68,68,0.25)" />
                  SL {{ selected.stopLoss }} (−{{ Number(selected.slPct)?.toFixed(2) }}%)
                </span>
                <span class="flex items-center gap-2">
                  <span class="w-4 h-3 rounded-sm inline-block" style="background:rgba(34,197,94,0.25)" />
                  TP {{ selected.takeProfit }} (+{{ Number(selected.tpPct)?.toFixed(2) }}%)
                </span>
              </div>

              <!-- Info grid -->
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div class="rounded-xl bg-black/30 border border-white/5 p-4 space-y-3">
                  <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Livelli trade</div>
                  <div><div class="text-xs text-gray-500">Entry</div><div class="text-xl font-black text-white font-mono">{{ selected.entry }}</div></div>
                  <div><div class="text-xs text-red-400/70">Stop Loss</div><div class="text-xl font-black text-red-400 font-mono">{{ selected.stopLoss }} <span class="text-sm text-red-500/60">−{{ Number(selected.slPct)?.toFixed(2) }}%</span></div></div>
                  <div><div class="text-xs text-green-400/70">Take Profit</div><div class="text-xl font-black text-green-400 font-mono">{{ selected.takeProfit }} <span class="text-sm text-green-500/60">+{{ Number(selected.tpPct)?.toFixed(2) }}%</span></div></div>
                  <div class="pt-2 border-t border-white/5 flex gap-4">
                    <div class="text-center"><div class="text-xs text-gray-500">RR</div><div class="text-lg font-black text-white">{{ rrRatio(selected).toFixed(2) }}R</div></div>
                    <div class="text-center"><div class="text-xs text-gray-500">Leva</div><div class="text-lg font-black text-white">{{ selected.suggestedLeverage ?? selected.leverage }}x</div></div>
                  </div>
                </div>
                <div class="rounded-xl bg-black/30 border border-white/5 p-4 space-y-3">
                  <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Pattern</div>
                  <div class="text-center py-2">
                    <div class="text-5xl font-black text-yellow-400">{{ selected.starCount }}★</div>
                    <div class="text-xs text-gray-500 mt-1">Star candle{{ selected.starCount > 1 ? 's' : '' }}</div>
                  </div>
                  <div class="text-center py-2 border-t border-white/5">
                    <div class="text-xs text-gray-500">Tipo</div>
                    <div class="text-lg font-black text-white">{{ selected.direction === 'SHORT' ? 'Evening Star' : 'Morning Star' }}</div>
                  </div>
                </div>
                <div class="rounded-xl bg-black/30 border border-white/5 p-4 space-y-3">
                  <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Metriche</div>
                  <div>
                    <div class="text-xs text-gray-500">Volume ratio</div>
                    <div class="text-2xl font-black text-white font-mono">{{ Number(selected.volumeRatio)?.toFixed(2) }}x</div>
                  </div>
                  <div class="border-t border-white/5 pt-2">
                    <div class="text-xs text-gray-500">EMA34 slope</div>
                    <div :class="['text-xl font-black font-mono', Number(selected.emaSlope) >= 0 ? 'text-green-400' : 'text-red-400']">
                      {{ Number(selected.emaSlope) >= 0 ? '+' : '' }}{{ Number(selected.emaSlope)?.toFixed(3) }}%
                    </div>
                  </div>
                </div>
              </div>

              <!-- Reasons -->
              <div class="rounded-xl bg-black/30 border border-white/5 p-4">
                <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-3">Confluenze</div>
                <div class="flex flex-wrap gap-2">
                  <span v-for="r in selected.reasons" :key="r" class="text-sm font-mono px-3 py-1.5 rounded-lg bg-white/5 text-gray-300 border border-white/5">{{ r }}</span>
                </div>
              </div>

            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, nextTick } from 'vue'
import { useStarScannerStore } from '@/stores/star-scanner'
import Button from 'primevue/button'
import axios from 'axios'
import { createChart, CrosshairMode, LineStyle, type IChartApi } from 'lightweight-charts'

const store       = useStarScannerStore()
const analytics   = computed(() => store.analytics)
const status      = computed(() => store.analytics?.scannerStatus)
const positions   = computed(() => store.positions)
const openTrades  = computed(() => store.analytics?.openTradesList  ?? [])
const closedTrades = computed(() => store.analytics?.closedTradesList ?? [])

// ── Dialog & chart ────────────────────────────────────────────────────────────
const selected       = ref<any>(null)
const chartLoading   = ref(false)
const chartContainer = ref<HTMLElement | null>(null)
let chartInstance: IChartApi | null = null
let chartState: any = null
let liveTimer: ReturnType<typeof setInterval> | null = null
let resizeObs: ResizeObserver | null = null

function isLive(sig: any) { return !sig.closedAt && !['tp','sl','manual'].includes(String(sig.status ?? '').toLowerCase()) }

function candlesUrl(sig: any) {
  const sym  = encodeURIComponent(sig.symbol)
  const anchor = new Date(sig.openedAt ?? sig.timestamp ?? Date.now()).getTime()
  const from = Number.isFinite(anchor) ? Math.max(0, anchor - 45 * 60_000) : undefined
  return from
    ? `/api/star-scanner/candles/${sym}?limit=220&from=${from}${isLive(sig) ? '&live=1' : ''}`
    : `/api/star-scanner/candles/${sym}?limit=160${isLive(sig) ? '&live=1' : ''}`
}

async function openDialog(item: any) {
  selected.value = { ...item, stopLoss: Number(item.stopLoss), emaSlope: Number(item.emaSlope ?? 0) }
  await nextTick()
  await buildChart(selected.value)
}

function closeDialog() {
  if (liveTimer) clearInterval(liveTimer)
  liveTimer = null
  resizeObs?.disconnect(); resizeObs = null
  chartInstance?.remove(); chartInstance = null
  chartState = null
  selected.value = null
}

async function buildChart(sig: any) {
  if (!chartContainer.value) return
  if (liveTimer) clearInterval(liveTimer)
  chartInstance?.remove(); chartInstance = null

  chartLoading.value = true
  let candles: any[] = []
  try { const { data } = await axios.get(candlesUrl(sig)); candles = Array.isArray(data) ? data : [] } catch {}
  chartLoading.value = false
  if (!candles.length || !chartContainer.value) return

  const chart = createChart(chartContainer.value, {
    layout:    { background: { color: 'transparent' }, textColor: '#9ca3af' },
    grid:      { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: '#1f2937' },
    timeScale: { borderColor: '#1f2937', timeVisible: true, secondsVisible: false },
    width:  chartContainer.value.clientWidth,
    height: chartContainer.value.clientHeight,
  })
  chartInstance = chart

  const cs = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
  cs.setData(candles.map((c: any) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))

  const emaLine = chart.addLineSeries({ color: '#facc15', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: 'EMA34' })
  const emaData = candles.filter((c: any) => c.ema34 != null).map((c: any) => ({ time: c.time, value: c.ema34 }))
  if (emaData.length) emaLine.setData(emaData)

  const t0 = candles[0]?.time as any
  const t1 = (candles[candles.length - 1]?.time ?? 0) + 60
  const isLong = sig.direction === 'LONG'

  const addBaseline = (fill: string, isTop: boolean) => chart.addBaselineSeries({
    baseValue: { type: 'price', price: sig.entry },
    topFillColor1:    isTop ? fill : 'transparent', topFillColor2:    isTop ? fill.replace('0.22','0.06') : 'transparent',
    bottomFillColor1: !isTop ? fill : 'transparent', bottomFillColor2: !isTop ? fill.replace('0.22','0.06') : 'transparent',
    topLineColor: 'transparent', bottomLineColor: 'transparent', lineWidth: 0 as any,
    priceLineVisible: false, lastValueVisible: false,
  } as any)

  const slBox = addBaseline('rgba(239,68,68,0.22)', !isLong)
  slBox.setData([{ time: t0, value: sig.stopLoss }, { time: t1 as any, value: sig.stopLoss }])
  const tpBox = addBaseline('rgba(34,197,94,0.22)', isLong)
  tpBox.setData([{ time: t0, value: sig.takeProfit }, { time: t1 as any, value: sig.takeProfit }])

  const addLine = (price: number, color: string, style: LineStyle) => {
    if (!price) return
    const s = chart.addLineSeries({ color, lineWidth: 1 as any, lineStyle: style, priceLineVisible: false, lastValueVisible: false })
    s.setData([{ time: t0, value: price }, { time: t1 as any, value: price }])
  }
  addLine(sig.entry,      '#ffffff', LineStyle.Dashed)
  addLine(sig.stopLoss,   '#ef4444', LineStyle.Dashed)
  addLine(sig.takeProfit, '#22c55e', LineStyle.Dashed)

  chartState = { sig, cs, ema: emaLine }
  chart.timeScale().fitContent()
  if (isLive(sig)) chart.timeScale().scrollToRealTime()

  resizeObs = new ResizeObserver(() => { if (chartContainer.value) chart.resize(chartContainer.value.clientWidth, chartContainer.value.clientHeight) })
  if (chartContainer.value) resizeObs.observe(chartContainer.value)

  if (isLive(sig)) {
    liveTimer = setInterval(async () => {
      if (!selected.value) return
      try {
        const { data } = await axios.get(candlesUrl(sig))
        if (Array.isArray(data) && data.length && chartState) {
          chartState.cs.setData(data.map((c: any) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
          const ed = data.filter((c: any) => c.ema34 != null).map((c: any) => ({ time: c.time, value: c.ema34 }))
          if (ed.length) chartState.ema.setData(ed)
          chart.timeScale().scrollToRealTime()
        }
      } catch {}
    }, 3000)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const pnlColor = (v?: number) => v == null ? 'text-gray-400' : v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400'
const rrRatio  = (s: any) => s?.tpPct && s?.slPct ? Number(s.tpPct) / Number(s.slPct) : 0
const timeAgo  = (iso?: string) => {
  if (!iso) return ''
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s fa`
  if (s < 3600) return `${Math.floor(s / 60)}m fa`
  return `${Math.floor(s / 3600)}h fa`
}

onMounted(() => { store.connect(); store.loadAnalytics() })
onUnmounted(() => { store.disconnect(); closeDialog() })
</script>
