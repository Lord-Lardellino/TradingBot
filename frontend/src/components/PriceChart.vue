<template>
  <div ref="chartEl" class="w-full" :style="{ height: height + 'px' }" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type IPriceLine,
  ColorType,
  LineStyle,
} from 'lightweight-charts'
import axios from 'axios'

export interface PriceLineConfig {
  price: number
  color: string
  label: string
  dashed?: boolean
}

const props = defineProps<{
  symbol: string
  timeframe?: string
  height?: number
  lines?: PriceLineConfig[]
  showEma34?: boolean
}>()

const chartEl = ref<HTMLElement>()
let chart: IChartApi
let candleSeries: ISeriesApi<'Candlestick'>
let emaSeries34: ISeriesApi<'Line'> | null = null
let activePriceLines: IPriceLine[] = []

const height = props.height ?? 320

function computeEMA(data: CandlestickData[], period: number) {
  const k = 2 / (period + 1)
  const result: { time: any; value: number }[] = []
  let ema = 0
  data.forEach((d, i) => {
    if (i < period) {
      ema += d.close
      if (i === period - 1) {
        ema /= period
        result.push({ time: d.time, value: ema })
      }
    } else {
      ema = d.close * k + ema * (1 - k)
      result.push({ time: d.time, value: ema })
    }
  })
  return result
}

function applyPriceLines() {
  if (!candleSeries) return
  activePriceLines.forEach(pl => candleSeries.removePriceLine(pl))
  activePriceLines = []
  for (const l of (props.lines ?? [])) {
    const pl = candleSeries.createPriceLine({
      price:            l.price,
      color:            l.color,
      lineWidth:        2,
      lineStyle:        l.dashed ? LineStyle.Dashed : LineStyle.Solid,
      axisLabelVisible: true,
      title:            l.label,
    })
    activePriceLines.push(pl)
  }
}

async function loadData() {
  if (!chart) return
  const { data } = await axios.get('/api/mexc/ohlcv', {
    params: { symbol: props.symbol, timeframe: props.timeframe ?? '1m', limit: 200 },
  })
  const candles: CandlestickData[] = data.map((d: any) => ({
    time:  Math.floor(d.timestamp / 1000),
    open:  d.open,
    high:  d.high,
    low:   d.low,
    close: d.close,
  }))
  candleSeries.setData(candles)
  if (emaSeries34) emaSeries34.setData(computeEMA(candles, 34))
  applyPriceLines()
  chart.timeScale().fitContent()
}

onMounted(() => {
  chart = createChart(chartEl.value!, {
    width: chartEl.value!.clientWidth,
    height,
    layout: {
      background: { type: ColorType.Solid, color: '#13131e' },
      textColor: '#9ca3af',
    },
    grid: {
      vertLines: { color: '#1a1a28' },
      horzLines: { color: '#1a1a28' },
    },
    crosshair: { mode: 1 },
    rightPriceScale: { borderColor: '#22223a' },
    timeScale: { borderColor: '#22223a', timeVisible: true },
  })

  candleSeries = chart.addCandlestickSeries({
    upColor:       '#22c55e',
    downColor:     '#ef4444',
    borderUpColor: '#22c55e',
    borderDownColor: '#ef4444',
    wickUpColor:   '#22c55e',
    wickDownColor: '#ef4444',
  })

  if (props.showEma34) {
    emaSeries34 = chart.addLineSeries({ color: '#22d3ee', lineWidth: 2, title: 'EMA34' })
  }

  loadData()

  const ro = new ResizeObserver(() => chart?.applyOptions({ width: chartEl.value!.clientWidth }))
  ro.observe(chartEl.value!)
})

onBeforeUnmount(() => chart?.remove())

watch(() => [props.symbol, props.timeframe], loadData)
watch(() => props.lines, applyPriceLines, { deep: true })
</script>
