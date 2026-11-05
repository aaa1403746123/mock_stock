import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MarketEngine } from './engine.ts'
import { MonitorStore } from './monitor.ts'

const time = new Date('2026-11-05T09:30:00+08:00').getTime()
test('1000 bots by default; legacy upgrade adds accounts once without altering old assets, orders or clock', () => {
  assert.equal(new MarketEngine(undefined, { warmup: false }).state.config.botCount, 1000)
  const e = new MarketEngine(undefined, { warmup: false, botCount: 24, time })
  const a = e.createAccount('owner', 'admin')
  e.submit(a.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId: 'preserved-order' })
  e.state.migrations = ['liquidity-50-stocks-v1']
  const oldAccounts = JSON.parse(JSON.stringify(e.state.accounts)), oldOrders = JSON.parse(JSON.stringify(e.state.orders))
  e.upgradePopulation()
  assert.equal(e.state.accounts.filter(a => a.role === 'bot').length, 1015)
  assert.equal(e.state.config.botCount, 1000); assert.equal(e.state.time, time); assert.equal(e.state.round, 1)
  assert.deepEqual(e.state.accounts.slice(0, oldAccounts.length), oldAccounts); assert.deepEqual(e.state.orders, oldOrders)
  assert.equal(new Set(e.state.accounts.map(a => a.id)).size, 1016)
  assert.equal(new Set(e.state.accounts.map(a => a.name)).size, 1016)
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state))); restored.upgradePopulation()
  assert.equal(restored.state.accounts.length, 1016)
  restored.reset('free', 8, false); restored.upgradePopulation()
  assert.equal(restored.state.config.botCount, 8)
  assert.throws(() => restored.reset('free', 1001, false), /配置无效/)
})

test('monitor summaries agree with personal balances and exclude credentials and private strategy parameters', () => {
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time })
  const a = e.createAccount('a'), b = e.createAccount('b', 'bot', 1000, 1000)
  b.passwordHash = 'NEVER_EXPOSE'; b.bot = { kind: 'value', primarySymbol: '600001.SH', anchors: { '600001.SH': 4981 }, nextAt: 0, frequency: 10, risk: .7 }
  e.submit(b.id, { side: 'sell', kind: 'limit', price: 4900, quantity: 200, requestId: 'sell-monitor-test' })
  e.submit(a.id, { side: 'buy', kind: 'limit', price: 4900, quantity: 100, requestId: 'buy-monitor-test' })
  for (const account of [a, b]) {
    const summary = e.accountSummary(account.id), personal = e.view(account.id).account
    for (const key of ['cash', 'availableCash', 'frozenCash', 'shares', 'sellable', 'frozenShares', 'equity', 'realized', 'unrealized', 'pnl', 'returnPct'] as const) assert.equal(summary[key], personal[key], key)
    assert.equal(summary.pnl, summary.realized + summary.unrealized)
    assert.ok(!JSON.stringify(summary).includes('NEVER_EXPOSE')); assert.ok(!JSON.stringify(summary).includes('anchor'))
  }
})

test('ledger tracks both sides of fills, exact balances and cancellation reasons; retries do not duplicate records', () => {
  const db = new DatabaseSync(':memory:'), store = new MonitorStore(db)
  try {
    const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time })
    const a = e.createAccount('a'), b = e.createAccount('b', 'trader', 0, 200)
    const sellInput = { side: 'sell' as const, kind: 'limit' as const, price: 4900, quantity: 200, requestId: 'ledger-sell' }
    const sell = e.submit(b.id, sellInput)
    e.submit(a.id, { side: 'buy', kind: 'limit', price: 4900, quantity: 100, requestId: 'ledger-buy' })
    e.cancel(b.id, sell.id)
    const count = e.operations.length
    e.submit(b.id, sellInput); assert.equal(e.operations.length, count)
    store.append(e.operations); store.append(e.operations)
    const history = store.history(1, b.id, 'all')
    assert.equal(history.total, 3); assert.deepEqual(history.operations.map(o => o.type), ['cancel', 'fill', 'submit'])
    const fill = history.operations.find(o => o.type === 'fill')!
    assert.equal(fill.cashAfter, 490000); assert.equal(fill.sharesAfter, 100); assert.equal(fill.realizedAfter, (4900 - 4862) * 100)
    assert.equal(history.operations[0]?.reason, 'user'); assert.equal(history.operations[0]?.quantity, 100)
    assert.equal(store.history(1, a.id, 'fill').total, 1)
    assert.throws(() => store.history(1, b.id, 'invalid'), /类型无效/)
    assert.throws(() => store.history(1, b.id, 'all', -1), /分页位置无效/)
  } finally { db.close() }
})

test('stable pagination and durable robot records survive engine pruning and keep round boundaries', () => {
  const db = new DatabaseSync(':memory:'), store = new MonitorStore(db)
  try {
    const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time }), a = e.createAccount('robot', 'bot')
    for (let i = 0; i < 35; i++) {
      const order = e.submit(a.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId: `pagination-${i}` })
      e.cancel(a.id, order.id)
    }
    store.append(e.operations)
    const first = store.history(1, a.id, 'all')
    assert.equal(first.operations.length, 50); assert.equal(first.total, 70); assert.ok(first.nextCursor)
    const additional = e.submit(a.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId: 'later-operation' })
    e.cancel(a.id, additional.id); store.append(e.operations)
    const second = store.history(1, a.id, 'all', first.nextCursor!)
    assert.equal(second.operations.length, 20); assert.equal(second.nextCursor, null)
    assert.equal(new Set([...first.operations, ...second.operations].map(o => o.id)).size, 70)
    e.state.time += 3 * 3600_000; e.prune()
    assert.equal(e.state.orders.length, 0); assert.equal(store.history(1, a.id, 'all').total, 72)
    assert.equal(store.history(2, a.id, 'all').total, 0)
  } finally { db.close() }
})

test('legacy backfill is honest about missing balances and runs only once', () => {
  const db = new DatabaseSync(':memory:'), store = new MonitorStore(db)
  try {
    const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time }), a = e.createAccount('legacy')
    e.submit(a.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId: 'legacy-operation' })
    store.backfill([e.state]); store.backfill([e.state])
    const history = store.history(1, a.id, 'all')
    assert.equal(history.total, 1); assert.equal(history.legacy, true); assert.equal(history.operations[0]?.type, 'snapshot')
    assert.equal(history.operations[0]?.cashAfter, null); assert.equal(history.operations[0]?.sharesAfter, null)
    assert.equal(store.needsBackfill(), false)
  } finally { db.close() }
})

test('reset and automatic cancellations remain in the outgoing round ledger', () => {
  const e = new MarketEngine(undefined, { botCount: 0, warmup: false, time }), a = e.createAccount('owner', 'admin')
  const buy = e.submit(a.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId: 'reset-operation' })
  e.reset('free', 1000, false)
  const cancelled = e.operations.find(o => o.orderId === buy.id && o.type === 'cancel')
  assert.equal(cancelled?.round, 1); assert.equal(cancelled?.reason, 'round_end')
  assert.equal(e.state.config.botCount, 1000)
  assert.ok(e.operations.some(o => o.round === 2 && o.type === 'submit'))
  assert.ok(e.operations.some(o => o.round === 2 && o.type === 'cancel' && o.reason === 'strategy'))
})
