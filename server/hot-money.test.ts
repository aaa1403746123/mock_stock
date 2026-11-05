import test from 'node:test'
import assert from 'node:assert/strict'
import { MarketEngine } from './engine.ts'
import { decideHotMoney, hotMoneyProfile, type HotMoneyInput } from './hot-money.ts'
import { DEFAULT_SYMBOL, HOT_MONEY_INITIAL_CASH, HOT_MONEY_STYLES } from '../src/shared/rules.ts'
import type { HotMoneyStyle, PositionView } from '../src/shared/types.ts'

const time = Date.parse('2026-11-05T09:50:00+08:00')
function opportunity(style: HotMoneyStyle = 'breakout'): HotMoneyInput {
  const candles = Array.from({ length: 21 }, (_, i) => {
    const close = style === 'reversal' ? 10500 - i * 20 : 10000 + i * 15
    return { time: time / 1000 - (20 - i) * 60, open: close - 5, high: close + 2, low: close - 8, close, volume: i === 20 ? 40000 : 10000 }
  })
  if (style === 'pullback') candles[19]!.high = 10500
  if (style === 'reversal') Object.assign(candles[20]!, { open: 10100, close: 10200, high: 10210, low: 10090 })
  return { time, equity: 5_000_000_000, marketValue: 0, availableCash: 5_000_000_000, frozenCash: 0, positions: [], pendingBuys: {},
    markets: [{ symbol: DEFAULT_SYMBOL, price: candles.at(-1)!.close, previousClose: 10000, candles, bidVolume: 50000, askVolume: 50000, lower: 9000, upper: 11000 }] }
}

test('fifteen separately funded hot-money accounts are added once without changing existing portfolios or orders', () => {
  const e = new MarketEngine(undefined, { botCount: 1000, hotMoneyCount: 0, warmup: false, time })
  const owner = e.createAccount('owner', 'admin')
  e.submit(owner.id, { side: 'buy', kind: 'limit', price: 100, quantity: 100, requestId: 'preserved-request' })
  e.state.migrations = e.state.migrations!.filter(m => m !== 'hot-money-15-v1')
  const accounts = structuredClone(e.state.accounts), orders = structuredClone(e.state.orders), clock = e.state.time
  e.upgradePopulation(); e.upgradePopulation()
  const hot = e.state.accounts.filter(a => a.bot?.kind === 'hotMoney')
  assert.equal(hot.length, 15); assert.equal(e.state.config.botCount, 1000); assert.equal(e.state.config.hotMoneyCount, 15)
  assert.equal(e.state.accounts.filter(a => a.role === 'bot').length, 1015)
  assert.deepEqual(e.state.accounts.slice(0, accounts.length), accounts); assert.deepEqual(e.state.orders, orders); assert.equal(e.state.time, clock)
  assert.equal(new Set(hot.map(a => a.id)).size, 15); assert.equal(new Set(hot.map(a => a.name)).size, 15)
  assert.equal(Math.min(...hot.map(a => a.cash)), 200_000_000 * 100); assert.equal(Math.max(...hot.map(a => a.cash)), 3_000_000_000 * 100)
  assert.deepEqual(hot.map(a => a.cash), HOT_MONEY_INITIAL_CASH)
  for (const style of Object.keys(HOT_MONEY_STYLES)) assert.equal(hot.filter(a => a.bot!.hotMoney!.style === style).length, 3)
  hot[0]!.bot!.hotMoney!.peaks[DEFAULT_SYMBOL] = 12345
  assert.deepEqual(hot[1]!.bot!.hotMoney!.peaks, {})
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state))); restored.upgradePopulation()
  assert.deepEqual(restored.state, e.state)
  restored.reset('ashare', 8, true)
  assert.equal(restored.state.accounts.filter(a => a.bot?.kind === 'hotMoney').length, 15)
  assert.equal(restored.state.accounts.filter(a => a.role === 'bot').length, 23)
})

test('each style recognizes its public-market setup, sizes entries and waits when the signal is absent', () => {
  for (const [index, style] of (Object.keys(HOT_MONEY_STYLES) as HotMoneyStyle[]).entries()) {
    const profile = hotMoneyProfile(index), input = opportunity(style)
    const result = decideHotMoney(profile, input)
    assert.ok(result, style); assert.equal(result.side, 'buy'); assert.ok(result.quantity >= 100 && result.quantity % 100 === 0)
    assert.ok(result.price * result.quantity <= input.equity * profile.orderFraction)
    assert.ok(result.price <= input.markets[0]!.upper); assert.ok(result.reason.includes(HOT_MONEY_STYLES[style]))
    const flat = structuredClone(input)
    flat.markets[0]!.price = 10000
    flat.markets[0]!.candles.forEach(c => Object.assign(c, { open: 10000, high: 10000, low: 10000, close: 10000 }))
    assert.equal(decideHotMoney(profile, flat), undefined, style)
  }
})

test('capital upgrade tops up existing hot money once, preserves P&L, positions and freezes, and resets to new tiers', () => {
  const e = new MarketEngine(undefined, { botCount: 8, warmup: false, time })
  const hot = e.state.accounts.filter(a => a.bot?.kind === 'hotMoney')
  const oldMillions = [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 200]
  hot.forEach((a, i) => { a.cash = a.initialEquity = oldMillions[i]! * 1_000_000 * 100 })
  e.state.migrations = e.state.migrations!.filter(m => m !== 'hot-money-capital-200m-3b-v1')
  const seller = e.createAccount('seller', 'trader', 10000000, 1000)
  for (const [index, price] of [4900, 5100].entries()) {
    e.submit(seller.id, { side: 'sell', kind: 'limit', price, quantity: 100, requestId: `upgrade-sell-${index}` })
    e.submit(hot[index]!.id, { side: 'buy', kind: 'limit', price, quantity: 100, requestId: `upgrade-buy-${index}` })
  }
  e.submit(hot[0]!.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId: 'upgrade-pending-buy' })
  const otherAccounts = structuredClone(e.state.accounts.filter(a => a.bot?.kind !== 'hotMoney'))
  const original = hot.map(a => ({ account: structuredClone(a), summary: e.accountSummary(a.id) }))
  const orders = structuredClone(e.state.orders), trades = structuredClone(e.state.trades)
  e.upgradePopulation()
  hot.forEach((a, i) => {
    const before = original[i]!, summary = e.accountSummary(a.id), delta = HOT_MONEY_INITIAL_CASH[i]! - before.account.initialEquity
    assert.equal(a.initialEquity, before.account.initialEquity)
    assert.equal(a.initialEquity + a.netFunding, HOT_MONEY_INITIAL_CASH[i])
    assert.equal(a.cash, before.account.cash + delta); assert.equal(a.totalDeposits, delta)
    assert.equal(summary.pnl, before.summary.pnl); assert.equal(summary.realized, before.summary.realized)
    assert.equal(summary.unrealized, before.summary.unrealized); assert.equal(summary.frozenCash, before.summary.frozenCash)
    assert.deepEqual(a.positions, before.account.positions); assert.deepEqual(a.bot, before.account.bot)
    assert.equal(a.fundingAdjustments.length, 1); assert.equal(a.fundingAdjustments[0]!.delta, delta)
    assert.equal(a.fundingAdjustments[0]!.targetEquity, before.summary.equity + delta)
  })
  assert.deepEqual(e.state.accounts.filter(a => a.bot?.kind !== 'hotMoney'), otherAccounts)
  assert.deepEqual(e.state.orders, orders); assert.deepEqual(e.state.trades, trades)
  const after = structuredClone(e.state)
  e.upgradePopulation(); assert.deepEqual(e.state, after)
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state))); restored.upgradePopulation()
  assert.deepEqual(restored.state, after)
  restored.reset('free', 8, false)
  const newHot = restored.state.accounts.filter(a => a.bot?.kind === 'hotMoney')
  assert.deepEqual(newHot.map(a => a.initialEquity), HOT_MONEY_INITIAL_CASH)
  assert.ok(newHot.every(a => a.netFunding === 0 && a.fundingAdjustments.length === 0))
})

test('hot-money entries account for frozen orders, position limits, liquidity and cooldowns', () => {
  const profile = hotMoneyProfile(0), input = opportunity()
  assert.equal(decideHotMoney(profile, { ...input, frozenCash: input.equity * profile.maxExposure }), undefined)
  assert.equal(decideHotMoney(profile, { ...input, pendingBuys: { [DEFAULT_SYMBOL]: input.equity * profile.maxPosition } }), undefined)
  assert.equal(decideHotMoney(profile, { ...input, availableCash: 100 }), undefined)
  profile.lastActionAt = input.time - 1000
  assert.equal(decideHotMoney(profile, input), undefined)
  profile.lastActionAt = 0
  input.markets[0]!.candles = []
  assert.equal(decideHotMoney(profile, input), undefined)
})

test('stop-loss, take-profit and trailing exits respect this account’s sellable shares', () => {
  const input = opportunity(), profile = hotMoneyProfile(0)
  const position: PositionView = { symbol: DEFAULT_SYMBOL, name: 'test', shares: 1000, sellable: 0, frozenShares: 0, cost: 10000000, averageCost: 10000, price: 9600, marketValue: 9600000, unrealized: -400000, realized: 0 }
  input.positions = [position]; input.markets[0]!.price = position.price; input.marketValue = position.marketValue
  input.availableCash = 0
  assert.equal(decideHotMoney(profile, input), undefined)
  position.sellable = 400
  assert.equal(decideHotMoney(profile, input)?.quantity, 400)
  assert.match(decideHotMoney(profile, input)!.reason, /止损/)
  position.price = 10600
  assert.match(decideHotMoney(profile, input)!.reason, /止盈/)
  profile.peaks[DEFAULT_SYMBOL] = 10400; position.price = 10200
  assert.match(decideHotMoney(profile, input)!.reason, /回撤保护/)
})

test('hot-money orders use the common matcher, conserve assets and retain rationale without leaking strategy memory', () => {
  const e = new MarketEngine(undefined, { botCount: 0, hotMoneyCount: 1, warmup: false, time })
  const hot = e.state.accounts[0]!, market = opportunity().markets[0]!
  Object.assign(e.stock(), { candles: market.candles, lastPrice: market.price, previousClose: market.previousClose })
  const maker = e.createAccount('liquidity', 'trader', 5_000_000_000, 100000)
  e.submit(maker.id, { side: 'sell', kind: 'limit', price: market.price, quantity: 50000, requestId: 'maker-sell-order' })
  e.submit(maker.id, { side: 'buy', kind: 'limit', price: 10000, quantity: 50000, requestId: 'maker-buy-order' })
  const cash = e.state.accounts.reduce((sum, a) => sum + a.cash, 0)
  hot.bot!.nextAt = 0; e.advance(1)
  assert.ok(e.state.trades.some(t => t.buyAccountId === hot.id))
  assert.equal(e.state.accounts.reduce((sum, a) => sum + a.cash, 0) + e.state.feesCollected, cash)
  assert.equal(e.state.accounts.reduce((sum, a) => sum + e.accountSummary(a.id).shares, 0), 100000)
  assert.ok(e.operations.filter(o => o.accountId === hot.id && o.type === 'fill').every(o => o.reason?.includes('突破追涨')))
  assert.ok(e.frozenCash(hot.id) <= hot.cash)
  const publicView = JSON.stringify(e.view(maker.id))
  for (const secret of ['sensitivity', 'cooldown', 'peaks', 'maxExposure']) assert.ok(!publicView.includes(secret))
  assert.equal(e.accountSummary(hot.id).botStyle, 'breakout')
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state)))
  e.advance(60); restored.advance(60)
  assert.deepEqual(restored.state, e.state)
})
