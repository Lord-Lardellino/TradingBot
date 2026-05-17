import { defineStore } from 'pinia'
import { ref } from 'vue'
import axios from 'axios'

export interface BrainParams {
  enabled:       boolean
  atrMultSl:     number
  tp1Rr:         number
  tp2Rr:         number
  minSlPct:      number
  minEma5mSlope: number
  minEmitScore:  number
  minVolRatio:   number
  enterGrades:   string
  lastAnalysisAt?: string | null
  lastWinRate?:    number | null
  totalAnalyses:   number
  updatedAt?:      string
}

export interface BrainLog {
  id:             number
  createdAt:      string
  winRate:        number
  tradesAnalyzed: number
  changes:        string   // JSON string
  summary:        string
  action:         string   // monitor | adjust | crisis
}

export const DEFAULTS: Omit<BrainParams, 'enabled' | 'lastAnalysisAt' | 'lastWinRate' | 'totalAnalyses' | 'updatedAt'> = {
  atrMultSl:     2.0,
  tp1Rr:         2.5,
  tp2Rr:         4.0,
  minSlPct:      0.6,
  minEma5mSlope: 0.003,
  minEmitScore:  38,
  minVolRatio:   1.0,
  enterGrades:   'A+,A',
}

export const useBrainStore = defineStore('brain', () => {
  const params  = ref<BrainParams | null>(null)
  const log     = ref<BrainLog[]>([])
  const loading = ref(false)

  async function fetchParams() {
    const { data } = await axios.get('/api/brain/params')
    params.value = data
  }

  async function fetchLog() {
    const { data } = await axios.get('/api/brain/log?limit=30')
    log.value = data
  }

  async function fetchAll() {
    loading.value = true
    try { await Promise.all([fetchParams(), fetchLog()]) }
    finally { loading.value = false }
  }

  async function toggle(enabled: boolean) {
    const { data } = await axios.post('/api/brain/toggle', { enabled })
    params.value = data
  }

  async function updateParam(key: string, value: number | string) {
    const { data } = await axios.patch('/api/brain/params', { [key]: value })
    params.value = data
  }

  async function resetDefaults() {
    const { data } = await axios.post('/api/brain/reset')
    params.value = data
    await fetchLog()
  }

  async function clearBrain() {
    const { data } = await axios.post('/api/brain/clear')
    params.value = data
    log.value = []
  }

  function parsedChanges(log: BrainLog): Array<{ param: string; from: any; to: any; reason: string }> {
    try { return JSON.parse(log.changes) } catch { return [] }
  }

  return { params, log, loading, fetchAll, fetchParams, fetchLog, toggle, updateParam, resetDefaults, clearBrain, parsedChanges }
})
