<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries, ColorType, CrosshairMode, type IChartApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from 'lightweight-charts'
import type { Candle, PersonalView } from '../shared/types'
import { aggregateCandles, chartTimeLabel, CHART_PERIODS, CHINA_OFFSET, isCalendarInterval, movingAverage, tradeBuckets, type ChartInterval } from '../shared/chart-data'
import { compact, money } from '../lib/market'

const props = defineProps<{ candles: Candle[]; dailyCandles: Candle[]; trades: PersonalView['trades']; symbol: string; interval: ChartInterval; averages: boolean; showVolume: boolean; round: number }>()
const container = ref<HTMLDivElement>()
const hoverTime = ref<number>()
const enabledAverages = ref([5, 10, 20, 60])
const averageOptions = [{ period: 5, color: '#bca3f5' }, { period: 10, color: '#dfb876' }, { period: 20, color: '#739bd6' }, { period: 30, color: '#e092b1' }, { period: 60, color: '#78c7ae' }]
const sourceCandles = computed(() => isCalendarInterval(props.interval) ? props.dailyCandles : props.candles)
const aggregated = computed(() => aggregateCandles(sourceCandles.value, props.interval))
const averageValues = computed(() => averageOptions.map(option => movingAverage(aggregated.value, option.period)))
const selectedIndex = computed(() => {
  const index = aggregated.value.findIndex(c => c.time === hoverTime.value)
  return index >= 0 ? index : aggregated.value.length - 1
})
const selectedCandle = computed(() => aggregated.value[selectedIndex.value])
const periodLabel = computed(() => CHART_PERIODS.find(p => p.id === props.interval)!.label)
let chart: IChartApi | undefined
let observer: ResizeObserver | undefined
let price: ReturnType<IChartApi['addSeries']> | undefined
let tradeMarkers: ISeriesMarkersPluginApi<Time> | undefined
let volume: ReturnType<IChartApi['addSeries']> | undefined
let averageSeries: ReturnType<IChartApi['addSeries']>[] = []
const axisTime = (time: number) => (time + CHINA_OFFSET) as UTCTimestamp

function toggleAverage(period: number) {
  enabledAverages.value = enabledAverages.value.includes(period) ? enabledAverages.value.filter(p => p !== period) : [...enabledAverages.value, period]
}
function fitChart() {
  if (!chart) return
  const count = aggregated.value.length
  if (count > 0 && count < 30) {
    const padding = (30 - count) / 2
    chart.timeScale().setVisibleLogicalRange({ from: -padding, to: count - 1 + padding })
  } else chart.timeScale().fitContent()
}
function updateMarkers() {
  tradeMarkers?.setMarkers(tradeBuckets(props.trades, props.symbol, sourceCandles.value, props.interval).map(({ time, side }) => ({
    id: `${time}-${side}`, time: axisTime(time), position: side === 'buy' ? 'belowBar' : 'aboveBar',
    color: side === 'buy' ? '#ed7277' : '#4ec8a4', shape: side === 'buy' ? 'arrowUp' : 'arrowDown', text: side === 'buy' ? 'B' : 'S',
  })))
}
function update() {
  if (!chart || !price) return
  const candles = aggregated.value
  price.setData(candles.map(c => props.interval === 'line' ? { time: axisTime(c.time), value: c.close / 100 } : { time: axisTime(c.time), open: c.open / 100, high: c.high / 100, low: c.low / 100, close: c.close / 100 }))
  volume?.setData(candles.map(c => ({ time: axisTime(c.time), value: c.volume, color: c.close >= c.open ? '#ed7277c0' : '#4ec8a4c0' })))
  averageSeries.forEach((series, index) => {
    series.applyOptions({ visible: props.averages && props.interval !== 'line' && enabledAverages.value.includes(averageOptions[index]!.period) })
    series.setData(candles.flatMap((c, i) => {
      const value = averageValues.value[index]![i]
      return value === undefined ? [] : [{ time: axisTime(c.time), value: value / 100 }]
    }))
  })
  updateMarkers()
}
function createPrice() {
  if (!chart) return
  hoverTime.value = undefined
  tradeMarkers?.detach()
  if (price) chart.removeSeries(price)
  price = props.interval === 'line'
    ? chart.addSeries(AreaSeries, { lineColor: '#b8a0ff', topColor: '#b8a0ff35', bottomColor: '#b8a0ff00', lineWidth: 2, priceLineColor: '#b8a0ff' })
    : chart.addSeries(CandlestickSeries, { upColor: '#ed7277', downColor: '#4ec8a4', borderVisible: true, borderUpColor: '#ed7277', borderDownColor: '#4ec8a4', wickVisible: true, wickUpColor: '#ed7277', wickDownColor: '#4ec8a4', priceLineColor: '#89909a' })
  price.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0.12 } })
  tradeMarkers = createSeriesMarkers(price, [], { autoScale: true, zOrder: 'aboveSeries' })
  chart.applyOptions({ timeScale: { timeVisible: !isCalendarInterval(props.interval) } })
  update(); fitChart()
}
function configureVolume() {
  if (!chart) return
  if (props.showVolume && !volume) {
    volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, title: '成交量', lastValueVisible: false, priceLineVisible: false }, 1)
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } })
  } else if (!props.showVolume && volume) { chart.removeSeries(volume); volume = undefined }
  chart.panes()[0]?.setStretchFactor(4)
  chart.panes()[1]?.setStretchFactor(1)
  update()
}
onMounted(() => {
  if (!container.value) return
  chart = createChart(container.value, {
    autoSize: true,
    layout: { background: { type: ColorType.Solid, color: '#171a1e' }, textColor: '#88909d', fontSize: 11, fontFamily: 'Inter, Segoe UI, sans-serif', attributionLogo: false },
    grid: { vertLines: { color: '#22262d' }, horzLines: { color: '#22262d' } },
    rightPriceScale: { borderVisible: false, minimumWidth: 58 },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, barSpacing: 8, rightOffset: 3, tickMarkFormatter: (time: number, type: number) => {
      const label = chartTimeLabel(time - CHINA_OFFSET, props.interval)
      return isCalendarInterval(props.interval) ? label : type >= 3 ? label.slice(11) : label.slice(0, 10)
    } },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#6b647f', labelBackgroundColor: '#6c5b91' }, horzLine: { color: '#6b647f', labelBackgroundColor: '#6c5b91' } },
    localization: { locale: 'zh-CN', priceFormatter: (p: number) => p.toFixed(2), timeFormatter: (time: number) => chartTimeLabel(time - CHINA_OFFSET, props.interval) },
  })
  averageSeries = averageOptions.map(({ color }) => chart!.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }))
  createPrice(); configureVolume()
  chart.subscribeCrosshairMove(param => { hoverTime.value = typeof param.time === 'number' ? param.time - CHINA_OFFSET : undefined })
  observer = new ResizeObserver(fitChart)
  observer.observe(container.value)
})
watch([() => props.candles, () => props.dailyCandles, () => props.interval], (next, previous) => {
  if (next[2] !== previous[2]) createPrice()
  else update()
})
watch([() => props.trades, () => props.symbol], updateMarkers)
watch([() => props.averages, enabledAverages], update)
watch(() => props.showVolume, configureVolume)
watch(() => props.round, () => { hoverTime.value = undefined; update(); fitChart() })
onBeforeUnmount(() => { observer?.disconnect(); tradeMarkers?.detach(); chart?.remove() })
</script>
<template>
  <div class="chart-candle-readout" aria-live="off"><template v-if="selectedCandle">
    <span class="readout-date">{{ chartTimeLabel(selectedCandle.time, interval) }}</span>
    <span>开 <b>{{ money(selectedCandle.open) }}</b></span><span>高 <b>{{ money(selectedCandle.high) }}</b></span><span>低 <b>{{ money(selectedCandle.low) }}</b></span><span>收 <b :class="selectedCandle.close >= selectedCandle.open ? 'up' : 'down'">{{ money(selectedCandle.close) }}</b></span><span>量 <b>{{ compact(selectedCandle.volume) }} 股</b></span>
  </template><span v-else>等待当前周期的行情</span></div>
  <div v-if="averages && interval !== 'line'" class="chart-average-legend" aria-label="均线选择">
    <button v-for="(option, index) in averageOptions" :key="option.period" :style="{ color: option.color }" :class="{ inactive: !enabledAverages.includes(option.period) }" :aria-pressed="enabledAverages.includes(option.period)" :title="`最近 ${option.period} 根${periodLabel}收盘价的平均值，数据不足时显示 —`" @click="toggleAverage(option.period)">MA{{ option.period }} <b>{{ averageValues[index]?.[selectedIndex] === undefined ? '—' : money(averageValues[index]![selectedIndex]!) }}</b></button>
    <small>点击切换 · 不足周期显示 —</small>
  </div>
  <div class="trade-marker-legend"><span>我的成交</span><span class="up"><b>B</b> 买入</span><span class="down"><b>S</b> 卖出</span><small>最近 200 笔 · 同周期同向合并</small></div>
  <div ref="container" class="price-chart" role="img" :aria-label="`${periodLabel}价格图，${interval === 'line' ? '显示分钟收盘价走势' : '蜡烛显示开高低收及上下影线'}，红色 B 表示本人买入成交，绿色 S 表示本人卖出成交，${showVolume ? '下方为成交量柱，' : ''}可拖动缩放`"></div>
  <div v-if="isCalendarInterval(interval)" class="chart-history-note">{{ periodLabel }}已积累 {{ aggregated.length }} 根 · 按北京时间汇总<span v-if="aggregated.length < 2">，继续模拟可积累更多行情</span><span>；当前周期收盘前持续更新。</span></div>
</template>
<style scoped>
.chart-candle-readout{display:flex;align-items:center;flex-wrap:wrap;gap:7px 13px;padding:8px 18px;color:#828b99;font-size:10px;min-height:34px}.chart-candle-readout b{font-weight:500;color:#c1c7d1;margin-left:3px}.readout-date{color:#a69abf;font-variant-numeric:tabular-nums}.chart-average-legend{display:flex;align-items:center;flex-wrap:wrap;gap:5px 12px;padding:0 18px 8px;font-size:10px}.chart-average-legend button{font-size:10px;padding:3px 0}.chart-average-legend b{font-weight:400}.chart-average-legend .inactive{opacity:.4;text-decoration:line-through}.chart-average-legend small{font-size:9px;color:#717886;margin-left:auto}.trade-marker-legend{display:flex;align-items:center;flex-wrap:wrap;gap:8px 13px;padding:3px 18px 9px;color:#7c8491;font-size:10px}.trade-marker-legend>span{display:inline-flex;align-items:center;gap:4px}.trade-marker-legend b{font-size:11px}.trade-marker-legend small{font-size:9px;color:#69717e;margin-left:auto}.price-chart{height:410px}.chart-history-note{font-size:10px;line-height:1.7;padding:7px 18px;color:#7e8493}:global(.expanded-chart) .price-chart{height:auto;min-height:260px}
@media(max-width:540px){.chart-candle-readout,.chart-average-legend{padding-left:13px;padding-right:13px;gap:6px 10px;font-size:9px}.trade-marker-legend{padding:3px 13px 8px;gap:6px 10px;font-size:9px}.trade-marker-legend small{font-size:8px}.price-chart{height:350px}.chart-history-note{padding:7px 13px;font-size:9px}}
</style>
