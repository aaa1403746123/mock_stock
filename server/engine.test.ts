import test from 'node:test'
import assert from 'node:assert/strict'
import { MarketEngine, INITIAL_PRICE, dayOf } from './engine.ts'
import type { Order, Side } from '../src/shared/types.ts'

const fresh = () => new MarketEngine(undefined, { botCount: 0, warmup: false, time: new Date('2026-11-05T09:30:00+08:00').getTime() })
const order = (e: MarketEngine, id: string, side: Side, price: number, quantity = 100) => e.submit(id, { side, kind: 'limit', price, quantity, requestId: `request-${e.state.seq + 1}` })
const totals = (e: MarketEngine) => ({ cash: e.state.accounts.reduce((n, a) => n + a.cash, 0) + e.state.feesCollected, shares: e.state.accounts.reduce((n, a) => n + Object.values(a.positions).reduce((q, p) => q + p.lots.reduce((v, l) => v + l.quantity, 0), 0), 0) })

test('price/time priority, partial fills, resting-price execution, OHLC and one-sided volume', () => {
  const e = fresh(), buyer = e.createAccount('buyer'), first = e.createAccount('first', 'trader', 0, 200), second = e.createAccount('second', 'trader', 0, 200), cheaper = e.createAccount('cheaper', 'trader', 0, 100)
  const before = totals(e)
  const o1 = order(e, first.id, 'sell', 4900, 200), o2 = order(e, second.id, 'sell', 4900, 200)
  order(e, cheaper.id, 'sell', 4880, 100)
  const buy = order(e, buyer.id, 'buy', 4920, 400)
  assert.equal(buy.filled, 400)
  assert.equal(o1.status, 'filled'); assert.equal(o2.filled, 100); assert.equal(o2.remaining, 100)
  assert.deepEqual(e.state.trades.map(t => [t.price, t.quantity]), [[4880, 100], [4900, 200], [4900, 100]])
  assert.equal(e.stock().lastPrice, 4900); assert.equal(e.stock().totalVolume, 400)
  assert.deepEqual(e.stock().candles.at(-1), { time: Math.floor(e.state.time / 60000) * 60, open: 4880, high: 4900, low: 4880, close: 4900, volume: 400 })
  assert.deepEqual(totals(e), before)
})
test('same-price trades increase volume without moving price', () => {
  const e = fresh(), a = e.createAccount('a'), b = e.createAccount('b', 'trader', 0, 200)
  order(e, b.id, 'sell', INITIAL_PRICE, 200); order(e, a.id, 'buy', INITIAL_PRICE, 100); order(e, a.id, 'buy', INITIAL_PRICE, 100)
  assert.equal(e.stock().lastPrice, INITIAL_PRICE); assert.equal(e.stock().totalVolume, 200)
})
test('orders without counterparties never fabricate trades; cancellation releases funds and shares', () => {
  const e = fresh(), a = e.createAccount('a', 'trader', 1000000, 100)
  const buy = order(e, a.id, 'buy', 4000, 100), sell = order(e, a.id, 'sell', 5000, 100)
  assert.equal(e.state.trades.length, 0); assert.equal(e.view(a.id).account.frozenCash, 400000); assert.equal(e.view(a.id).account.sellable, 0)
  e.cancel(a.id, buy.id); e.cancel(a.id, sell.id)
  assert.equal(e.view(a.id).account.frozenCash, 0); assert.equal(e.view(a.id).account.sellable, 100)
  e.advance(60)
  assert.equal(e.stock().candles.at(-1)?.volume, 0); assert.equal(e.stock().candles.at(-1)?.close, INITIAL_PRICE)
})
test('self trades are excluded and another account cannot cancel an order', () => {
  const e = fresh(), a = e.createAccount('a', 'trader', 1000000, 100), b = e.createAccount('b')
  const sell = order(e, a.id, 'sell', 4800)
  const buy = order(e, a.id, 'buy', 4800)
  assert.equal(e.state.trades.length, 0)
  assert.equal(buy.status, 'cancelled'); assert.equal(buy.cancelReason, 'self_trade'); assert.equal(e.frozenCash(a.id), 0)
  assert.throws(() => e.cancel(b.id, sell.id), /委托不存在/)
})
test('minimum sell commission is reserved for tiny partial fills without borrowing frozen cash', () => {
  const e = fresh(); e.state.config.feesEnabled = true
  const seller = e.createAccount('seller', 'trader', 500, 1000), buyer = e.createAccount('buyer')
  const before = totals(e)
  const sell = order(e, seller.id, 'sell', 1, 1000)
  assert.equal(e.frozenCash(seller.id), 499)
  assert.throws(() => order(e, seller.id, 'buy', 1, 100), /资金不足/)
  order(e, buyer.id, 'buy', 1, 1)
  assert.equal(seller.cash, 1); assert.equal(e.frozenCash(seller.id), 0)
  order(e, buyer.id, 'buy', 1, 999)
  assert.equal(sell.status, 'filled'); assert.ok(seller.cash >= 0); assert.deepEqual(totals(e), before)
  const noCash = e.createAccount('empty', 'trader', 0, 1000)
  assert.throws(() => order(e, noCash.id, 'sell', 1, 1000), /最低佣金/)
})
test('overcommitting cash, shares and invalid integer prices is rejected', () => {
  const e = fresh(), a = e.createAccount('a', 'trader', 500000, 100)
  order(e, a.id, 'buy', 4000)
  assert.throws(() => order(e, a.id, 'buy', 4000), /资金不足/)
  order(e, a.id, 'sell', 5000)
  assert.throws(() => order(e, a.id, 'sell', 5000), /可卖数量不足/)
  assert.throws(() => order(e, a.id, 'buy', 48.62), /价格/)
  assert.throws(() => order(e, a.id, 'buy', 4800, 1.5), /整数/)
})
test('market orders sweep levels inside protection; residual volume is cancelled', () => {
  const e = fresh(), a = e.createAccount('a'), b = e.createAccount('b', 'trader', 0, 500)
  order(e, b.id, 'sell', 4900, 200); order(e, b.id, 'sell', 5100, 300)
  const result = e.submit(a.id, { side: 'buy', kind: 'market', quantity: 400, requestId: 'market-test' })
  assert.equal(result.filled, 200); assert.equal(result.remaining, 200); assert.equal(result.status, 'cancelled')
  assert.equal(e.frozenCash(a.id), 0)
})
test('idempotency survives serialization and rejects a reused key with a different payload', () => {
  const e = fresh(), a = e.createAccount('a')
  const input = { side: 'buy' as const, kind: 'limit' as const, price: 4000, quantity: 100, requestId: 'stable-request' }
  const first = e.submit(a.id, input)
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state)))
  assert.equal(restored.submit(a.id, input).id, first.id); assert.equal(restored.state.orders.length, 1)
  assert.throws(() => restored.submit(a.id, { ...input, quantity: 200 }), /不同订单/)
})
test('A-share T+1 unlocks on next simulated business day and existing lot sales stay available', () => {
  const e = fresh(); e.state.config.mode = 'ashare'
  const a = e.createAccount('a'), b = e.createAccount('b', 'trader', 0, 200)
  order(e, b.id, 'sell', 4862); order(e, a.id, 'buy', 4862)
  assert.equal(e.view(a.id).account.shares, 100); assert.equal(e.view(a.id).account.sellable, 0)
  assert.throws(() => order(e, a.id, 'sell', 4862), /下一模拟交易日/)
  e.nextDay(); assert.equal(e.state.day, '2026-11-06'); assert.equal(e.view(a.id).account.sellable, 100)
  e.nextDay(); assert.equal(e.state.day, '2026-11-09')
})
test('A-share quantity, limits, market sessions and paused trading enforced', () => {
  const e = fresh(); e.state.config.mode = 'ashare'
  const a = e.createAccount('a')
  assert.throws(() => order(e, a.id, 'buy', 4862, 101), /100 股/)
  assert.throws(() => order(e, a.id, 'buy', 6000), /价格须在/)
  e.state.time = new Date('2026-11-05T12:00:00+08:00').getTime()
  assert.throws(() => order(e, a.id, 'buy', 4862), /非交易时段/)
  e.state.time = new Date('2026-11-05T13:00:00+08:00').getTime()
  order(e, a.id, 'buy', 4500)
  e.configure({ paused: true }); const time = e.state.time; e.advance(60)
  assert.equal(e.state.time, time); assert.throws(() => order(e, a.id, 'buy', 4500), /暂停/)
})
test('A-share day orders expire at close and previous-close reference rolls forward', () => {
  const e = fresh(); e.state.config.mode = 'ashare'
  const a = e.createAccount('a'); const pending = order(e, a.id, 'buy', 4500)
  e.state.time = new Date('2026-11-05T14:59:59+08:00').getTime(); e.advance(2)
  assert.equal(pending.status, 'cancelled'); assert.equal(e.frozenCash(a.id), 0)
  e.stock().lastPrice = 5000; e.nextDay(); assert.equal(e.stock().previousClose, 5000); assert.deepEqual(e.limits(), { lower: 4500, upper: 5500 })
})
test('fees accrue per order, assets conserved including fees, and all freezes release after fills', () => {
  const e = fresh(); e.state.config.feesEnabled = true
  const a = e.createAccount('a'), b = e.createAccount('b', 'trader', 10000, 300), c = e.createAccount('c', 'trader', 10000, 100)
  const before = totals(e)
  order(e, b.id, 'sell', 4850, 100); order(e, c.id, 'sell', 4860, 100)
  const buy = order(e, a.id, 'buy', 4900, 200)
  assert.equal(buy.fee, 500 + Math.round(buy.turnover * .00001))
  assert.deepEqual(totals(e), before); assert.equal(e.frozenCash(a.id), 0)
  assert.equal(e.view(a.id).account.cost, buy.turnover + buy.fee)
})
test('public view exposes no counterparties, passwords, sessions, or other portfolios', () => {
  const e = fresh(), a = e.createAccount('a'), b = e.createAccount('private-owner', 'trader', 77777777, 100)
  b.passwordHash = 'SECRET'; e.state.sessions.SECRET_TOKEN = { accountId: b.id, expires: Date.now() + 1000 }
  order(e, b.id, 'sell', 4862); order(e, a.id, 'buy', 4862)
  const json = JSON.stringify(e.view(a.id))
  for (const value of ['private-owner', 'SECRET', 'SECRET_TOKEN', 'buyAccountId', 'sellAccountId', '77777777']) assert.ok(!json.includes(value), value)
})
test('independent deterministic bots move prices through trades while conserving finite assets', () => {
  const options = { warmup: false, botCount: 100, seed: 42, time: new Date('2026-11-05T09:30:00+08:00').getTime() }
  const e = new MarketEngine(undefined, options), copy = new MarketEngine(undefined, options)
  const before = totals(e)
  for (let i = 0; i < 250; i++) { e.advance(5); copy.advance(5) }
  assert.ok(e.state.trades.length > 100)
  assert.ok(new Set(e.state.trades.map(t => t.price)).size > 10)
  assert.deepEqual(totals(e), before); assert.deepEqual(e.state.trades, copy.state.trades)
  for (const account of e.state.accounts) { assert.ok(account.cash >= 0); assert.ok(e.view(account.id).account.availableCash >= 0); assert.ok(e.availableShares(account) >= 0) }
})
test('reset preserves human identities and credentials while resetting assets', () => {
  const e = fresh(), a = e.createAccount('owner', 'admin')
  a.username = 'owner'; a.passwordHash = 'PASSWORD'; e.state.sessions.token = { accountId: a.id, expires: 10000 }
  order(e, a.id, 'buy', 4000)
  e.reset('ashare', 8, true)
  const view = e.view(a.id)
  assert.equal(view.round, 2); assert.equal(view.config.mode, 'ashare'); assert.equal(view.account.cash, 10000000)
  assert.equal(view.account.orders.length, 0); assert.equal(e.account(a.id).passwordHash, 'PASSWORD')
  assert.equal(e.state.sessions.token?.accountId, a.id); assert.equal(e.state.accounts.filter(a => a.bot).length, 8)
})
