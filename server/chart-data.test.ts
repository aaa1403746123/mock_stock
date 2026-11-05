import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateCandles, candleStart, chartTimeLabel, movingAverage, tradeBuckets } from '../src/shared/chart-data.ts'
import type { Candle, PersonalView } from '../src/shared/types.ts'
import { DEFAULT_SYMBOL } from '../src/shared/rules.ts'
import { MarketEngine } from './engine.ts'

const seconds = (local: string) => Date.parse(`${local}+08:00`) / 1000
const candle = (local: string, open: number, high = open, low = open, close = open, volume = 100): Candle => ({ time: seconds(local), open, high, low, close, volume })

test('daily, monthly and yearly boundaries follow Shanghai dates including leap years', () => {
  const before = seconds('2028-02-29T23:59:59'), after = seconds('2028-03-01T00:00:00')
  assert.equal(candleStart(before, '1d'), seconds('2028-02-29T00:00:00'))
  assert.equal(candleStart(before, '1M'), seconds('2028-02-01T00:00:00'))
  assert.equal(candleStart(after, '1M'), seconds('2028-03-01T00:00:00'))
  assert.equal(candleStart(seconds('2027-12-31T23:59:59'), '1y'), seconds('2027-01-01T00:00:00'))
  assert.equal(candleStart(seconds('2028-01-01T00:00:00'), '1y'), seconds('2028-01-01T00:00:00'))
  assert.equal(chartTimeLabel(before, '1d'), '2028-02-29')
  assert.equal(chartTimeLabel(after, '1M'), '2028-03')
  assert.equal(chartTimeLabel(after, '1y'), '2028')
})

test('long-period OHLC and volume combine actual trades without inventing missing months', () => {
  const input = [
    candle('2027-12-31T09:30:00', 999, 999, 999, 999, 0),
    candle('2027-12-31T10:00:00', 100, 130, 90, 120, 200),
    candle('2028-01-02T09:30:00', 115, 140, 110, 135, 300),
    candle('2028-01-03T09:30:00', 130, 135, 80, 95, 400),
    candle('2028-03-01T09:30:00', 95, 150, 85, 125, 500),
  ]
  const original = structuredClone(input), days = aggregateCandles(input, '1d')
  assert.equal(days[0]!.open, 100); assert.equal(days[0]!.high, 130)
  const months = aggregateCandles(days, '1M'), years = aggregateCandles(days, '1y')
  assert.deepEqual(months.map(c => chartTimeLabel(c.time, '1M')), ['2027-12', '2028-01', '2028-03'])
  assert.deepEqual(months[1], { time: seconds('2028-01-01T00:00:00'), open: 115, high: 140, low: 80, close: 95, volume: 700 })
  assert.deepEqual(years[1], { time: seconds('2028-01-01T00:00:00'), open: 115, high: 150, low: 80, close: 125, volume: 1200 })
  assert.deepEqual(input, original)
})

test('moving averages use selected-period closes and wait for a complete window', () => {
  const days = [100, 200, 300, 400, 500].map((price, i) => candle(`2028-01-0${i + 1}T09:30:00`, price))
  assert.deepEqual(movingAverage(days, 3), [undefined, undefined, 200, 300, 400])
  const monthly = aggregateCandles(days, '1M')
  assert.deepEqual(movingAverage(monthly, 5), [undefined])
})

test('B/S markers align to calendar periods, retain both sides and exclude other stocks or absent dates', () => {
  const source = [candle('2027-12-31T00:00:00', 100), candle('2028-01-01T00:00:00', 100), candle('2028-01-02T00:00:00', 100)]
  const trade = (local: string, side: 'buy' | 'sell', symbol = DEFAULT_SYMBOL) => ({ id: local + side, symbol, time: seconds(local) * 1000, side, price: 100, quantity: 1 })
  const trades: PersonalView['trades'] = [trade('2028-01-02T09:31:00', 'buy'), trade('2028-01-01T00:00:00', 'sell'), trade('2028-01-01T09:30:00', 'buy'), trade('2027-12-31T23:59:59', 'buy'), trade('2028-01-02T09:30:00', 'sell', '600002.SH'), trade('2028-03-01T09:30:00', 'sell')]
  const markers = tradeBuckets(trades, DEFAULT_SYMBOL, source, '1M')
  assert.deepEqual(markers, [{ time: seconds('2027-12-01T00:00:00'), side: 'buy' }, { time: seconds('2028-01-01T00:00:00'), side: 'buy' }, { time: seconds('2028-01-01T00:00:00'), side: 'sell' }])
  assert.equal(tradeBuckets(trades, DEFAULT_SYMBOL, source, '1d').length, 4)
  assert.deepEqual(tradeBuckets([], DEFAULT_SYMBOL, source, '1y'), [])
})

test('daily history survives minute pruning and restart without double-counting fills', () => {
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time: seconds('2026-11-05T09:30:00') * 1000 })
  const buyer = e.createAccount('buyer'), seller = e.createAccount('seller', 'trader', 0, 1000)
  const fill = (price: number) => {
    e.submit(seller.id, { side: 'sell', kind: 'limit', price, quantity: 100, requestId: `sell-request-${e.state.seq}` })
    e.submit(buyer.id, { side: 'buy', kind: 'limit', price, quantity: 100, requestId: `buy-request-${e.state.seq}` })
  }
  fill(4900); e.advance(60); fill(5100)
  const firstDay = structuredClone(e.stock().dailyCandles[0])
  for (let i = 0; i < 1500; i++) e.advance(60)
  assert.equal(e.stock().candles.length, 1440)
  assert.equal(e.stock().candles.reduce((sum, c) => sum + c.volume, 0), 0)
  assert.deepEqual(e.stock().dailyCandles[0], firstDay)
  e.nextDay(); fill(4800)
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state)))
  assert.deepEqual(restored.stock().dailyCandles, e.stock().dailyCandles)
  assert.deepEqual(aggregateCandles(restored.stock().dailyCandles, '1M')[0], { time: seconds('2026-11-01T00:00:00'), open: 4900, high: 5100, low: 4800, close: 4800, volume: 300 })
  assert.equal(restored.quote().open, 4800)
  assert.deepEqual(restored.view(buyer.id).dailyCandles, e.stock().dailyCandles)
  assert.ok(restored.stock('600002.SH').dailyCandles.every(c => c.volume === 0))
})

test('legacy saves backfill daily candles once from available minutes while preserving accounts', () => {
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false })
  const owner = e.createAccount('owner', 'admin')
  const saved = JSON.parse(JSON.stringify(e.state))
  const minutes = [candle('2028-02-29T23:59:00', 100, 110, 90, 105), candle('2028-03-01T00:00:00', 105, 120, 100, 115)]
  saved.stocks[DEFAULT_SYMBOL].candles = minutes
  for (const stock of Object.values(saved.stocks) as { dailyCandles?: Candle[] }[]) delete stock.dailyCandles
  const restored = new MarketEngine(saved)
  assert.deepEqual(restored.stock().dailyCandles, aggregateCandles(minutes, '1d'))
  assert.deepEqual(restored.account(owner.id), owner)
  const again = new MarketEngine(JSON.parse(JSON.stringify(restored.state)))
  assert.deepEqual(again.stock().dailyCandles, restored.stock().dailyCandles)
})
