<template>
  <div class="p-6 space-y-6">

    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          📊 Simulazione Multi-TF
          <span class="text-xs font-normal text-gray-500">ERB v7 · 5m · 15m · 1h</span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Ogni segnale MTF viene simulato automaticamente · fee MEXC 0.038%×2 = 0.076% round-trip
        </p>
      </div>
      <div class="flex gap-2">
        <Button size="small" label="Config" icon="pi pi-cog" severity="secondary" @click="showConfig = true" />
        <Button size="small" label="Reset" icon="pi pi-refresh" severity="danger" text @click="confirmReset" />
      </div>
    </div>

    <!-- TF Tabs -->
    <div class="flex gap-1 bg-surface-100 p-1 rounded-xl w-fit">
      <button
        v-for="tf in tfs" :key="tf"
        @click="activeTf = tf"
        :class="[
          'px-5 py-2 rounded-lg text-sm font-semibold transition-all',
          activeTf === tf
            ? 'bg-cyan-500 text-white shadow'
            : 'text-gray-400 hover:text-white hover:bg-surface-200',
        ]"
      >
        {{ tf }}
        <span v-if="store.trades[tf].filter(t => t.status === 'open').length"
              class="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-white/20">
          {{ store.trades[tf].filter(t => t.status === 'open').length }}
        </span>
      </button>
    </div>

    <!-- Loading -->
    <div v-if="isLoading" class="flex justify-center py-20">
      <ProgressSpinner />
    </div>

    <template v-else-if="a">

      <!-- Capitale headline -->
      <div class="stat-card flex items-center gap-6 py-5">
        <div>
          <div class="text-xs text-gray-500 mb-1">Capitale attuale ({{ activeTf }})</div>
          <div class="text-4xl font-bold font-mono" :class="a.totalPnl >= 0 ? 'text-profit' : 'text-loss'">
            €{{ a.currentCapital.toFixed(2) }}
          </div>
          <div class="text-sm font-mono mt-1" :class="a.totalPnl >= 0 ? 'text-profit' : 'text-loss'">
            {{ a.totalPnl >= 0 ? '+' : '' }}€{{ a.totalPnl.toFixed(2) }}
            ({{ a.totalPnlPct >= 0 ? '+' : '' }}{{ a.totalPnlPct.toFixed(2) }}%)
          </div>
        </div>
        <div class="flex-1 h-14">
          <EquityMiniChart :curve="a.equityCurve" :start="a.startingCapital" />
        </div>
      </div>

      <!-- KPI grid -->
      <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Trade chiusi</div>
          <div class="text-2xl font-bold text-white">{{ a.totalTrades }}</div>
          <div class="text-xs text-gray-600 mt-0.5">{{ a.openTrades }} aperti</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Win Rate</div>
          <div class="text-2xl font-bold" :class="a.winRate >= 50 ? 'text-profit' : 'text-loss'">
            {{ a.winRate.toFixed(1) }}%
          </div>
          <div class="text-xs text-gray-600 mt-0.5">{{ a.wins }}W / {{ a.losses }}L</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Profit Factor</div>
          <div class="text-2xl font-bold" :class="a.profitFactor >= 1.5 ? 'text-profit' : a.profitFactor >= 1 ? 'text-yellow-400' : 'text-loss'">
            {{ a.profitFactor >= 999 ? '∞' : a.profitFactor.toFixed(2) }}
          </div>
          <div class="text-xs text-gray-600 mt-0.5">
            <span class="text-green-500">+€{{ a.avgWinEur.toFixed(2) }}</span>
            / <span class="text-red-400">-€{{ a.avgLossEur.toFixed(2) }}</span>
          </div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">RR Reale</div>
          <div class="text-2xl font-bold font-mono"
               :class="a.rrActual >= 2 ? 'text-profit' : a.rrActual >= 1 ? 'text-yellow-400' : 'text-loss'">
            {{ a.rrActual?.toFixed(2) ?? '—' }}×
          </div>
          <div class="text-xs text-gray-600 mt-0.5">avg win / avg loss</div>
        </div>
        <div class="stat-card text-center">
          <div class="text-xs text-gray-500 mb-1">Max Drawdown</div>
          <div class="text-2xl font-bold" :class="a.maxDrawdownPct <= 10 ? 'text-profit' : a.maxDrawdownPct <= 25 ? 'text-yellow-400' : 'text-loss'">
            {{ a.maxDrawdownPct.toFixed(1) }}%
          </div>
          <div class="text-xs text-gray-600 mt-0.5">dal picco</div>
        </div>
      </div>

      <!-- Fee breakdown -->
      <div class="stat-card" v-if="a.totalTrades > 0">
        <h3 class="text-sm font-semibold text-white mb-3">Breakdown PnL / Fee</h3>
        <div class="grid grid-cols-3 gap-4">
          <div class="bg-surface-200 rounded-lg p-3">
            <div class="text-xs text-gray-500 mb-1">PnL Lordo</div>
            <div class="text-xl font-bold font-mono" :class="a.totalGrossPnl >= 0 ? 'text-profit' : 'text-loss'">
              {{ a.totalGrossPnl >= 0 ? '+' : '' }}€{{ a.totalGrossPnl.toFixed(2) }}
            </div>
            <div class="text-[10px] text-gray-600 mt-1">prima delle commissioni</div>
          </div>
          <div class="bg-surface-200 rounded-lg p-3">
            <div class="text-xs text-gray-500 mb-1">Fee Pagate</div>
            <div class="text-xl font-bold font-mono text-yellow-400">
              -€{{ a.totalFeesPaid.toFixed(2) }}
            </div>
            <div class="text-[10px] text-gray-600 mt-1">
              {{ a.totalTrades > 0 ? (a.totalFeesPaid / a.totalTrades).toFixed(3) : '0.000' }}€ media/trade
            </div>
          </div>
          <div class="bg-surface-200 rounded-lg p-3 border" :class="a.totalPnl >= 0 ? 'border-profit/20' : 'border-loss/20'">
            <div class="text-xs text-gray-500 mb-1">PnL Netto</div>
            <div class="text-xl font-bold font-mono" :class="a.totalPnl >= 0 ? 'text-profit' : 'text-loss'">
              {{ a.totalPnl >= 0 ? '+' : '' }}€{{ a.totalPnl.toFixed(2) }}
            </div>
            <div class="text-[10px] mt-1 text-gray-600">
              fee = {{ a.totalGrossPnl !== 0 ? ((a.totalFeesPaid / Math.abs(a.totalGrossPnl)) * 100).toFixed(1) : '0' }}% del lordo
            </div>
          </div>
        </div>
      </div>

      <!-- Best / Worst -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3" v-if="a.bestTrade || a.worstTrade">
        <div v-if="a.bestTrade" class="stat-card border-profit/20">
          <div class="text-xs text-gray-500 mb-2">🏆 Miglior trade</div>
          <div class="flex items-center gap-3">
            <span class="font-mono font-bold text-white">{{ a.bestTrade.symbol.replace('/USDT:USDT','') }}/USDT</span>
            <span :class="a.bestTrade.direction === 'LONG' ? 'badge-buy' : 'badge-sell'">{{ a.bestTrade.direction }}</span>
            <span :class="gradeBadge(a.bestTrade.grade)" class="text-xs px-1.5 py-0.5 rounded font-bold">{{ a.bestTrade.grade }}</span>
          </div>
          <div class="text-profit text-lg font-bold font-mono mt-1">
            +€{{ a.bestTrade.pnl?.toFixed(2) }}
          </div>
        </div>
        <div v-if="a.worstTrade" class="stat-card border-loss/20">
          <div class="text-xs text-gray-500 mb-2">📉 Peggior trade</div>
          <div class="flex items-center gap-3">
            <span class="font-mono font-bold text-white">{{ a.worstTrade.symbol.replace('/USDT:USDT','') }}/USDT</span>
            <span :class="a.worstTrade.direction === 'LONG' ? 'badge-buy' : 'badge-sell'">{{ a.worstTrade.direction }}</span>
            <span :class="gradeBadge(a.worstTrade.grade)" class="text-xs px-1.5 py-0.5 rounded font-bold">{{ a.worstTrade.grade }}</span>
          </div>
          <div class="text-loss text-lg font-bold font-mono mt-1">
            €{{ a.worstTrade.pnl?.toFixed(2) }}
          </div>
        </div>
      </div>

      <!-- By Grade -->
      <div class="stat-card" v-if="Object.keys(a.byGrade).length">
        <h3 class="text-sm font-semibold text-white mb-3">Performance per Grade</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div v-for="(g, grade) in a.byGrade" :key="grade" class="bg-surface-200 rounded-lg p-3 text-center">
            <div :class="gradeBadge(grade)" class="inline-block px-2 py-0.5 rounded font-bold text-sm mb-2">{{ grade }}</div>
            <div class="text-xs text-gray-500">{{ g.trades }} trade · {{ g.winRate.toFixed(0) }}% win</div>
            <div class="font-mono font-bold mt-1" :class="g.pnl >= 0 ? 'text-profit' : 'text-loss'">
              {{ g.pnl >= 0 ? '+' : '' }}€{{ g.pnl.toFixed(2) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Config riepilogo -->
      <div class="stat-card">
        <h3 class="text-sm font-semibold text-white mb-3">Parametri simulazione ({{ activeTf }})</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-center">
          <div><div class="text-gray-500">Capitale</div><div class="font-bold text-white">€{{ a.config.startingCapital }}</div></div>
          <div><div class="text-gray-500">Margine/trade</div><div class="font-bold text-white">${{ a.config.marginPerTrade }}</div></div>
          <div><div class="text-gray-500">Max concurrent</div><div class="font-bold text-white">{{ a.config.maxConcurrent }}</div></div>
          <div><div class="text-gray-500">Auto-enter</div><div :class="a.config.autoEnter ? 'text-profit' : 'text-gray-500'" class="font-bold">{{ a.config.autoEnter ? 'ON' : 'OFF' }}</div></div>
        </div>
      </div>

      <!-- Trade history -->
      <div class="stat-card">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-semibold text-white flex items-center gap-2">
            Storico Trade ({{ activeTf }})
            <span class="text-[10px] bg-white/5 border border-white/8 rounded-full px-2 py-0.5 text-gray-400 font-normal">
              {{ currentTrades.length }}
            </span>
          </h3>
          <div class="flex items-center gap-3 text-[11px] font-mono">
            <span class="text-yellow-400/80">{{ tradeOpenCount }} aperti</span>
            <span class="text-white/10">|</span>
            <span class="text-green-400/80">{{ tradeTpCount }} TP</span>
            <span class="text-white/10">|</span>
            <span class="text-red-400/80">{{ tradeSlCount }} SL</span>
          </div>
        </div>

        <div class="space-y-2 max-h-[640px] overflow-y-auto -mx-1 px-1">
          <div v-if="currentTrades.length === 0" class="text-center text-gray-600 py-12 text-sm">
            Nessun trade simulato ancora
          </div>

          <div
            v-for="t in currentTrades" :key="t.id"
            :class="tradeRowBg(t.status)"
            class="rounded-xl border px-4 py-3 flex items-center gap-5 transition-colors group cursor-pointer"
            @click="openChart(t)"
          >
            <!-- ① Simbolo + meta -->
            <div class="flex-shrink-0 w-32">
              <div class="font-mono font-bold text-white text-sm tracking-tight leading-tight">
                {{ t.symbol.replace('/USDT:USDT','') }}
                <span class="text-gray-600 font-normal text-[10px]">/USDT</span>
              </div>
              <div class="flex items-center gap-1 mt-1.5 flex-wrap">
                <span :class="t.direction === 'LONG' ? 'badge-buy' : 'badge-sell'" class="text-[10px] px-1.5 py-px font-semibold">
                  {{ t.direction }}
                </span>
                <span :class="gradeBadge(t.grade)" class="text-[10px] px-1.5 py-px rounded font-bold">{{ t.grade }}</span>
                <span class="text-gray-500 text-[10px] font-mono">{{ t.leverage }}×</span>
              </div>
              <div class="text-[9px] text-gray-600 font-mono mt-1.5">{{ timeAgo(t.openedAt) }}</div>
            </div>

            <!-- ② Price ladder -->
            <div class="flex-1 min-w-0">
              <PriceLadder
                :entry="t.entry" :sl="t.stopLoss"
                :tp1="t.takeProfit1" :tp2="t.takeProfit2"
                :close-price="t.status !== 'open' ? t.closePrice : (t.currentPrice ?? null)"
                :direction="t.direction" :status="t.status"
              />
              <div v-if="t.status === 'open'" class="mt-2 flex items-center gap-2">
                <div class="flex-1 h-[3px] bg-white/5 rounded-full overflow-hidden">
                  <div
                    class="h-full rounded-full transition-all duration-500"
                    :class="tradeProgress(t) >= 0 ? 'bg-green-400/50' : 'bg-red-400/40'"
                    :style="{ width: `${Math.min(Math.abs(tradeProgress(t)), 100)}%` }"
                  />
                </div>
                <span class="text-[9px] font-mono flex-shrink-0 w-14 text-right"
                      :class="tradeProgress(t) >= 100 ? 'text-green-300' : tradeProgress(t) >= 0 ? 'text-green-500/60' : 'text-red-500/60'">
                  {{ tradeProgress(t) >= 0 ? '+' : '' }}{{ tradeProgress(t).toFixed(0) }}% TP1
                </span>
              </div>
            </div>

            <!-- ③ Livelli -->
            <div class="flex-shrink-0 w-28 hidden md:block">
              <div class="space-y-[3px] font-mono text-[10px]">
                <div class="flex justify-between gap-2">
                  <span class="text-green-400/80">TP2</span>
                  <span class="text-gray-400">{{ formatPrice(t.takeProfit2) }}</span>
                </div>
                <div class="flex justify-between gap-2">
                  <span class="text-green-500/60">TP1</span>
                  <span class="text-gray-400">{{ formatPrice(t.takeProfit1) }}</span>
                </div>
                <div class="flex justify-between gap-2 border-y border-white/8 py-[3px] my-[2px]">
                  <span class="text-white/90 font-semibold">ENT</span>
                  <span class="text-white/90 font-semibold">{{ formatPrice(t.entry) }}</span>
                </div>
                <div class="flex justify-between gap-2">
                  <span class="text-red-400/80">SL</span>
                  <span class="text-gray-400">{{ formatPrice(t.stopLoss) }}</span>
                </div>
              </div>
            </div>

            <!-- ④ PnL -->
            <div class="flex-shrink-0 w-28 text-right">
              <template v-if="t.status === 'open'">
                <template v-if="t.unrealizedPnl != null">
                  <div class="text-base font-bold font-mono leading-tight"
                       :class="t.unrealizedPnl >= 0 ? 'text-profit' : 'text-loss'">
                    {{ t.unrealizedPnl >= 0 ? '+' : '' }}€{{ t.unrealizedPnl.toFixed(2) }}
                  </div>
                  <div class="text-[10px] text-yellow-500/50 font-mono mt-0.5">fee −€{{ t.fees.toFixed(3) }}</div>
                </template>
                <span v-else class="text-yellow-400 text-xs animate-pulse font-mono">live…</span>
              </template>
              <template v-else-if="t.pnl != null">
                <div class="text-[10px] text-gray-600 font-mono">
                  lordo {{ (t.pnl + t.fees) >= 0 ? '+' : '' }}€{{ (t.pnl + t.fees).toFixed(2) }}
                </div>
                <div class="text-[10px] text-yellow-500/40 font-mono">fee −€{{ t.fees.toFixed(3) }}</div>
                <div class="text-sm font-bold font-mono mt-0.5" :class="t.pnl >= 0 ? 'text-profit' : 'text-loss'">
                  {{ t.pnl >= 0 ? '+' : '' }}€{{ t.pnl.toFixed(2) }}
                </div>
              </template>
            </div>

            <!-- ⑤ Stato + chiudi -->
            <div class="flex-shrink-0 w-24 flex flex-col items-end gap-2">
              <StatusBadge :status="t.status" />
              <button
                v-if="t.status === 'open'"
                class="text-[10px] text-gray-600 hover:text-red-400 transition-colors px-2 py-0.5 rounded border border-white/8 hover:border-red-500/30 font-mono opacity-0 group-hover:opacity-100"
                @click.stop="store.closeManual(t.id, activeTf)"
              >
                chiudi ×
              </button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Empty state -->
    <div v-else class="stat-card text-center py-16">
      <div class="text-5xl mb-4">📊</div>
      <p class="text-gray-400 font-semibold">Simulazione {{ activeTf }} non ancora avviata</p>
      <p class="text-gray-600 text-sm mt-2">
        I trade vengono simulati automaticamente quando l'MTF Scanner rileva segnali.<br>
        Attiva lo scanner e i risultati appariranno qui.
      </p>
    </div>

    <!-- Chart modal -->
    <Teleport to="body">
      <Transition name="modal-fade">
        <div v-if="selectedTrade"
             class="fixed inset-0 z-50 flex items-center justify-center p-4"
             style="background: rgba(0,0,0,0.78); backdrop-filter: blur(4px)"
             @click.self="selectedTrade = null">
          <div class="relative bg-[#13131e] rounded-2xl border border-white/10 shadow-2xl w-full max-w-4xl overflow-hidden" @click.stop>
            <div class="flex items-center justify-between px-5 py-3 border-b border-white/8">
              <div class="flex items-center gap-3">
                <span class="font-mono font-bold text-white text-lg">
                  {{ selectedTrade.symbol.replace('/USDT:USDT','') }}/USDT
                </span>
                <span :class="selectedTrade.direction === 'LONG' ? 'badge-buy' : 'badge-sell'">{{ selectedTrade.direction }}</span>
                <span :class="gradeBadge(selectedTrade.grade)" class="text-xs px-1.5 py-0.5 rounded font-bold">{{ selectedTrade.grade }}</span>
                <StatusBadge :status="selectedTrade.status" />
              </div>
              <div class="flex items-center gap-1">
                <button v-for="tf in ['1m','5m','15m','1h']" :key="tf"
                  @click="chartTimeframe = tf"
                  :class="chartTimeframe === tf
                    ? 'bg-brand/30 text-brand-light border-brand/40'
                    : 'text-gray-500 border-white/5 hover:text-white'"
                  class="px-2.5 py-1 rounded text-xs font-mono border transition-colors">
                  {{ tf }}
                </button>
                <button @click="selectedTrade = null"
                  class="ml-3 text-gray-500 hover:text-white transition-colors text-xl leading-none w-7 h-7 flex items-center justify-center rounded hover:bg-white/5">
                  ×
                </button>
              </div>
            </div>
            <PriceChart
              :symbol="selectedTrade.symbol"
              :timeframe="chartTimeframe"
              :lines="chartLines"
              :show-ema34="true"
              :height="380"
            />
            <div class="flex flex-wrap items-center gap-4 px-5 py-2.5 border-t border-white/8 text-[11px] font-mono">
              <div class="flex items-center gap-1.5">
                <span class="inline-block w-5 border-t border-dashed border-red-400" />
                <span class="text-red-400">SL {{ formatPrice(selectedTrade.stopLoss) }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="inline-block w-5 border-t border-white/80" />
                <span class="text-white/80">ENT {{ formatPrice(selectedTrade.entry) }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="inline-block w-5 border-t border-dashed border-green-400" />
                <span class="text-green-400">TP1 {{ formatPrice(selectedTrade.takeProfit1) }}</span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="inline-block w-5 border-t border-dashed border-green-300" />
                <span class="text-green-300">TP2 {{ formatPrice(selectedTrade.takeProfit2) }}</span>
              </div>
              <div v-if="selectedTrade.closePrice" class="flex items-center gap-1.5">
                <span class="inline-block w-5 border-t border-dashed border-gray-400" />
                <span class="text-gray-400">Chiuso {{ formatPrice(selectedTrade.closePrice) }}</span>
              </div>
              <div class="ml-auto flex items-center gap-3">
                <span class="text-gray-600">{{ timeAgo(selectedTrade.openedAt) }}</span>
                <span v-if="selectedTrade.pnl != null" class="font-bold text-sm"
                      :class="selectedTrade.pnl >= 0 ? 'text-profit' : 'text-loss'">
                  {{ selectedTrade.pnl >= 0 ? '+' : '' }}€{{ selectedTrade.pnl.toFixed(2) }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Config dialog -->
    <Dialog v-model:visible="showConfig" :header="`Config Simulazione ${activeTf}`" :style="{ width: '360px' }" modal>
      <div class="space-y-4 py-2">
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Capitale iniziale (€)</label>
          <InputNumber v-model="cfg.startingCapital" :min="10" :max="100000" prefix="€ " class="w-full" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Margine per trade ($ fisso)</label>
          <InputNumber v-model="cfg.marginPerTrade" :min="1" :max="1000" :step="1" prefix="$ " class="w-full" />
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-gray-400">Max trade contemporanei</label>
          <InputNumber v-model="cfg.maxConcurrent" :min="1" :max="10" class="w-full" />
        </div>
        <div class="flex items-center gap-2">
          <ToggleSwitch v-model="cfg.autoEnter" />
          <span class="text-sm text-gray-400">Auto-entra sui segnali dello scanner</span>
        </div>
      </div>
      <template #footer>
        <div class="flex gap-2 justify-end">
          <Button label="Annulla" severity="secondary" text @click="showConfig = false" />
          <Button label="Salva" icon="pi pi-check" @click="saveConfig" />
        </div>
      </template>
    </Dialog>

    <ConfirmDialog />
    <Toast />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, defineComponent, getCurrentInstance, h } from 'vue'
import { useConfirm } from 'primevue/useconfirm'
import { useToast } from 'primevue/usetoast'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputNumber from 'primevue/inputnumber'
import ToggleSwitch from 'primevue/toggleswitch'
import ProgressSpinner from 'primevue/progressspinner'
import ConfirmDialog from 'primevue/confirmdialog'
import Toast from 'primevue/toast'
import { useMtfScannerStore, type MtfTrade } from '@/stores/mtf-scanner'
import { createChart, ColorType } from 'lightweight-charts'
import PriceChart, { type PriceLineConfig } from '@/components/PriceChart.vue'

const store   = useMtfScannerStore()
const confirm = useConfirm()
const toast   = useToast()

const tfs = ['5m', '15m', '1h'] as const
type Tf = typeof tfs[number]
const activeTf  = ref<Tf>('5m')
const isLoading = ref(false)

const a = computed(() => store.analytics[activeTf.value])
const currentTrades = computed(() => store.trades[activeTf.value] ?? [])

const selectedTrade  = ref<MtfTrade | null>(null)
const chartTimeframe = ref('5m')

const chartLines = computed((): PriceLineConfig[] => {
  const t = selectedTrade.value
  if (!t) return []
  const lines: PriceLineConfig[] = [
    { price: t.entry,       color: '#e2e8f0', label: 'Entry' },
    { price: t.stopLoss,    color: '#ef4444', label: 'SL',  dashed: true },
    { price: t.takeProfit1, color: '#22c55e', label: 'TP1', dashed: true },
    { price: t.takeProfit2, color: '#4ade80', label: 'TP2', dashed: true },
  ]
  if (t.closePrice) lines.push({ price: t.closePrice, color: '#94a3b8', label: 'Close', dashed: true })
  return lines
})

function openChart(trade: MtfTrade) {
  selectedTrade.value = trade
  chartTimeframe.value = activeTf.value
}

const showConfig = ref(false)
const cfg = ref({ startingCapital: 500, marginPerTrade: 10, maxConcurrent: 3, autoEnter: true })

// ─── Price Ladder SVG ─────────────────────────────────────────────────────────
const PriceLadder = defineComponent({
  name: 'PriceLadder',
  props: {
    entry:      { type: Number, required: true },
    sl:         { type: Number, required: true },
    tp1:        { type: Number, required: true },
    tp2:        { type: Number, required: true },
    closePrice: { type: Number as () => number | null, default: null },
    direction:  { type: String, required: true },
    status:     { type: String, required: true },
  },
  setup(props) {
    const uid = getCurrentInstance()?.uid ?? Math.floor(Math.random() * 1e6)
    return () => {
      const W = 240, H = 54, barY = 6, barH = 18, pad = 12, innerW = W - pad * 2
      const labelY = barY + barH + 11
      const pctY   = labelY + 9

      const minP  = Math.min(props.sl, props.tp2)
      const maxP  = Math.max(props.sl, props.tp2)
      const range = maxP - minP
      if (range <= 0) return h('span', { style: 'color:#555;font-size:10px' }, '—')

      const xOf = (p: number) =>
        Math.max(pad, Math.min(pad + innerW, pad + ((p - minP) / range) * innerW))

      const xSl    = xOf(props.sl)
      const xEntry = xOf(props.entry)
      const xTp1   = xOf(props.tp1)
      const xTp2   = xOf(props.tp2)
      const xClose = props.closePrice != null ? xOf(props.closePrice) : null

      const isLong = props.direction === 'LONG'
      const [lossX, lossW] = isLong ? [xSl, xEntry - xSl]    : [xEntry, xSl - xEntry]
      const [tp1X,  tp1W]  = isLong ? [xEntry, xTp1 - xEntry] : [xTp1, xEntry - xTp1]
      const [tp2X,  tp2W]  = isLong ? [xTp1, xTp2 - xTp1]    : [xTp2, xTp1 - xTp2]

      const dotColor = props.status === 'sl' ? '#ef4444'
        : (props.status === 'tp1' || props.status === 'tp2') ? '#22c55e'
        : props.status === 'open' ? '#fbbf24' : '#94a3b8'

      const slPct  = ((Math.abs(props.entry - props.sl)  / props.entry) * 100).toFixed(2)
      const tp1Pct = ((Math.abs(props.tp1 - props.entry) / props.entry) * 100).toFixed(2)
      const tp2Pct = ((Math.abs(props.tp2 - props.entry) / props.entry) * 100).toFixed(2)

      const gLoss = `gl${uid}`, gTp1 = `gt1${uid}`, gTp2 = `gt2${uid}`, gGlow = `gg${uid}`

      const lossStops = isLong
        ? [['0%', '#ef4444', '0.42'], ['100%', '#ef4444', '0.04']]
        : [['0%', '#ef4444', '0.04'], ['100%', '#ef4444', '0.42']]
      const tp1Stops = isLong
        ? [['0%', '#22c55e', '0.05'], ['100%', '#22c55e', '0.28']]
        : [['0%', '#22c55e', '0.28'], ['100%', '#22c55e', '0.05']]
      const tp2Stops = isLong
        ? [['0%', '#22c55e', '0.28'], ['100%', '#22c55e', '0.52']]
        : [['0%', '#22c55e', '0.52'], ['100%', '#22c55e', '0.28']]

      const mkGrad = (id: string, stops: string[][]) =>
        h('linearGradient', { id, x1: '0%', y1: '0%', x2: '100%', y2: '0%' },
          stops.map(([offset, color, opacity]) =>
            h('stop', { offset, 'stop-color': color, 'stop-opacity': opacity })
          )
        )

      return h('svg', { width: W, height: H, style: 'display:block; overflow:visible; flex-shrink:0' }, [
        h('defs', {}, [
          mkGrad(gLoss, lossStops), mkGrad(gTp1, tp1Stops), mkGrad(gTp2, tp2Stops),
          h('filter', { id: gGlow, x: '-80%', y: '-80%', width: '260%', height: '260%' }, [
            h('feGaussianBlur', { 'in': 'SourceGraphic', stdDeviation: '4', result: 'blur' }),
            h('feMerge', {}, [h('feMergeNode', { in: 'blur' }), h('feMergeNode', { in: 'SourceGraphic' })]),
          ]),
        ]),
        h('rect', { x: pad, y: barY, width: innerW, height: barH, rx: 5, fill: '#111827', stroke: '#1e3a5f', 'stroke-width': '0.5' }),
        lossW > 0 && h('rect', { x: lossX, y: barY, width: lossW, height: barH, fill: `url(#${gLoss})` }),
        tp1W  > 0 && h('rect', { x: tp1X,  y: barY, width: tp1W,  height: barH, fill: `url(#${gTp1})` }),
        tp2W  > 0 && h('rect', { x: tp2X,  y: barY, width: tp2W,  height: barH, fill: `url(#${gTp2})` }),
        h('rect', { x: pad, y: barY, width: innerW, height: barH, rx: 5, fill: 'none', stroke: '#1e3a5f', 'stroke-width': '0.5' }),
        h('line', { x1: xSl, x2: xSl, y1: barY + 2, y2: barY + barH - 2, stroke: '#f87171', 'stroke-width': 1.5 }),
        h('text', { x: xSl, y: labelY, 'text-anchor': 'middle', fill: '#f87171', 'font-size': 8.5, 'font-family': 'ui-monospace,monospace', 'font-weight': '600' }, 'SL'),
        h('text', { x: xSl, y: pctY,   'text-anchor': 'middle', fill: '#f8717170', 'font-size': 7, 'font-family': 'ui-monospace,monospace' }, `-${slPct}%`),
        h('line', { x1: xEntry, x2: xEntry, y1: barY - 4, y2: barY + barH + 4, stroke: '#e2e8f0', 'stroke-width': 2 }),
        h('text', { x: xEntry, y: labelY, 'text-anchor': 'middle', fill: '#e2e8f0', 'font-size': 8.5, 'font-family': 'ui-monospace,monospace', 'font-weight': '700' }, 'ENT'),
        h('line', { x1: xTp1, x2: xTp1, y1: barY + 2, y2: barY + barH - 2, stroke: '#4ade80', 'stroke-width': 1.5, 'stroke-dasharray': '3,2' }),
        h('text', { x: xTp1, y: labelY, 'text-anchor': 'middle', fill: '#4ade80', 'font-size': 8.5, 'font-family': 'ui-monospace,monospace', 'font-weight': '600' }, 'TP1'),
        h('text', { x: xTp1, y: pctY,   'text-anchor': 'middle', fill: '#4ade8070', 'font-size': 7, 'font-family': 'ui-monospace,monospace' }, `+${tp1Pct}%`),
        h('line', { x1: xTp2, x2: xTp2, y1: barY + 2, y2: barY + barH - 2, stroke: '#22c55e', 'stroke-width': 1.5 }),
        h('text', { x: xTp2, y: labelY, 'text-anchor': 'middle', fill: '#22c55e', 'font-size': 8.5, 'font-family': 'ui-monospace,monospace', 'font-weight': '600' }, 'TP2'),
        h('text', { x: xTp2, y: pctY,   'text-anchor': 'middle', fill: '#22c55e70', 'font-size': 7, 'font-family': 'ui-monospace,monospace' }, `+${tp2Pct}%`),
        xClose != null && h('circle', {
          cx: xClose, cy: barY + barH / 2,
          r: props.status === 'open' ? 6.5 : 5.5,
          fill: dotColor, stroke: '#fff', 'stroke-width': 1.5,
          filter: props.status === 'open' ? `url(#${gGlow})` : undefined,
        }),
        xClose != null && props.status === 'open' && h('circle', {
          cx: xClose, cy: barY + barH / 2, r: 2.5, fill: '#ffffffcc',
        }),
      ])
    }
  },
})

const EquityMiniChart = defineComponent({
  props: { curve: Array, start: Number },
  setup(props) {
    const el = ref<HTMLElement>()
    onMounted(() => {
      if (!el.value || !props.curve?.length) return
      const chart = createChart(el.value, {
        width: el.value.clientWidth, height: 56,
        layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: 'transparent' },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        leftPriceScale: { visible: false }, rightPriceScale: { visible: false },
        timeScale: { visible: false },
        crosshair: { vertLine: { visible: false }, horzLine: { visible: false } },
        handleScroll: false, handleScale: false,
      })
      const series = chart.addAreaSeries({
        lineColor: (props.curve.at(-1) as any)?.capital >= props.start ? '#22c55e' : '#ef4444',
        topColor:   (props.curve.at(-1) as any)?.capital >= props.start ? '#22c55e30' : '#ef444430',
        bottomColor: 'transparent',
        lineWidth: 2,
      })
      const data = (props.curve as any[]).map((p, i) => ({
        time: (Math.floor(new Date(p.date).getTime() / 1000) + i) as import('lightweight-charts').UTCTimestamp,
        value: p.capital,
      }))
      series.setData(data)
      chart.timeScale().fitContent()
    })
    return () => h('div', { ref: el, style: 'width:100%;height:56px' })
  },
})

const StatusBadge = defineComponent({
  name: 'StatusBadge',
  props: { status: { type: String, required: true } },
  setup(props) {
    return () => {
      const map: Record<string, { cls: string; label: string }> = {
        open:   { cls: 'bg-yellow-400/10 text-yellow-300 border-yellow-400/20',        label: '● Aperto'  },
        tp1:    { cls: 'bg-green-500/15 text-green-300 border-green-500/25 font-bold', label: '✓ TP1'    },
        tp2:    { cls: 'bg-green-400/15 text-green-200 border-green-400/30 font-bold', label: '✓ TP2'    },
        sl:     { cls: 'bg-red-500/15 text-red-400 border-red-500/25 font-bold',       label: '✗ SL'     },
        manual: { cls: 'bg-gray-500/10 text-gray-500 border-gray-500/20',              label: '— Chiuso' },
      }
      const c = map[props.status] ?? map.manual
      return h('span', {
        class: `inline-flex items-center text-[10px] font-mono px-2 py-0.5 rounded-full border ${c.cls}`,
      }, c.label)
    }
  },
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const tradeOpenCount = computed(() => currentTrades.value.filter(t => t.status === 'open').length)
const tradeTpCount   = computed(() => currentTrades.value.filter(t => t.status === 'tp1' || t.status === 'tp2').length)
const tradeSlCount   = computed(() => currentTrades.value.filter(t => t.status === 'sl').length)

function tradeRowBg(status: string) {
  if (status === 'tp1' || status === 'tp2') return 'bg-green-950/20 border-green-500/10 hover:border-green-500/20'
  if (status === 'sl')    return 'bg-red-950/15 border-red-500/10 hover:border-red-500/20'
  if (status === 'open')  return 'bg-slate-900/50 border-white/5 hover:border-white/10'
  return 'bg-slate-900/30 border-white/5'
}

function tradeProgress(trade: MtfTrade): number {
  if (trade.status !== 'open') return 0
  const curP = trade.currentPrice
  if (!curP) return 0
  const dir    = trade.direction === 'LONG' ? 1 : -1
  const done   = (curP - trade.entry) * dir
  const needed = Math.abs(trade.takeProfit1 - trade.entry)
  if (needed <= 0) return 0
  return Math.max(-50, Math.min(110, (done / needed) * 100))
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60)  return `${s}s fa`
  const m = Math.floor(s / 60)
  if (m < 60)  return `${m}m fa`
  const hr = Math.floor(m / 60)
  return `${hr}h ${m % 60}m fa`
}

function gradeBadge(grade: string) {
  return { 'A+': 'bg-yellow-400 text-black', 'A': 'bg-yellow-400/70 text-black', 'B': 'bg-blue-400/30 text-blue-300', 'C': 'bg-gray-500/20 text-gray-400' }[grade] ?? 'bg-gray-500/20 text-gray-400'
}

function formatPrice(p: number | undefined) {
  if (!p) return '—'
  if (p < 0.01) return p.toFixed(6)
  if (p < 1)    return p.toFixed(4)
  return p.toFixed(2)
}

async function saveConfig() {
  await store.updateConfig(activeTf.value, cfg.value)
  showConfig.value = false
  toast.add({ severity: 'success', summary: 'Config salvata', life: 2000 })
}

function confirmReset() {
  confirm.require({
    message: `Cancellare tutti i trade simulati (${activeTf.value}) e resettare il capitale?`,
    header: 'Reset simulazione',
    icon: 'pi pi-exclamation-triangle',
    rejectProps: { label: 'Annulla', severity: 'secondary', text: true },
    acceptProps: { label: 'Reset', severity: 'danger' },
    accept: async () => {
      await store.reset(activeTf.value)
      toast.add({ severity: 'info', summary: `Sim ${activeTf.value} resettata`, life: 2000 })
    },
  })
}

async function loadTf(tf: Tf) {
  isLoading.value = true
  try {
    await Promise.all([store.fetchAnalytics(tf), store.fetchTrades(tf)])
    if (store.analytics[tf]?.config) Object.assign(cfg.value, store.analytics[tf]!.config)
  } finally {
    isLoading.value = false
  }
}

watch(activeTf, (tf) => { void loadTf(tf) })

let refreshTimer: ReturnType<typeof setInterval>

onMounted(async () => {
  await loadTf(activeTf.value)
  refreshTimer = setInterval(() => {
    void store.refreshAnalytics(activeTf.value)
    void store.fetchTrades(activeTf.value)
  }, 30_000)
})

onUnmounted(() => {
  clearInterval(refreshTimer)
})
</script>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active { transition: opacity 0.18s ease; }
.modal-fade-enter-from,
.modal-fade-leave-to    { opacity: 0; }
</style>
