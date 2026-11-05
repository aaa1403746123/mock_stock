import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MarketEngine } from './engine.ts'
import { STOCK_CATALOG } from '../src/shared/rules.ts'
import { applyBasePositions, hasPendingBasePositions, initBasePositions, requestBasePositions } from './base-positions.ts'

const time = Date.parse('2026-11-05T09:30:00+08:00')

test('fifty distinct stocks preserve the original ten symbols and expose independent markets', () => {
  assert.equal(STOCK_CATALOG.length, 50)
  assert.equal(new Set(STOCK_CATALOG.map(s => s.symbol)).size, 50)
  assert.equal(new Set(STOCK_CATALOG.map(s => s.name)).size, 50)
  assert.equal(STOCK_CATALOG[9]!.symbol, '600010.SH'); assert.equal(STOCK_CATALOG[49]!.symbol, '600050.SH')
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time }), owner = e.createAccount('owner')
  assert.equal(e.view(owner.id).stocks.length, 50)
  assert.equal(e.view(owner.id, '600050.SH').stock.symbol, '600050.SH')
})

test('base positions top up only the requested account, preserve higher holdings, P&L, cash and trading history', () => {
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time, mode: 'ashare' })
  const owner = e.createAccount('owner', 'admin', 100_000_000, 250000), seller = e.createAccount('seller', 'trader', 0, 1000, '600002.SH')
  e.submit(seller.id, { symbol: '600002.SH', side: 'sell', kind: 'limit', quantity: 100, price: 2600, requestId: 'seed-seller-request' })
  e.submit(owner.id, { symbol: '600002.SH', side: 'buy', kind: 'limit', quantity: 100, price: 2600, requestId: 'seed-buyer-request' })
  e.submit(owner.id, { side: 'sell', kind: 'limit', quantity: 100, price: 5000, requestId: 'seed-frozen-stock' })
  const before = e.accountSummary(owner.id), other = structuredClone(seller)
  const history = structuredClone({ stocks: e.state.stocks, orders: e.state.orders, trades: e.state.trades, operations: e.operations })
  e.seedBasePositions(owner.id, 200000)
  const after = e.accountSummary(owner.id), value = owner.stockGrants.reduce((sum, g) => sum + g.value, 0)
  assert.equal(after.positions.length, 50)
  assert.equal(after.positions.find(p => p.symbol === '600001.SH')!.shares, 250000)
  assert.ok(after.positions.filter(p => p.symbol !== '600001.SH').every(p => p.shares === 200000))
  assert.equal(after.cash, before.cash); assert.equal(after.frozenCash, before.frozenCash); assert.equal(after.frozenShares, before.frozenShares)
  assert.equal(after.pnl, before.pnl); assert.equal(after.realized, before.realized); assert.equal(after.unrealized, before.unrealized)
  assert.equal(after.netFunding - before.netFunding, value); assert.equal(after.equity - before.equity, value)
  assert.equal(e.availableShares(owner, '600002.SH'), 199900) // Existing same-day purchases retain T+1.
  assert.equal(e.availableShares(owner, '600050.SH'), 200000)
  assert.equal(owner.stockGrants.length, 49)
  assert.deepEqual(seller, other); assert.deepEqual({ stocks: e.state.stocks, orders: e.state.orders, trades: e.state.trades, operations: e.operations }, history)
  assert.equal(e.view(owner.id).account.stockGrants.length, 49)
  assert.equal(e.view(seller.id).account.stockGrants.length, 0)
  e.seedBasePositions(owner.id, 200000); assert.equal(owner.stockGrants.length, 49)
})

test('selling seeded shares does not refill on restart; a new round restores only the configured account', () => {
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time })
  const owner = e.createAccount('owner', 'admin'), other = e.createAccount('other')
  e.seedBasePositions(owner.id, 200000)
  const symbol = '600050.SH', price = e.stock(symbol).lastPrice
  e.submit(owner.id, { symbol, side: 'sell', kind: 'limit', price, quantity: 100, requestId: 'seed-sale-owner' })
  e.submit(other.id, { symbol, side: 'buy', kind: 'limit', price, quantity: 100, requestId: 'seed-sale-buyer' })
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state))); restored.upgradePopulation()
  assert.equal(restored.availableShares(restored.account(owner.id), symbol), 199900)
  restored.reset('free', 8, false)
  const positions = restored.accountSummary(owner.id).positions
  assert.equal(positions.length, 50); assert.ok(positions.every(p => p.shares === 200000 && p.sellable === 200000))
  assert.equal(restored.accountSummary(owner.id).pnl, 0)
  assert.equal(restored.accountSummary(other.id).shares, 0)
})

test('expansion supplies independent robot liquidity in all new stocks without fictional trades or profit', () => {
  const e = new MarketEngine(undefined, { botCount: 1000, hotMoneyCount: 0, warmup: false, time })
  e.state.accounts.forEach((a, i) => {
    const symbol = STOCK_CATALOG[i % 10]!.symbol, quantity = a.bot!.kind === 'maker' ? 50000 : a.bot!.kind === 'whale' ? 20000 : 5000
    a.bot!.primarySymbol = symbol
    a.positions = { [symbol]: { lots: [{ quantity, acquiredDay: '2000-01-01' }], cost: quantity * e.stock(symbol).lastPrice, realized: 0 } }
    a.initialEquity = a.cash + e.marketValue(a)
  })
  const previous = e.state.accounts.map(a => ({ id: a.id, cash: a.cash, pnl: e.accountSummary(a.id).pnl, positions: structuredClone(a.positions) }))
  e.state.migrations = e.state.migrations!.filter(m => m !== 'liquidity-50-stocks-v1')
  e.upgradePopulation()
  for (const stock of STOCK_CATALOG.slice(10)) assert.ok(e.state.accounts.some(a => a.bot?.kind === 'maker' && a.bot.primarySymbol === stock.symbol && e.availableShares(a, stock.symbol) >= 50000))
  previous.forEach(before => {
    const account = e.account(before.id)
    assert.equal(account.cash, before.cash); assert.equal(e.accountSummary(account.id).pnl, before.pnl)
    for (const [symbol, position] of Object.entries(before.positions)) assert.deepEqual(account.positions[symbol], position)
  })
  assert.equal(e.state.accounts.length, 1000); assert.equal(e.state.trades.length, 0)
  assert.ok(Object.values(e.state.stocks).every(s => s.totalVolume === 0))
  const after = structuredClone(e.state); e.upgradePopulation(); assert.deepEqual(e.state, after)
})

test('local base-position requests target a unique human and roll back with the snapshot transaction', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, json TEXT NOT NULL)'); initBasePositions(db)
    const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time })
    const owner = e.createAccount('owner', 'admin'), other = e.createAccount('other', 'admin'), bot = e.createAccount('bot', 'bot')
    db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(e.state))
    assert.throws(() => requestBasePositions(db, bot.id, 200000), /真人/)
    assert.throws(() => requestBasePositions(db, owner.id, -1), /底仓/)
    requestBasePositions(db, owner.id, 200000); requestBasePositions(db, owner.id, 200000)
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM local_base_positions').get() as { n: number }).n, 1)
    const before = structuredClone(e.state)
    db.exec('BEGIN'); const undo = applyBasePositions(db, e); db.exec('ROLLBACK'); undo()
    assert.deepEqual(e.state, before); assert.ok(hasPendingBasePositions(db))
    db.exec('BEGIN'); applyBasePositions(db, e); db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(e.state)); db.exec('COMMIT')
    assert.equal(e.accountSummary(owner.id).positions.length, 50); assert.equal(e.accountSummary(other.id).shares, 0)
    assert.equal(hasPendingBasePositions(db), false)
    const after = structuredClone(e.state); applyBasePositions(db, e); assert.deepEqual(e.state, after)
  } finally { db.close() }
})
