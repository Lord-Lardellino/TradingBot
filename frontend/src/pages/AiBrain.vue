<template>
  <div class="p-6 space-y-5">

    <!-- ── Header ──────────────────────────────────────────────────────── -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          🧠 AI Brain
          <span
            class="text-xs font-normal px-2 py-0.5 rounded-full border"
            :class="params?.enabled
              ? 'border-green-500/40 text-green-400 bg-green-500/10'
              : 'border-gray-600 text-gray-500 bg-surface-200'"
          >
            {{ params?.enabled ? 'ATTIVO' : 'DISATTIVATO' }}
          </span>
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          Analizza i trade chiusi ogni 5 min · aggiusta i parametri strategia in autonomia
        </p>
      </div>
      <Button
        size="small"
        icon="pi pi-refresh"
        severity="secondary"
        :loading="store.loading"
        @click="store.fetchAll()"
      />
    </div>

    <!-- ── KILL SWITCH ──────────────────────────────────────────────────── -->
    <div
      class="rounded-xl border p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 transition-colors"
      :class="params?.enabled
        ? 'border-green-500/30 bg-green-500/5'
        : 'border-white/8 bg-surface-50'"
    >
      <div class="flex items-start gap-3">
        <div
          class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-xl"
          :class="params?.enabled ? 'bg-green-500/20' : 'bg-surface-200'"
        >
          🧠
        </div>
        <div>
          <div class="font-semibold text-white text-sm">
            {{ params?.enabled ? 'AI Brain in esecuzione' : 'AI Brain disattivato' }}
          </div>
          <div class="text-xs text-gray-500 mt-0.5 max-w-lg">
            <span v-if="params?.enabled">
              Il brain analizza i trade ogni 5 min e aggiusta automaticamente i parametri dello scanner
              per avvicinarsi al 60% di win rate. Puoi disattivarlo in qualsiasi momento.
            </span>
            <span v-else>
              Quando attivo, il brain monitora le performance e aggiusta
              <strong class="text-gray-400">atrMultSl, minEmitScore, enterGrades, minEma5mSlope</strong>
              in modo conservativo. Max 2 parametri per ciclo, entro range di sicurezza.
            </span>
          </div>
          <div v-if="params?.lastAnalysisAt" class="text-xs text-gray-600 mt-1">
            Ultima analisi: {{ fmtDate(params.lastAnalysisAt) }} ·
            Win rate rilevata: <span :class="winRateClass(params.lastWinRate ?? 0)">{{ params.lastWinRate?.toFixed(1) }}%</span> ·
            {{ params.totalAnalyses }} analisi totali
          </div>
        </div>
      </div>

      <button
        class="flex-shrink-0 px-6 py-2.5 rounded-lg font-bold text-sm transition-all"
        :class="params?.enabled
          ? 'bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30'
          : 'bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30'"
        :disabled="toggling"
        @click="handleToggle"
      >
        <i class="pi mr-2" :class="params?.enabled ? 'pi-stop-circle' : 'pi-play-circle'" />
        {{ params?.enabled ? 'DISATTIVA BRAIN' : 'ATTIVA BRAIN' }}
      </button>
    </div>

    <!-- ── Parametri correnti ───────────────────────────────────────────── -->
    <div class="stat-card !p-0 overflow-hidden">
      <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
        <span class="font-semibold text-white text-sm">Parametri Strategia</span>
        <div class="flex items-center gap-2">
          <span class="text-xs text-gray-600">modificabili anche quando il brain è spento</span>
          <button
            class="text-xs text-gray-500 hover:text-white transition-colors px-2 py-1 rounded border border-white/5 hover:border-white/20"
            @click="confirmReset"
          >
            Reset default
          </button>
        </div>
      </div>

      <div class="divide-y divide-white/5">
        <ParamRow
          v-for="def in paramDefs"
          :key="def.key"
          :def="def"
          :value="params?.[def.key]"
          :default-value="def.default"
          :editing="editingKey === def.key"
          @edit="editingKey = def.key"
          @save="saveParam(def.key, $event)"
          @cancel="editingKey = null"
        />
      </div>
    </div>

    <!-- ── Log analisi ──────────────────────────────────────────────────── -->
    <div class="stat-card !p-0 overflow-hidden">
      <div class="flex items-center justify-between px-5 py-3 border-b border-white/5">
        <span class="font-semibold text-white text-sm">Log Decisioni Brain</span>
        <span class="text-xs text-gray-600">ultimi 30 cicli</span>
      </div>

      <div v-if="!store.log.length" class="flex flex-col items-center py-10 text-gray-600">
        <i class="pi pi-list text-2xl mb-2 text-gray-700" />
        <div class="text-sm">Nessuna analisi ancora eseguita</div>
        <div class="text-xs mt-1">Il brain deve essere attivo e ci vogliono almeno 10 trade chiusi</div>
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-gray-500 border-b border-white/5">
              <th class="text-left px-5 py-2.5 font-medium">Ora</th>
              <th class="text-center px-4 py-2.5 font-medium">Win Rate</th>
              <th class="text-center px-4 py-2.5 font-medium">Trade</th>
              <th class="text-center px-4 py-2.5 font-medium">Azione</th>
              <th class="text-left px-5 py-2.5 font-medium">Riepilogo</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in store.log"
              :key="entry.id"
              class="border-b border-white/5 last:border-0 hover:bg-white/3 transition-colors cursor-pointer"
              @click="expandedLog = expandedLog === entry.id ? null : entry.id"
            >
              <td class="px-5 py-3 text-xs font-mono text-gray-500">
                {{ fmtDate(entry.createdAt) }}
              </td>
              <td class="px-4 py-3 text-center">
                <span class="font-bold font-mono" :class="winRateClass(entry.winRate)">
                  {{ entry.winRate.toFixed(1) }}%
                </span>
              </td>
              <td class="px-4 py-3 text-center text-xs text-gray-500 font-mono">
                {{ entry.tradesAnalyzed }}
              </td>
              <td class="px-4 py-3 text-center">
                <span
                  class="text-xs px-2 py-0.5 rounded font-medium"
                  :class="actionClass(entry.action)"
                >
                  {{ actionLabel(entry.action) }}
                </span>
              </td>
              <td class="px-5 py-3">
                <div class="text-xs text-gray-400 truncate max-w-xs">{{ entry.summary }}</div>
                <!-- Expanded: show individual changes -->
                <div v-if="expandedLog === entry.id" class="mt-2 space-y-1">
                  <div
                    v-for="(ch, i) in store.parsedChanges(entry)"
                    :key="i"
                    class="text-xs text-gray-500 flex items-start gap-2"
                  >
                    <span class="text-indigo-400 font-mono">{{ ch.param }}</span>
                    <span class="text-gray-600">{{ ch.from }} → {{ ch.to }}</span>
                    <span class="text-gray-600 italic">{{ ch.reason }}</span>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- ── Info box ─────────────────────────────────────────────────────── -->
    <div class="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 text-xs text-gray-500 space-y-1.5">
      <div class="font-semibold text-indigo-300 mb-2">Come funziona il Brain</div>
      <div>📊 <strong class="text-gray-400">Ogni 5 minuti</strong> analizza gli ultimi 20 trade chiusi</div>
      <div>🎯 <strong class="text-gray-400">Obiettivo</strong>: mantenere un win rate ≥ 60%</div>
      <div>🔧 <strong class="text-gray-400">Max 2 parametri</strong> modificati per ciclo, in modo conservativo</div>
      <div>🛡️ <strong class="text-gray-400">Range di sicurezza</strong>: ogni parametro ha limiti min/max invalicabili</div>
      <div>🚨 <strong class="text-gray-400">Modalità crisi</strong>: se win rate &lt; 30%, limita automaticamente ai soli segnali A+</div>
      <div>✅ <strong class="text-gray-400">Recovery</strong>: se win rate ≥ 65%, rilassa i vincoli per catturare più opportunità</div>
      <div>⚡ <strong class="text-gray-400">Kill switch</strong>: disattivabile istantaneamente — i parametri rimangono all'ultimo valore</div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, defineComponent, h, resolveComponent } from 'vue'
import { useBrainStore, DEFAULTS } from '@/stores/aiBrain'
import type { BrainParams } from '@/stores/aiBrain'
import { useConfirm } from 'primevue/useconfirm'

const store   = useBrainStore()
const confirm = useConfirm()
const params  = computed(() => store.params)

const toggling    = ref(false)
const editingKey  = ref<string | null>(null)
const expandedLog = ref<number | null>(null)

// ── Definizione parametri ───────────────────────────────────────────────────
interface ParamDef {
  key:      keyof BrainParams
  label:    string
  desc:     string
  default:  number | string
  type:     'float' | 'int' | 'string'
  step?:    number
  min?:     number
  max?:     number
}

const paramDefs: ParamDef[] = [
  { key: 'atrMultSl',     label: 'ATR Mult. SL',      desc: 'Moltiplicatore ATR per Stop Loss (più alto = SL più largo)',         default: 2.0,   type: 'float', step: 0.1,   min: 1.5, max: 3.5   },
  { key: 'tp1Rr',         label: 'TP1 R/R',            desc: 'Rapporto rischio/rendimento per TP1',                                default: 2.5,   type: 'float', step: 0.1,   min: 1.5, max: 4.0   },
  { key: 'tp2Rr',         label: 'TP2 R/R',            desc: 'Rapporto rischio/rendimento per TP2 (obiettivo principale)',         default: 4.0,   type: 'float', step: 0.25,  min: 2.0, max: 6.0   },
  { key: 'minSlPct',      label: 'SL minimo %',        desc: 'Stop loss minimo in % del prezzo di entrata',                       default: 0.6,   type: 'float', step: 0.05,  min: 0.4, max: 1.5   },
  { key: 'minEma5mSlope', label: 'Slope EMA 5m min',  desc: 'Slope minimo EMA(34) sul 5m per accettare un segnale (anti-sideways)', default: 0.003, type: 'float', step: 0.001, min: 0.001, max: 0.015 },
  { key: 'minEmitScore',  label: 'Score minimo',       desc: 'Score minimo per emettere un segnale dal scanner',                  default: 38,    type: 'int',   step: 1,     min: 35, max: 70    },
  { key: 'minVolRatio',   label: 'Volume ratio min',   desc: 'Volume attuale vs media: filtro liquidità',                         default: 1.0,   type: 'float', step: 0.1,   min: 0.8, max: 2.5   },
  { key: 'enterGrades',   label: 'Grade auto-enter',   desc: 'Gradi che il simulatore entra automaticamente (es. A+,A o solo A+)', default: 'A+,A', type: 'string' },
]

// ── Helpers ─────────────────────────────────────────────────────────────────
function winRateClass(wr: number) {
  if (wr >= 60) return 'text-profit'
  if (wr >= 45) return 'text-yellow-400'
  return 'text-loss'
}

function actionClass(action: string) {
  switch (action) {
    case 'crisis':  return 'bg-red-500/15 text-red-400'
    case 'adjust':  return 'bg-yellow-500/15 text-yellow-400'
    default:        return 'bg-green-500/15 text-green-400'
  }
}

function actionLabel(action: string) {
  switch (action) {
    case 'crisis':  return '🚨 Crisi'
    case 'adjust':  return '🔧 Aggiustato'
    default:        return '✅ Monitorato'
  }
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }) + ' ' +
         d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// ── Actions ─────────────────────────────────────────────────────────────────
async function handleToggle() {
  toggling.value = true
  try {
    await store.toggle(!params.value?.enabled)
  } finally {
    toggling.value = false
  }
}

async function saveParam(key: string, value: number | string) {
  await store.updateParam(key, value)
  editingKey.value = null
}

function confirmReset() {
  confirm.require({
    message:       'Ripristinare tutti i parametri ai valori di default?',
    header:        'Reset parametri',
    icon:          'pi pi-exclamation-triangle',
    acceptClass:   'p-button-danger',
    acceptLabel:   'Reset',
    rejectLabel:   'Annulla',
    accept:        () => store.resetDefaults(),
  })
}

onMounted(() => store.fetchAll())
</script>

<!-- ── ParamRow component (inline) ─────────────────────────────────────── -->
<script lang="ts">
import { defineComponent as dc, ref as r, computed as c, h as _h } from 'vue'

export const ParamRow = dc({
  name: 'ParamRow',
  props: {
    def:          { type: Object,  required: true },
    value:        { type: [Number, String, Boolean], default: undefined },
    defaultValue: { type: [Number, String], required: true },
    editing:      { type: Boolean, default: false },
  },
  emits: ['edit', 'save', 'cancel'],
  setup(props, { emit }) {
    const draft = r<string>('')

    function startEdit() {
      draft.value = String(props.value ?? props.defaultValue)
      emit('edit')
    }

    function save() {
      const def = props.def as any
      const v = def.type === 'int' ? parseInt(draft.value) : def.type === 'float' ? parseFloat(draft.value) : draft.value
      emit('save', v)
    }

    const changed = c(() => {
      const cur = props.value
      const def = props.defaultValue
      return cur !== undefined && String(cur) !== String(def)
    })

    return () => {
      const def = props.def as any
      const val = props.value ?? props.defaultValue

      if (props.editing) {
        return _h('div', { class: 'flex items-center gap-3 px-5 py-3 bg-surface-200/50' }, [
          _h('div', { class: 'w-48 flex-shrink-0' }, [
            _h('div', { class: 'text-xs font-semibold text-white' }, def.label),
          ]),
          _h('input', {
            class: 'bg-surface-300 border border-white/10 rounded px-2 py-1 text-xs font-mono text-white w-32 focus:outline-none focus:border-indigo-500',
            value: draft.value,
            onInput: (e: any) => { draft.value = e.target.value },
            onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') emit('cancel') },
          }),
          _h('span', { class: 'text-xs text-gray-600' }, `range: ${def.min ?? '—'} – ${def.max ?? '—'}`),
          _h('button', {
            class: 'text-xs px-2 py-1 bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded hover:bg-indigo-500/30 transition-colors',
            onClick: save,
          }, 'Salva'),
          _h('button', {
            class: 'text-xs px-2 py-1 text-gray-500 hover:text-white transition-colors',
            onClick: () => emit('cancel'),
          }, 'Annulla'),
        ])
      }

      return _h('div', {
        class: 'flex items-center gap-3 px-5 py-3 hover:bg-white/3 transition-colors group cursor-pointer',
        onClick: startEdit,
      }, [
        _h('div', { class: 'w-48 flex-shrink-0' }, [
          _h('div', { class: 'text-xs font-semibold text-white' }, def.label),
          _h('div', { class: 'text-[10px] text-gray-600 mt-0.5 max-w-xs' }, def.desc),
        ]),
        _h('div', { class: 'flex items-center gap-2' }, [
          _h('span', {
            class: `font-mono font-bold text-sm ${changed.value ? 'text-indigo-300' : 'text-gray-300'}`,
          }, String(val)),
          changed.value
            ? _h('span', { class: 'text-[10px] font-mono text-gray-600' }, `(default: ${props.defaultValue})`)
            : null,
          changed.value
            ? _h('span', { class: 'w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse' })
            : null,
        ]),
        _h('i', { class: 'pi pi-pencil text-gray-700 group-hover:text-gray-400 ml-auto text-xs transition-colors' }),
      ])
    }
  },
})
</script>
