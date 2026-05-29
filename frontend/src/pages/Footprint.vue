<template>
  <div class="p-3 sm:p-6 space-y-4">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <span class="inline-block w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse" />
          Footprint VWAP 1m
          <span class="text-xs font-normal text-gray-500">Range consolidation + delta breakout · 1m · 10 coppie fisse</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Scan ogni minuto ·
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
        <button @click="toggleEnabled"
          :class="['text-sm px-3 py-1 rounded-full font-medium transition', analytics?.config?.enabled ? 'bg-yellow-500/20 text-yellow-400' : 'bg-surface-200 text-gray-500']">
          {{ analytics?.config?.enabled ? '⚡ Scan ON' : '⏸ Scan OFF' }}
        </button>
        <button @click="toggleAutoEnter"
          :class="['text-sm px-3 py-1 rounded-full font-medium transition', analytics?.config?.autoEnter ? 'bg-green-500/20 text-green-400' : 'bg-surface-200 text-gray-500']">
          {{ analytics?.config?.autoEnter ? '📊 Sim ON' : '📊 Sim OFF' }}
        </button>
        <span class="text-xs text-gray-600 font-mono ml-2">
          range×{{ analytics?.config?.tpRangeMultiplier ?? 2 }} · risk {{ analytics?.config?.riskUsdt ?? 1 }}$
          · delta ≥{{ analytics?.config?.minDeltaRatio ?? 0.3 }}
          · range ≥{{ analytics?.config?.minRangePct ?? 0.1 }}%
          · score ≥{{ analytics?.config?.minScore ?? 60 }}
        </span>
        <button @click="store.resetSim()" class="ml-auto text-sm px-3 py-1 rounded text-gray-600 hover:text-red-400 transition">Reset sim</button>
        <button @click="showConfig = !showConfig" class="text-gray-500 hover:text-white text-sm">⚙️</button>
      </div>

      <!-- Config panel collassabile -->
      <div v-if="showConfig" class="mt-3 pt-3 border-t border-white/5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Risk USDT</label>
          <InputNumber v-model="cfg.riskUsdt" :min="0.1" :step="0.5" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ riskUsdt: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">TP Range Mult</label>
          <InputNumber v-model="cfg.tpRangeMultiplier" :min="0.1" :step="0.1" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ tpRangeMultiplier: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Min Delta Ratio</label>
          <InputNumber v-model="cfg.minDeltaRatio" :min="0" :step="0.01" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ minDeltaRatio: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Min Volume Ratio</label>
          <InputNumber v-model="cfg.minVolumeRatio" :min="0" :step="0.01" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ minVolumeRatio: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Range Threshold %</label>
          <InputNumber v-model="cfg.rangeThresholdPct" :min="0" :step="0.01" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ rangeThresholdPct: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Min Range %</label>
          <InputNumber v-model="cfg.minRangePct" :min="0" :step="0.01" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ minRangePct: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Min SL %</label>
          <InputNumber v-model="cfg.minSlPct" :min="0" :step="0.01" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ minSlPct: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Max SL %</label>
          <InputNumber v-model="cfg.maxSlPct" :min="0" :step="0.01" :maxFractionDigits="2" @update:modelValue="v => store.updateConfig({ maxSlPct: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Leverage</label>
          <InputNumber v-model="cfg.leverage" :min="1" :step="1" :maxFractionDigits="0" @update:modelValue="v => store.updateConfig({ leverage: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Max Concurrent</label>
          <InputNumber v-model="cfg.maxConcurrent" :min="1" :step="1" :maxFractionDigits="0" @update:modelValue="v => store.updateConfig({ maxConcurrent: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Min Score</label>
          <InputNumber v-model="cfg.minScore" :min="0" :step="1" :maxFractionDigits="0" @update:modelValue="v => store.updateConfig({ minScore: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Range Lookback</label>
          <InputNumber v-model="cfg.rangeLookback" :min="1" :step="1" :maxFractionDigits="0" @update:modelValue="v => store.updateConfig({ rangeLookback: v })" />
        </div>
        <div class="flex flex-col gap-1">
          <label class="text-xs text-gray-500">Cooldown (min)</label>
          <InputNumber v-model="cfg.cooldownMinutes" :min="0" :step="1" :maxFractionDigits="0" @update:modelValue="v => store.updateConfig({ cooldownMinutes: v })" />
        </div>
        <div class="flex items-center justify-between gap-2 bg-black/20 rounded-lg px-3 py-2">
          <span class="text-xs text-gray-400">Scan ON</span>
          <ToggleSwitch v-model="cfg.enabled" @update:modelValue="v => store.updateConfig({ enabled: v })" />
        </div>
        <div class="flex items-center justify-between gap-2 bg-black/20 rounded-lg px-3 py-2">
          <span class="text-xs text-gray-400">Sim ON</span>
          <ToggleSwitch v-model="cfg.autoEnter" @update:modelValue="v => store.updateConfig({ autoEnter: v })" />
        </div>
        <div class="flex items-center justify-between gap-2 bg-black/20 rounded-lg px-3 py-2">
          <span class="text-xs text-gray-400">Live</span>
          <ToggleSwitch v-model="cfg.liveEnabled" @update:modelValue="v => store.updateConfig({ liveEnabled: v })" />
        </div>
      </div>
    </div>

    <!-- Debug -->
    <div v-if="status?.debug && Object.keys(status.debug).length" class="stat-card">
      <div class="text-xs text-gray-500 mb-2">Debug filtri</div>
      <div class="flex flex-wrap gap-2">
        <span v-for="(v, k) in status.debug" :key="k"
          :class="['text-xs font-mono px-2 py-1 rounded-full', String(k) === 'ok' ? 'bg-green-500/15 text-green-400' : 'bg-surface-200 text-gray-400']">
          {{ k }}: <span class="font-semibold text-white">{{ v }}</span>
        </span>
      </div>
    </div>

    <!-- Segnali -->
    <div class="stat-card space-y-2">
      <h3 class="text-base font-semibold text-white">
        Segnali recenti
        <span class="ml-2 text-xs font-normal text-gray-500">{{ store.signals.length }} · clicca per grafico con box SL/TP</span>
      </h3>
      <div v-if="!store.signals.length" class="text-sm text-gray-600 py-6 text-center">Nessun segnale — scan ogni minuto</div>
      <div v-else class="space-y-1.5">
        <button v-for="sig in store.signals.slice(0, 30)" :key="sig.id"
          class="w-full text-left rounded-xl border border-white/5 bg-black/20 hover:bg-black/40 hover:border-white/10 transition px-4 py-3 flex items-center gap-3 flex-wrap"
          @click="openDialog(sig)">
          <span class="text-base font-black text-white w-14">{{ sig.symbol.replace('/USDT:USDT', '') }}</span>
          <span :class="['text-sm font-bold px-2.5 py-0.5 rounded-lg', sig.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400']">{{ sig.direction }}</span>
          <span :class="gradeBadge(sig.grade)">{{ sig.grade }}</span>
          <span class="text-xs font-mono px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-300">
            range {{ sig.rangeSize?.toFixed(3) }}%
          </span>
          <span class="text-sm font-mono text-gray-300 ml-1">{{ sig.entry }}</span>
          <span class="text-sm font-mono text-red-400">SL {{ sig.slPct?.toFixed(2) }}%</span>
          <span class="text-sm font-mono text-green-400">TP {{ sig.tpPct?.toFixed(2) }}%</span>
          <span class="text-sm font-mono text-gray-400">Vol {{ sig.volumeRatio?.toFixed(2) }}x</span>
          <span class="text-sm text-white font-semibold ml-1">{{ sig.score }}pt</span>
          <span class="ml-auto text-xs text-gray-600">{{ timeAgo(sig.timestamp) }}</span>
          <i class="pi pi-chart-line text-yellow-500 text-sm" />
        </button>
      </div>
    </div>

    <!-- Trade aperti -->
    <div v-if="openTrades.length" class="stat-card space-y-2">
      <h3 class="text-base font-semibold text-white">Trade simulati aperti</h3>
      <button v-for="t in openTrades" :key="t.id" type="button"
        class="w-full text-left flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-200 border border-white/5 hover:bg-black/35 hover:border-yellow-400/25 transition flex-wrap"
        @click="openTradeDialog(t)">
        <span :class="['w-16 text-center text-sm font-bold py-1 rounded-lg', t.direction === 'LONG' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400']">{{ t.direction }}</span>
        <span class="font-bold text-white text-base">{{ t.symbol.replace('/USDT:USDT', '') }}</span>
        <span class="text-xs font-mono text-yellow-300 px-2 py-0.5 rounded-full bg-yellow-500/10">range {{ Number(t.rangeSize).toFixed(3) }}%</span>
        <div class="flex gap-4 text-sm font-mono">
          <span>Entry <span class="text-white font-bold">{{ t.entry }}</span></span>
          <span>SL <span class="text-red-400 font-bold">{{ t.stopLoss }}</span></span>
          <span>TP <span class="text-green-400 font-bold">{{ t.takeProfit }}</span></span>
          <span v-if="store.positions[t.id]?.currentR != null" class="text-yellow-400 font-bold">{{ store.positions[t.id].currentR }}R</span>
        </div>
        <span class="ml-auto text-lg font-bold font-mono" :class="pnlColor(store.positions[t.id]?.unrealizedPnl)">
          {{ store.positions[t.id]?.unrealizedPnl != null ? (store.positions[t.id].unrealizedPnl >= 0 ? '+' : '') + store.positions[t.id].unrealizedPnl.toFixed(3) + ' $' : '—' }}
        </span>
        <i class="pi pi-chart-line text-yellow-500 text-sm" />
      </button>
    </div>

    <!-- Trade chiusi -->
    <div class="stat-card space-y-2">
      <h3 class="text-base font-semibold text-white">
        Ultimi trade chiusi
        <span class="ml-2 text-xs font-normal text-gray-500">{{ analytics?.closedTrades ?? 0 }} totali</span>
      </h3>
      <div v-if="!closedTrades.length" class="text-sm text-gray-600 py-6 text-center">Nessun trade chiuso ancora</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm font-mono">
          <thead>
            <tr class="text-xs text-gray-500 uppercase tracking-wider border-b border-white/5">
              <th class="text-left py-2 px-3">Symbol</th>
              <th class="text-left py-2 px-3">Dir</th>
              <th class="text-right py-2 px-3">Grade</th>
              <th class="text-right py-2 px-3">Range%</th>
              <th class="text-right py-2 px-3">Vol</th>
              <th class="text-right py-2 px-3">Score</th>
              <th class="text-right py-2 px-3">SL%</th>
              <th class="text-right py-2 px-3">PnL</th>
              <th class="text-right py-2 px-3">Status</th>
              <th class="text-right py-2 px-3">Chiuso</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in closedTrades.slice(0, 100)" :key="t.id"
              class="border-b border-white/5 hover:bg-surface-200 cursor-pointer" @click="openTradeDialog(t)">
              <td class="py-2.5 px-3 font-bold text-white text-base">{{ t.symbol.replace('/USDT:USDT', '') }}</td>
              <td class="py-2.5 px-3 font-bold" :class="t.direction === 'LONG' ? 'text-green-400' : 'text-red-400'">{{ t.direction }}</td>
              <td class="py-2.5 px-3 text-right"><span :class="gradeBadge(t.grade)">{{ t.grade }}</span></td>
              <td class="py-2.5 px-3 text-right text-yellow-400">{{ Number(t.rangeSize).toFixed(3) }}%</td>
              <td class="py-2.5 px-3 text-right text-white">{{ Number(t.volumeRatio).toFixed(2) }}x</td>
              <td class="py-2.5 px-3 text-right text-gray-400">{{ t.score }}pt</td>
              <td class="py-2.5 px-3 text-right text-yellow-400">{{ Number(t.slPct).toFixed(2) }}%</td>
              <td class="py-2.5 px-3 text-right font-bold text-base" :class="pnlColor(t.pnl)">{{ t.pnl != null ? (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(3) : '—' }}</td>
              <td class="py-2.5 px-3 text-right font-bold" :class="t.status === 'tp' ? 'text-green-400' : 'text-red-400'">{{ t.status?.toUpperCase() }}</td>
              <td class="py-2.5 px-3 text-right text-gray-500">{{ t.closedAt ? timeAgo(t.closedAt) : '—' }}<i class="pi pi-chart-line text-yellow-500 text-xs ml-2" /></td>
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
            <div class="flex items-center gap-3 px-6 py-4 border-b border-white/8 sticky top-0 z-10 bg-[#0d0f14] rounded-t-2xl">
              <span class="text-2xl font-black text-white">{{ selected.symbol.replace('/USDT:USDT', '') }}</span>
              <span :class="['text-sm font-black px-3 py-1 rounded-xl', selected.direction === 'LONG' ? 'bg-green-500/25 text-green-400' : 'bg-red-500/25 text-red-400']">{{ selected.direction }}</span>
              <span :class="gradeBadge(selected.grade)">{{ selected.grade }}</span>
              <span class="text-xs font-mono px-2 py-1 rounded bg-yellow-500/15 text-yellow-300">range {{ selected.rangeSize?.toFixed(3) }}%</span>
              <span class="text-gray-400 text-sm">Score <span class="text-white font-bold text-lg">{{ selected.score }}</span></span>
              <div class="ml-auto flex items-center gap-3">
                <span class="text-sm text-gray-500">{{ timeAgo(selected.timestamp) }}</span>
                <button class="text-gray-500 hover:text-white transition p-1" @click="closeDialog"><i class="pi pi-times text-lg" /></button>
              </div>
            </div>
            <div class="p-6 space-y-5">
              <div class="relative rounded-xl overflow-hidden bg-black/30 border border-white/5" style="height: 420px">
                <div v-if="chartLoading" class="absolute inset-0 flex items-center justify-center text-gray-500 text-sm"><i class="pi pi-spin pi-spinner mr-2" /> Caricamento grafico...</div>
                <div ref="chartContainer" class="w-full h-full" />
              </div>
              <div class="flex flex-wrap gap-3 text-xs font-mono">
                <span class="flex items-center gap-1.5"><span class="w-4 h-0.5 bg-white inline-block" />Entry {{ selected.entry }}</span>
                <span class="flex items-center gap-2"><span class="w-4 h-3 rounded-sm inline-block" style="background: rgba(239,68,68,0.25)" />SL {{ selected.stopLoss }} (−{{ selected.slPct?.toFixed(2) }}%)</span>
                <span class="flex items-center gap-2"><span class="w-4 h-3 rounded-sm inline-block" style="background: rgba(34,197,94,0.25)" />TP {{ selected.takeProfit }} (+{{ selected.tpPct?.toFixed(2) }}%)</span>
              </div>
              <div class="grid grid-cols-3 gap-4">
                <div class="rounded-xl bg-black/30 border border-white/5 p-4 space-y-3">
                  <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Livelli trade</div>
                  <div><div class="text-xs text-gray-500 mb-0.5">Entry</div><div class="text-xl font-black text-white font-mono">{{ selected.entry }}</div></div>
                  <div><div class="text-xs text-red-400/70 mb-0.5">Stop Loss</div><div class="text-xl font-black text-red-400 font-mono">{{ selected.stopLoss }}<span class="text-sm text-red-500/60 ml-1">−{{ selected.slPct?.toFixed(2) }}%</span></div></div>
                  <div><div class="text-xs text-green-400/70 mb-0.5">Take Profit</div><div class="text-xl font-black text-green-400 font-mono">{{ selected.takeProfit }}<span class="text-sm text-green-500/60 ml-1">+{{ selected.tpPct?.toFixed(2) }}%</span></div></div>
                  <div class="pt-2 border-t border-white/5 flex gap-4 text-center">
                    <div><div class="text-xs text-gray-500">RR</div><div class="text-lg font-black text-white">{{ rrRatio(selected).toFixed(2) }}R</div></div>
                    <div><div class="text-xs text-gray-500">Leva</div><div class="text-lg font-black text-white">{{ selected.suggestedLeverage }}x</div></div>
                    <div><div class="text-xs text-gray-500">Margin</div><div class="text-lg font-black text-white">{{ selected.marginUsdt?.toFixed(2) }}$</div></div>
                  </div>
                </div>
                <div class="rounded-xl bg-black/30 border border-white/5 p-4 space-y-3">
                  <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Range</div>
                  <div><div class="text-xs text-gray-500 mb-0.5">Range High</div><div class="text-2xl font-black text-yellow-400 font-mono">{{ selected.rangeHigh }}</div></div>
                  <div><div class="text-xs text-gray-500 mb-0.5">Range Low</div><div class="text-xl font-black text-white font-mono">{{ selected.rangeLow }}</div></div>
                  <div><div class="text-xs text-gray-500 mb-0.5">Range Size</div><div class="text-xl font-black text-yellow-300 font-mono">{{ selected.rangeSize?.toFixed(3) }}%</div></div>
                  <div><div class="text-xs text-gray-500 mb-0.5">VWAP</div><div class="text-lg font-black text-white font-mono">{{ selected.vwap }}</div></div>
                </div>
                <div class="rounded-xl bg-black/30 border border-white/5 p-4 space-y-3">
                  <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold">Order Flow</div>
                  <div class="text-center py-2">
                    <div class="text-xs text-gray-500 mb-1">Volume ratio</div>
                    <div class="text-4xl font-black font-mono text-white">{{ selected.volumeRatio?.toFixed(2) }}x</div>
                    <div class="text-xs text-gray-500 mt-1">{{ selected.volumeRatio >= 1.5 ? '🔥 Alto' : selected.volumeRatio >= 1.2 ? '⚡ Buono' : '• Nella norma' }}</div>
                  </div>
                  <div class="text-center py-2 border-t border-white/5">
                    <div class="text-xs text-gray-500 mb-1">Range size</div>
                    <div class="text-3xl font-black font-mono text-yellow-400">{{ selected.rangeSize?.toFixed(3) }}%</div>
                  </div>
                </div>
              </div>
              <div v-if="selected.reasons?.length" class="rounded-xl bg-black/30 border border-white/5 p-4">
                <div class="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-3">Confluenze rilevate</div>
                <div class="flex flex-wrap gap-2">
                  <span v-for="r in selected.reasons" :key="r" class="text-sm font-mono px-3 py-1.5 rounded-lg bg-white/5 text-gray-300 border border-white/5">{{ r }}</span>
                </div>
              </div>
              <div class="rounded-xl bg-black/30 border border-white/5 p-4">
                <div class="h-3 rounded-full bg-black/50 overflow-hidden">
                  <div class="h-full rounded-full transition-all duration-700" :style="{ width: rrBarWidth(selected) + '%' }" :class="selected.direction === 'LONG' ? 'bg-gradient-to-r from-green-700 to-green-400' : 'bg-gradient-to-r from-red-700 to-red-400'" />
                </div>
                <div class="flex justify-between text-xs text-gray-500 font-mono mt-2">
                  <span>Risk {{ selected.riskUsdt }}$</span>
                  <span>{{ rrRatio(selected).toFixed(2) }}R · RR fisso</span>
                  <span>Reward {{ (selected.riskUsdt * rrRatio(selected)).toFixed(2) }}$</span>
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
import Button from 'primevue/button'
import InputNumber from 'primevue/inputnumber'
import ToggleSwitch from 'primevue/toggleswitch'
import axios from 'axios'
import { createChart, CrosshairMode, LineStyle, type IChartApi } from 'lightweight-charts'
import { useFootprintStore } from '@/stores/footprint'

const store        = useFootprintStore()
const analytics    = computed(() => store.analytics)
const status       = computed(() => store.analytics?.scannerStatus)
const openTrades   = computed(() => (store.analytics as any)?.openTradesList  ?? [])
const closedTrades = computed(() => (store.analytics as any)?.closedTradesList ?? [])
const cfg          = computed(() => store.analytics?.config ?? {})
const showConfig   = ref(false)

const selected       = ref<any>(null)
const chartLoading   = ref(false)
const chartContainer = ref<HTMLElement | null>(null)
let chartInstance: IChartApi | null = null
let chartState: any = null
let chartRefreshTimer: ReturnType<typeof setInterval> | null = null
let chartRefreshBusy = false
let chartResizeObserver: ResizeObserver | null = null

async function openDialog(sig: any) { selected.value = normalizeDialogItem(sig); await nextTick(); await buildChart(selected.value) }
async function openTradeDialog(trade: any) { await openDialog(trade) }

function normalizeDialogItem(item: any) {
  const stopLoss = Number(item.stopLoss)
  const reasons = item.reasons ?? [`Trade ${item.direction}`, `Entry ${item.entry}`, `SL ${stopLoss}`, `TP ${item.takeProfit}`]
  return {
    ...item, stopLoss,
    suggestedLeverage: item.suggestedLeverage ?? item.leverage ?? 0,
    marginUsdt: Number(item.marginUsdt ?? 0),
    riskUsdt: Number(item.riskUsdt ?? 0),
    timestamp: item.timestamp ?? item.openedAt ?? item.closedAt ?? new Date().toISOString(),
    score: item.score ?? 0, grade: item.grade ?? 'B',
    rangeHigh: item.rangeHigh ?? 0,
    rangeLow: item.rangeLow ?? 0,
    rangeSize: Number(item.rangeSize ?? 0),
    vwap: item.vwap ?? 0,
    volumeRatio: Number(item.volumeRatio ?? 0),
    reasons,
  }
}

function closeDialog() { stopChartLive(); if (chartInstance) { chartInstance.remove(); chartInstance = null }; chartState = null; selected.value = null }
function isLiveChart(sig: any) { return !sig.closedAt && !['tp', 'sl', 'manual'].includes(String(sig.status ?? '').toLowerCase()) }
function chartCandlesUrl(sig: any) {
  const sym = encodeURIComponent(sig.symbol)
  const anchorTs = new Date(sig.openedAt ?? sig.timestamp ?? Date.now()).getTime()
  const from = Number.isFinite(anchorTs) ? Math.max(0, anchorTs - 45 * 60_000) : undefined
  const live = isLiveChart(sig) ? '&live=1' : ''
  return from ? `/api/footprint/candles/${sym}?limit=120&from=${from}${live}` : `/api/footprint/candles/${sym}?limit=120${live}`
}
async function fetchChartCandles(sig: any) { const { data } = await axios.get(chartCandlesUrl(sig)); return Array.isArray(data) ? data : [] }

function applyChartData(candles: any[]) {
  if (!chartState || !candles.length) return
  const firstTime = candles[0]?.time as any; const lastTime = (candles[candles.length - 1]?.time ?? 0) + 60
  chartState.candles.setData(candles.map((c: any) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
  chartState.slZone.setData([{ time: firstTime, value: chartState.sig.stopLoss }, { time: lastTime as any, value: chartState.sig.stopLoss }])
  chartState.tpZone.setData([{ time: firstTime, value: chartState.sig.takeProfit }, { time: lastTime as any, value: chartState.sig.takeProfit }])
  for (const line of chartState.lines) line.series.setData([{ time: firstTime, value: line.price }, { time: lastTime as any, value: line.price }])
}

function stopChartLive() { if (chartRefreshTimer) clearInterval(chartRefreshTimer); chartRefreshTimer = null; chartRefreshBusy = false; if (chartResizeObserver) chartResizeObserver.disconnect(); chartResizeObserver = null }
function startChartLive(sig: any) {
  if (!isLiveChart(sig)) return
  chartRefreshTimer = setInterval(async () => {
    if (!selected.value || selected.value.id !== sig.id || chartRefreshBusy) return
    chartRefreshBusy = true
    try { const candles = await fetchChartCandles(sig); applyChartData(candles); chartInstance?.timeScale().scrollToRealTime() } catch {} finally { chartRefreshBusy = false }
  }, 3000)
}

async function buildChart(sig: any) {
  if (!chartContainer.value) return
  stopChartLive(); if (chartInstance) { chartInstance.remove(); chartInstance = null }
  chartLoading.value = true; let candles: any[] = []
  try { candles = await fetchChartCandles(sig) } catch {}
  chartLoading.value = false; if (!candles.length || !chartContainer.value) return
  const chart = createChart(chartContainer.value, { layout: { background: { color: 'transparent' }, textColor: '#9ca3af' }, grid: { vertLines: { color: '#1f2937' }, horzLines: { color: '#1f2937' } }, crosshair: { mode: CrosshairMode.Normal }, rightPriceScale: { borderColor: '#1f2937' }, timeScale: { borderColor: '#1f2937', timeVisible: true, secondsVisible: false }, width: chartContainer.value.clientWidth, height: chartContainer.value.clientHeight })
  chartInstance = chart
  const cs = chart.addCandlestickSeries({ upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444' })
  cs.setData(candles.map((c: any) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })))
  const firstTime = candles[0]?.time as any; const lastTime = (candles[candles.length - 1]?.time ?? 0) + 60; const isLong = sig.direction === 'LONG'
  const slZone = chart.addBaselineSeries({ baseValue: { type: 'price', price: sig.entry }, topLineColor: 'transparent', topFillColor1: isLong ? 'transparent' : 'rgba(239,68,68,0.22)', topFillColor2: isLong ? 'transparent' : 'rgba(239,68,68,0.08)', bottomLineColor: 'transparent', bottomFillColor1: isLong ? 'rgba(239,68,68,0.22)' : 'transparent', bottomFillColor2: isLong ? 'rgba(239,68,68,0.08)' : 'transparent', lineWidth: 0 as any, priceLineVisible: false, lastValueVisible: false } as any)
  slZone.setData([{ time: firstTime, value: sig.stopLoss }, { time: lastTime as any, value: sig.stopLoss }])
  const tpZone = chart.addBaselineSeries({ baseValue: { type: 'price', price: sig.entry }, topLineColor: 'transparent', topFillColor1: isLong ? 'rgba(34,197,94,0.22)' : 'transparent', topFillColor2: isLong ? 'rgba(34,197,94,0.08)' : 'transparent', bottomLineColor: 'transparent', bottomFillColor1: isLong ? 'transparent' : 'rgba(34,197,94,0.22)', bottomFillColor2: isLong ? 'transparent' : 'rgba(34,197,94,0.08)', lineWidth: 0 as any, priceLineVisible: false, lastValueVisible: false } as any)
  tpZone.setData([{ time: firstTime, value: sig.takeProfit }, { time: lastTime as any, value: sig.takeProfit }])
  const levelLines: any[] = []
  const addLine = (price: number, color: string, style: LineStyle, title: string) => { if (!price) return; const s = chart.addLineSeries({ color, lineWidth: 1 as any, lineStyle: style, priceLineVisible: false, lastValueVisible: false, title }); s.setData([{ time: firstTime, value: price }, { time: lastTime as any, value: price }]); levelLines.push({ series: s, price }) }
  addLine(sig.entry, '#ffffff', LineStyle.Dashed, 'Entry')
  addLine(sig.stopLoss, '#ef4444', LineStyle.Dashed, 'SL')
  addLine(sig.takeProfit, '#22c55e', LineStyle.Dashed, 'TP')
  if (sig.rangeHigh) addLine(Number(sig.rangeHigh), '#eab308', LineStyle.Dotted, 'RH')
  if (sig.rangeLow) addLine(Number(sig.rangeLow), '#eab308', LineStyle.Dotted, 'RL')
  chartState = { sig, candles: cs, slZone, tpZone, lines: levelLines }
  chart.timeScale().fitContent(); if (isLiveChart(sig)) chart.timeScale().scrollToRealTime()
  chartResizeObserver = new ResizeObserver(() => { if (chartContainer.value && chartInstance) chartInstance.applyOptions({ width: chartContainer.value.clientWidth }) })
  if (chartContainer.value) chartResizeObserver.observe(chartContainer.value)
  startChartLive(sig)
}

async function toggleEnabled()   { await store.updateConfig({ enabled:   !analytics.value?.config?.enabled }) }
async function toggleAutoEnter() { await store.updateConfig({ autoEnter: !analytics.value?.config?.autoEnter }) }

function pnlColor(v?: number | null) { if (v == null) return 'text-gray-500'; return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400' }
function gradeBadge(g: string) { return g === 'A+' ? 'bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded-lg text-sm font-bold' : g === 'A' ? 'bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-lg text-sm font-bold' : 'bg-surface-200 text-gray-400 px-2 py-0.5 rounded-lg text-sm font-bold' }
function timeAgo(ts: string | number) { const ms = typeof ts === 'number' ? ts : new Date(ts).getTime(); const s = Math.floor((Date.now() - ms) / 1000); if (s < 60) return `${s}s fa`; const m = Math.floor(s / 60); if (m < 60) return `${m}m fa`; return `${Math.floor(m / 60)}h fa` }
function rrRatio(sig: any): number { if (!sig?.slPct || !sig?.tpPct) return 0; return sig.tpPct / sig.slPct }
function rrBarWidth(sig: any): number { return Math.min(rrRatio(sig) / 4 * 100, 100) }

onMounted(async () => { await store.loadAnalytics(); store.connect() })
onUnmounted(() => { store.disconnect(); stopChartLive(); if (chartInstance) chartInstance.remove() })
</script>

<style scoped>
.dialog-enter-active, .dialog-leave-active { transition: opacity 0.18s ease; }
.dialog-enter-from, .dialog-leave-to       { opacity: 0; }
</style>
