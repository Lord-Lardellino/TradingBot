<template>
  <div class="p-4 md:p-6 max-w-7xl mx-auto space-y-5">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h1 class="text-xl font-bold text-white flex items-center gap-2">
          <i class="pi pi-telegram text-brand" />
          Telegram Signals
        </h1>
        <p class="text-xs text-gray-500 mt-0.5">
          GramJS, Gemini parser, ordini MEXC in SIM o LIVE per canale.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button @click="loadDialogs" class="btn-soft">
          <i class="pi pi-refresh" />
          Dialoghi
        </button>
        <button @click="load" class="btn-soft">
          <i class="pi pi-sync" />
          Aggiorna
        </button>
      </div>
    </div>

    <div v-if="hasLiveChannel" class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
      Live attivo su almeno un canale: i nuovi segnali validi possono aprire ordini reali su MEXC.
    </div>

    <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
      <div class="panel">
        <div class="label">Telegram</div>
        <div :class="['value', telegram.connected ? 'text-profit' : 'text-gray-400']">
          {{ telegram.connected ? 'Connesso' : telegram.configured ? 'Pronto' : 'Non configurato' }}
        </div>
      </div>
      <div class="panel">
        <div class="label">Canali</div>
        <div class="value">{{ channels.length }}</div>
      </div>
      <div class="panel">
        <div class="label">Trade aperti</div>
        <div class="value text-white">{{ openTrades.length }}</div>
      </div>
      <div class="panel">
        <div class="label">Win rate</div>
        <div class="value">{{ stats.winRate }}%</div>
      </div>
      <div class="panel">
        <div class="label">PnL sim</div>
        <div :class="['value', (stats.pnl || 0) >= 0 ? 'text-profit' : 'text-loss']">
          ${{ money(stats.pnl) }}
        </div>
      </div>
    </div>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Brain Gemini</h2>
          <p>Memoria globale costruita dai messaggi non operativi utili di tutti i canali.</p>
        </div>
        <span :class="['badge', promptMemory.summary ? 'badge-ok' : 'badge-muted']">
          {{ promptMemory.summary ? 'attivo' : 'vuoto' }}
        </span>
      </div>
      <div v-if="promptMemory.summary" class="rounded-lg border border-white/5 bg-surface-0 p-3">
        <pre class="whitespace-pre-wrap break-words text-xs text-gray-300 font-sans">{{ promptMemory.summary }}</pre>
        <div v-if="promptMemory.lastNews" class="mt-3 border-t border-white/5 pt-2 text-[10px] text-gray-500">
          Ultimo update: {{ promptMemory.lastNews }}
        </div>
      </div>
      <div v-else class="text-sm text-gray-500 py-3">
        In attesa di news o commenti di mercato utili. Risultati VIP, promo e performance passate vengono saltati.
      </div>
    </section>

    <div class="grid xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
      <section class="section">
        <div class="section-head">
          <div>
            <h2>Canali monitorati</h2>
            <p>SIM di default, LIVE solo quando lo abiliti sul singolo canale.</p>
          </div>
          <button @click="addChannel" class="btn-primary">
            <i class="pi pi-plus" />
            Aggiungi
          </button>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="text-left text-gray-500 border-b border-white/5">
                <th class="py-2 pr-3">Canale</th>
                <th class="py-2 px-3">Stato</th>
                <th class="py-2 px-3">Mode</th>
                <th class="py-2 px-3">Risk</th>
                <th class="py-2 px-3">Leva</th>
                <th class="py-2 px-3">Conf</th>
                <th class="py-2 pl-3 text-right">Azioni</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!channels.length">
                <td colspan="7" class="py-8 text-center text-gray-500">Nessun canale configurato.</td>
              </tr>
              <tr v-for="c in channels" :key="c.id" class="border-b border-white/5 align-top">
                <td class="py-2 pr-3 min-w-[220px]">
                  <input v-model="c.title" class="input mb-1" placeholder="Titolo" @change="saveChannel(c)" />
                  <div class="flex gap-2">
                    <input v-model="c.channelId" class="input font-mono" disabled />
                    <input v-model="c.username" class="input font-mono" placeholder="@username" @change="saveChannel(c)" />
                  </div>
                </td>
                <td class="py-2 px-3">
                  <button @click="toggleChannel(c, 'enabled')" :class="['toggle', c.enabled ? 'toggle-on' : 'toggle-off']">
                    {{ c.enabled ? 'ON' : 'OFF' }}
                  </button>
                </td>
                <td class="py-2 px-3">
                  <button @click="toggleMode(c)" :class="['toggle', c.mode === 'live' ? 'toggle-live' : 'toggle-off']">
                    {{ c.mode === 'live' ? 'LIVE' : 'SIM' }}
                  </button>
                </td>
                <td class="py-2 px-3 w-24">
                  <input v-model.number="c.riskPct" type="number" step="0.25" class="input text-right" @change="saveChannel(c)" />
                </td>
                <td class="py-2 px-3 w-20">
                  <input v-model.number="c.levaMax" type="number" class="input text-right" @change="saveChannel(c)" />
                </td>
                <td class="py-2 px-3 w-24">
                  <input v-model.number="c.minConf" type="number" min="0" max="1" step="0.05" class="input text-right" @change="saveChannel(c)" />
                </td>
                <td class="py-2 pl-3 text-right">
                  <button @click="removeChannel(c)" class="icon-btn" title="Rimuovi canale">
                    <i class="pi pi-trash" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <aside class="section">
        <div class="section-head">
          <div>
            <h2>Nuovo canale</h2>
            <p>Usa ID dialogo o incolla manualmente l'ID Telegram.</p>
          </div>
        </div>

        <div class="space-y-3">
          <label class="field">
            ID canale
            <input v-model="draft.channelId" class="input" placeholder="-100..." />
          </label>
          <label class="field">
            Titolo
            <input v-model="draft.title" class="input" placeholder="Nome canale" />
          </label>
          <label class="field">
            Username
            <input v-model="draft.username" class="input" placeholder="@handle" />
          </label>
          <div class="grid grid-cols-3 gap-2">
            <label class="field">
              Risk %
              <input v-model.number="draft.riskPct" type="number" step="0.25" class="input" />
            </label>
            <label class="field">
              Leva
              <input v-model.number="draft.levaMax" type="number" class="input" />
            </label>
            <label class="field">
              Conf
              <input v-model.number="draft.minConf" type="number" min="0" max="1" step="0.05" class="input" />
            </label>
          </div>
        </div>

        <div class="mt-4 border-t border-white/5 pt-3">
          <div class="flex items-center justify-between mb-2">
            <div class="text-xs font-semibold text-gray-400">Dialoghi Telegram</div>
            <span class="text-[10px] text-gray-600">{{ dialogs.length }}</span>
          </div>
          <div class="max-h-72 overflow-y-auto space-y-1">
            <button
              v-for="d in dialogs"
              :key="d.id"
              @click="pickDialog(d)"
              class="w-full text-left rounded-lg border border-white/5 bg-surface-0 px-2 py-2 hover:border-brand/50"
            >
              <div class="text-xs text-gray-200 truncate">{{ d.title }}</div>
              <div class="text-[10px] text-gray-500 font-mono truncate">{{ d.id }} {{ d.username ? '@' + d.username : '' }}</div>
            </button>
            <div v-if="!dialogs.length" class="text-xs text-gray-500 py-4 text-center">
              Dialoghi disponibili dopo TG_SESSION.
            </div>
          </div>
        </div>
      </aside>
    </div>

    <section v-if="openTrades.length" class="section">
      <div class="section-head">
        <div>
          <h2>Trade aperti</h2>
          <p>Chiusura manuale al prezzo corrente, SIM o LIVE.</p>
        </div>
      </div>
      <div class="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
        <div v-for="t in openTrades" :key="t.id" class="trade-card">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div :class="['text-sm font-bold', t.side === 'long' ? 'text-profit' : 'text-loss']">
                {{ t.side === 'long' ? 'LONG' : 'SHORT' }} {{ t.symbol }}
              </div>
              <div class="text-[10px] text-gray-500">{{ channelName(t.channelDbId) }} - {{ t.mode }}</div>
            </div>
            <button @click="closeTrade(t)" class="icon-btn" title="Chiudi trade">
              <i class="pi pi-times" />
            </button>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-3 text-xs font-mono">
            <div><div class="label">Entry</div><div class="text-white">{{ fmt(t.entry) }}</div></div>
            <div><div class="label">SL</div><div class="text-loss">{{ fmt(t.stopLoss) }}</div></div>
            <div><div class="label">Qty</div><div class="text-white">{{ fmt(t.qty, 0) }}</div></div>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <div>
          <h2>Ultimi messaggi</h2>
          <p>Testo raw, JSON Gemini, stato esecuzione.</p>
        </div>
        <button @click="resetSignals" class="btn-soft">
          <i class="pi pi-trash" />
          Reset
        </button>
      </div>

      <div class="space-y-2">
        <article v-for="s in recent" :key="s.id" class="signal-row">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span :class="typeClass(s.type)">{{ s.type }}</span>
                <span :class="statusClass(s)">{{ s.tradeStatus !== 'none' ? s.tradeStatus : s.status }}</span>
                <span class="text-xs font-mono text-gray-400">{{ s.symbol || parsedOf(s).symbol || '-' }}</span>
                <span class="text-[10px] text-gray-500">{{ channelName(s.channelDbId) }}</span>
              </div>
              <p class="mt-2 text-xs text-gray-300 whitespace-pre-wrap break-words">{{ s.rawText }}</p>
              <pre class="mt-2 rounded bg-surface-0 border border-white/5 p-2 text-[10px] text-gray-500 overflow-x-auto">{{ prettyParsed(s) }}</pre>
              <div v-if="s.note" class="mt-1 text-[10px] text-gray-500">{{ s.note }}</div>
            </div>
            <div class="text-right text-[10px] text-gray-600 shrink-0">
              {{ dateOf(s.createdAt) }}
            </div>
          </div>
        </article>
        <div v-if="!recent.length" class="text-sm text-gray-500 text-center py-8">
          Nessun messaggio processato.
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import axios from 'axios'

type TgChannel = {
  id: number
  channelId: string
  username?: string | null
  title?: string | null
  enabled: boolean
  mode: 'sim' | 'live'
  riskPct: number
  levaMax: number
  minConf: number
  tpSplit: string
}

type TgSignal = Record<string, any>
type Dialog = { id: string; title: string; username?: string; isChannel: boolean }

const telegram = ref({ configured: false, connected: false })
const channels = ref<TgChannel[]>([])
const openTrades = ref<TgSignal[]>([])
const recent = ref<TgSignal[]>([])
const dialogs = ref<Dialog[]>([])
const promptMemory = ref({ summary: '', lastNews: '', lastAnalysis: '' })
const stats = ref({ closed: 0, wins: 0, losses: 0, winRate: 0, pnl: 0 })
const draft = ref({ channelId: '', title: '', username: '', riskPct: 4, levaMax: 20, minConf: 0.6 })
let timer: ReturnType<typeof setInterval> | null = null

const hasLiveChannel = computed(() => channels.value.some((c) => c.enabled && c.mode === 'live'))

async function load() {
  try {
    const { data } = await axios.get('/api/tg-signals/dashboard')
    telegram.value = data.telegram || telegram.value
    channels.value = data.channels || []
    openTrades.value = data.openTrades || []
    recent.value = data.recent || []
    promptMemory.value = data.promptMemory || { summary: '', lastNews: '', lastAnalysis: '' }
    stats.value = data.stats || stats.value
  } catch {}
}

async function loadDialogs() {
  const { data } = await axios.get('/api/tg-signals/dialogs')
  dialogs.value = data || []
}

async function addChannel() {
  if (!draft.value.channelId.trim()) return
  await axios.post('/api/tg-signals/channels', {
    ...draft.value,
    channelId: draft.value.channelId.trim(),
    username: draft.value.username?.trim() || null,
    title: draft.value.title?.trim() || null,
    mode: 'sim',
    enabled: true,
  })
  draft.value = { channelId: '', title: '', username: '', riskPct: 4, levaMax: 20, minConf: 0.6 }
  await load()
}

async function saveChannel(c: TgChannel) {
  await axios.patch(`/api/tg-signals/channels/${c.id}`, {
    username: c.username || null,
    title: c.title || null,
    enabled: c.enabled,
    mode: c.mode,
    riskPct: Number(c.riskPct),
    levaMax: Number(c.levaMax),
    minConf: Number(c.minConf),
    tpSplit: c.tpSplit || '50,30,20',
  })
  await load()
}

async function toggleChannel(c: TgChannel, key: 'enabled') {
  c[key] = !c[key]
  await saveChannel(c)
}

async function toggleMode(c: TgChannel) {
  c.mode = c.mode === 'live' ? 'sim' : 'live'
  await saveChannel(c)
}

async function removeChannel(c: TgChannel) {
  if (!confirm(`Rimuovere ${c.title || c.username || c.channelId}?`)) return
  await axios.delete(`/api/tg-signals/channels/${c.id}`)
  await load()
}

async function closeTrade(t: TgSignal) {
  await axios.post(`/api/tg-signals/signals/${t.id}/close`)
  await load()
}

async function resetSignals() {
  if (!confirm('Cancellare tutti i segnali Telegram salvati?')) return
  await axios.post('/api/tg-signals/reset')
  await load()
}

function pickDialog(d: Dialog) {
  draft.value.channelId = d.id
  draft.value.title = d.title
  draft.value.username = d.username || ''
}

function channelName(id: number) {
  const c = channels.value.find((x) => x.id === id)
  return c?.title || c?.username || c?.channelId || '-'
}

function parsedOf(s: TgSignal) {
  try { return JSON.parse(s.parsed || '{}') } catch { return {} }
}

function prettyParsed(s: TgSignal) {
  try { return JSON.stringify(JSON.parse(s.parsed || '{}'), null, 2) } catch { return s.parsed || '{}' }
}

function fmt(v: any, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return '-'
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })
}

function money(v: any) {
  return fmt(v ?? 0, 4)
}

function dateOf(v: string) {
  if (!v) return ''
  return new Date(v).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
}

function typeClass(type: string) {
  return ['badge', type === 'NEW' ? 'badge-new' : type === 'UPDATE' ? 'badge-update' : type === 'CLOSE' ? 'badge-close' : 'badge-muted']
}

function statusClass(s: TgSignal) {
  const st = s.tradeStatus !== 'none' ? s.tradeStatus : s.status
  return ['badge', ['open', 'win', 'executed', 'context'].includes(st) ? 'badge-ok' : ['loss', 'error'].includes(st) ? 'badge-bad' : 'badge-muted']
}

onMounted(() => {
  load()
  timer = setInterval(load, 3000)
})
onUnmounted(() => { if (timer) clearInterval(timer) })
</script>

<style scoped>
.panel { @apply rounded-lg border border-white/5 bg-surface-50 p-3; }
.section { @apply rounded-lg border border-white/5 bg-surface-50 p-4; }
.section-head { @apply flex items-start justify-between gap-3 mb-3; }
.section h2 { @apply text-sm font-bold text-white; }
.section p { @apply text-xs text-gray-500 mt-0.5; }
.label { @apply text-[10px] uppercase tracking-wide text-gray-500; }
.value { @apply text-lg font-bold text-white; }
.field { @apply text-xs text-gray-400 space-y-1 block; }
.input { @apply w-full rounded bg-surface-0 border border-white/10 px-2 py-1.5 text-xs text-white outline-none focus:border-brand/60; }
.btn-soft { @apply inline-flex items-center gap-2 rounded-lg border border-white/10 bg-surface-200 px-3 py-1.5 text-xs font-semibold text-gray-300 hover:text-white; }
.btn-primary { @apply inline-flex items-center gap-2 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90; }
.icon-btn { @apply inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-surface-200 text-gray-400 hover:text-white; }
.toggle { @apply min-w-14 rounded border px-2 py-1 text-xs font-bold; }
.toggle-on { @apply border-profit/30 bg-profit/15 text-profit; }
.toggle-live { @apply border-red-500/40 bg-red-500/15 text-red-300; }
.toggle-off { @apply border-white/10 bg-surface-200 text-gray-400; }
.trade-card { @apply rounded-lg border border-white/5 bg-surface-0 p-3; }
.signal-row { @apply rounded-lg border border-white/5 bg-surface-0 p-3; }
.badge { @apply inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold; }
.badge-new { @apply bg-brand/20 text-brand; }
.badge-update { @apply bg-sky-500/20 text-sky-300; }
.badge-close { @apply bg-orange-500/20 text-orange-300; }
.badge-ok { @apply bg-profit/20 text-profit; }
.badge-bad { @apply bg-loss/20 text-loss; }
.badge-muted { @apply bg-white/5 text-gray-400; }
</style>
