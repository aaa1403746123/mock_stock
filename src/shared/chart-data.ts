import type { Candle, PersonalView, Side } from './types'

export const CHART_PERIODS = [
  { id: 'line', label: '分时' }, { id: '1m', label: '1 分' }, { id: '5m', label: '5 分' },
  { id: '15m', label: '15 分' }, { id: '1d', label: '日 K' }, { id: '1M', label: '月 K' }, { id: '1y', label: '年 K' },
] as const
export type ChartInterval = typeof CHART_PERIODS[number]['id']
export const CHINA_OFFSET = 8 * 3600
export const isCalendarInterval = (interval: ChartInterval) => ['1d', '1M', '1y'].includes(interval)

/** UTC seconds for the beginning of a period in the Shanghai trading calendar. */
export function candleStart(time: number, interval: ChartInterval): number {
  if (!isCalendarInterval(interval)) {
    const seconds = interval === '15m' ? 900 : interval === '5m' ? 300 : 60
    return Math.floor(time / seconds) * seconds
  }
  const date = new Date((time + CHINA_OFFSET) * 1000)
  return Date.UTC(date.getUTCFullYear(), interval === '1y' ? 0 : date.getUTCMonth(), interval === '1d' ? date.getUTCDate() : 1) / 1000 - CHINA_OFFSET
}

export function aggregateCandles(candles: readonly Candle[], interval: ChartInterval): Candle[] {
  const result: Candle[] = []
  for (const candle of candles) {
    const time = candleStart(candle.time, interval), previous = result.at(-1)
    if (previous?.time !== time) { result.push({ ...candle, time }); continue }
    // Empty minutes/days are placeholders; only executed trades set OHLC.
    if (candle.volume > 0) {
      if (previous.volume === 0) { previous.open = candle.open; previous.high = candle.high; previous.low = candle.low }
      else { previous.high = Math.max(previous.high, candle.high); previous.low = Math.min(previous.low, candle.low) }
      previous.close = candle.close
    }
    previous.volume += candle.volume
  }
  return result
}

export function movingAverage(candles: readonly Candle[], period: number): (number | undefined)[] {
  let sum = 0
  return candles.map((candle, index) => {
    sum += candle.close
    if (index >= period) sum -= candles[index - period]!.close
    return index + 1 >= period ? sum / period : undefined
  })
}

export function tradeBuckets(trades: PersonalView['trades'], symbol: string, candles: readonly Candle[], interval: ChartInterval) {
  const sourceInterval = isCalendarInterval(interval) ? '1d' : '1m'
  const available = new Set(candles.map(c => candleStart(c.time, sourceInterval)))
  const grouped = new Map<string, { time: number; side: Side }>()
  for (const trade of trades) {
    if (trade.symbol !== symbol || !available.has(candleStart(trade.time / 1000, sourceInterval))) continue
    const time = candleStart(trade.time / 1000, interval)
    grouped.set(`${time}-${trade.side}`, { time, side: trade.side })
  }
  return [...grouped.values()].sort((a, b) => a.time - b.time || a.side.localeCompare(b.side))
}

export function chartTimeLabel(time: number, interval: ChartInterval): string {
  const local = new Date((time + CHINA_OFFSET) * 1000).toISOString()
  return interval === '1y' ? local.slice(0, 4) : interval === '1M' ? local.slice(0, 7) : interval === '1d' ? local.slice(0, 10) : local.replace('T', ' ').slice(0, 16)
}
