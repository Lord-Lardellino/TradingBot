<template>
  <div ref="el" class="w-full" style="height:180px" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import {
  createChart, ColorType, LineStyle,
  type IChartApi, type ISeriesApi, type CandlestickData,
} from 'lightweight-charts'

interface Candle { t: number; o: number; h: number; l: number; c: number }

const props = defineProps<{
  candles: Candle[]
  ema34:   number[]
  entry?:  number
  isLong?: boolean
}>()

const el = ref<HTMLElement>()
let chart: IChartApi
let cSeries: ISeriesApi<'Candlestick'>
let eSeries: ISeriesApi<'Line'>

function buildCandles(): CandlestickData[] {
  return props.candles.map(c => ({
    time:  Math.floor(c.t / 1000) as any,
    open:  c.o,
    high:  c.h,
    low:   c.l,
    close: c.c,
  }))
}

function buildEma(): { time: any; value: number }[] {
  return props.ema34
    .map((v, i) => ({ time: Math.floor(props.candles[i]?.t / 1000) as any, value: v }))
    .filter(p => p.value > 0 && p.time)
}

function render() {
  if (!chart) return
  cSeries.setData(buildCandles())
  eSeries.setData(buildEma())

  if (props.entry) {
    cSeries.createPriceLine({
      price:            props.entry,
      color:            'rgba(255,255,255,0.65)',
      lineWidth:        1,
      lineStyle:        LineStyle.Dashed,
      axisLabelVisible: false,
      title:            '',
    })
  }
  chart.timeScale().fitContent()
}

onMounted(() => {
  chart = createChart(el.value!, {
    width:  el.value!.clientWidth,
    height: 180,
    layout: {
      background: { type: ColorType.Solid, color: '#0b0b15' },
      textColor:  '#6b7280',
      fontSize:   10,
    },
    grid: {
      vertLines: { color: '#ffffff06' },
      horzLines: { color: '#ffffff08' },
    },
    crosshair:    { mode: 0 },
    handleScroll: false,
    handleScale:  false,
    rightPriceScale: {
      visible:      true,
      borderVisible: false,
      textColor:    '#6b7280',
      scaleMargins: { top: 0.10, bottom: 0.10 },
    },
    timeScale: {
      visible:      false,
      borderVisible: false,
      barSpacing:   6,
    },
  })

  cSeries = chart.addCandlestickSeries({
    upColor:          '#22c55e',
    downColor:        '#ef4444',
    borderUpColor:    '#22c55e',
    borderDownColor:  '#ef4444',
    wickUpColor:      '#4ade80',
    wickDownColor:    '#f87171',
  })

  eSeries = chart.addLineSeries({
    color:            '#22d3ee',
    lineWidth:        2,
    priceLineVisible: false,
    lastValueVisible: false,
  })

  render()

  const ro = new ResizeObserver(() => {
    if (el.value) chart?.applyOptions({ width: el.value.clientWidth })
  })
  ro.observe(el.value!)
})

onBeforeUnmount(() => chart?.remove())
watch(() => props.candles, render, { deep: false })
</script>
