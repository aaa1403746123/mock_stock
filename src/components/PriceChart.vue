<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries, ColorType, CrosshairMode, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../shared/types'
const props = defineProps<{ candles: Candle[]; interval: string; averages: boolean; round: number }>()
const emit = defineEmits<{ hover: [candle: Candle | undefined] }>()
const container = ref<HTMLDivElement>()
let chart: IChartApi | undefined
let observer: ResizeObserver | undefined
let price: ReturnType<IChartApi['addSeries']> | undefined
let volume: ReturnType<IChartApi['addSeries']> | undefined
let averages: ReturnType<IChartApi['addSeries']>[] = []
let aggregated: Candle[] = []
const axisTime = (time: number) => (time + 8 * 3600) as UTCTimestamp
function aggregate() {
  const period = props.interval === '5m' ? 300 : props.interval === '15m' ? 900 : 60
  const result: Candle[] = []
  for (const c of props.candles) {
    const time = Math.floor(c.time / period) * period
    const previous = result.at(-1)
    if (previous?.time === time) { previous.high = Math.max(previous.high, c.high); previous.low = Math.min(previous.low, c.low); previous.close = c.close; previous.volume += c.volume }
    else result.push({ ...c, time })
  }
  return result
}
function update() {
  if (!chart || !price || !volume) return
  aggregated = aggregate()
  price.setData(aggregated.map(c => props.interval === 'line' ? { time: axisTime(c.time), value: c.close / 100 } : { time: axisTime(c.time), open: c.open / 100, high: c.high / 100, low: c.low / 100, close: c.close / 100 }))
  volume.setData(aggregated.map(c => ({ time: axisTime(c.time), value: c.volume, color: c.close >= c.open ? '#ed727756' : '#4ec8a456' })))
  averages.forEach((series, index) => {
    const window = [5, 10, 20][index]!
    series.applyOptions({ visible: props.averages && props.interval !== 'line' })
    series.setData(aggregated.flatMap((c, i) => i < window - 1 ? [] : [{ time: axisTime(c.time), value: aggregated.slice(i - window + 1, i + 1).reduce((sum, v) => sum + v.close, 0) / window / 100 }]))
  })
}
function createPrice() {
  if (!chart) return
  if (price) chart.removeSeries(price)
  price = props.interval === 'line'
    ? chart.addSeries(AreaSeries, { lineColor: '#b8a0ff', topColor: '#b8a0ff35', bottomColor: '#b8a0ff00', lineWidth: 2, priceLineColor: '#b8a0ff' })
    : chart.addSeries(CandlestickSeries, { upColor: '#ed7277', downColor: '#4ec8a4', borderVisible: false, wickUpColor: '#ed7277', wickDownColor: '#4ec8a4', priceLineColor: '#89909a' })
  price.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.26 } })
  update(); chart.timeScale().fitContent()
}
onMounted(() => {
  if (!container.value) return
  chart = createChart(container.value, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: '#171a1e' }, textColor: '#727985', fontSize: 11, fontFamily: 'Inter, Segoe UI, sans-serif', attributionLogo: false },
    grid: { vertLines: { color: '#22262d' }, horzLines: { color: '#22262d' } },
    rightPriceScale: { borderVisible: false, minimumWidth: 58 },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, barSpacing: 8, rightOffset: 3, tickMarkFormatter: (time: number) => new Date(time * 1000).toISOString().slice(11, 16) },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#6b647f', labelBackgroundColor: '#6c5b91' }, horzLine: { color: '#6b647f', labelBackgroundColor: '#6c5b91' } },
    localization: { locale: 'zh-CN', priceFormatter: (p: number) => p.toFixed(2), timeFormatter: (time: number) => new Date(time * 1000).toISOString().replace('T', ' ').slice(0, 16) },
  })
  volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false })
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
  averages = ['#bca3f5', '#dfb876', '#739bd6'].map(color => chart!.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }))
  createPrice()
  chart.subscribeCrosshairMove(param => emit('hover', aggregated.find(c => axisTime(c.time) === param.time)))
  observer = new ResizeObserver(() => chart?.timeScale().fitContent())
  observer.observe(container.value)
})
watch(() => props.candles, update)
watch(() => props.interval, createPrice)
watch(() => props.averages, update)
watch(() => props.round, () => { update(); chart?.timeScale().fitContent() })
onBeforeUnmount(() => { observer?.disconnect(); chart?.remove() })
</script>
<template><div ref="container" class="price-chart" role="img" aria-label="由模拟成交生成的实时价格及成交量图，可拖动、缩放查看"></div></template>
