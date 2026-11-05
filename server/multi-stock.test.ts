import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { MarketEngine } from './engine.ts'
import { DEFAULT_SYMBOL, STOCK_CATALOG } from '../src/shared/rules.ts'
import type { EngineState, Side } from '../src/shared/types.ts'
const [A, B, C] = STOCK_CATALOG.map(s => s.symbol) as [string, string, string]
const time = new Date('2026-11-05T09:30:00+08:00').getTime()
const fresh = () => new MarketEngine(undefined, { botCount: 0, warmup: false, time })
const order = (e: MarketEngine, accountId: string, symbol: string, side: Side, price: number, quantity = 100) => e.submit(accountId, { symbol, side, kind: 'limit', price, quantity, requestId: `test-request-${e.state.seq}` })

test('fifty independent books and candles: an order cannot consume liquidity or shares of another stock', () => {
  const e = fresh(), buyer = e.createAccount('buyer'), sellerA = e.createAccount('seller A', 'trader', 0, 100, A), sellerB = e.createAccount('seller B', 'trader', 0, 200, B)
  assert.equal(Object.keys(e.state.stocks).length, 50)
  const aSell = order(e, sellerA.id, A, 'sell', 2000)
  order(e, sellerB.id, B, 'sell', 2580)
  order(e, buyer.id, B, 'buy', 3000)
  assert.equal(aSell.filled, 0); assert.equal(e.stock(A).totalVolume, 0); assert.equal(e.stock(A).lastPrice, 4862)
  assert.equal(e.stock(B).totalVolume, 100); assert.equal(e.stock(B).candles.at(-1)?.volume, 100)
  assert.equal(e.availableShares(buyer, A), 0); assert.equal(e.availableShares(buyer, B), 100)
  assert.throws(() => order(e, buyer.id, A, 'sell', 2500), /可卖数量不足/)
  assert.throws(() => order(e, buyer.id, '__proto__', 'buy', 2500), /股票代码无效/)
  assert.equal(e.view(buyer.id, A).trades.length, 0)
  assert.equal(e.view(buyer.id, B).trades.length, 1)
  assert.equal(e.view(buyer.id, C).book.asks.length, 0)
  assert.equal(e.view(buyer.id, C).account.positions[0]?.symbol, B)
})

test('cash reservations span all stocks; cost and realized profit remain per position', () => {
  const e = fresh(), trader = e.createAccount('trader', 'trader', 1000000), a = e.createAccount('seller a', 'trader', 0, 100, A), b = e.createAccount('seller b', 'trader', 0, 200, B)
  const pa = order(e, trader.id, A, 'buy', 4000), pb = order(e, trader.id, B, 'buy', 2000)
  assert.equal(e.frozenCash(trader.id), 600000)
  assert.throws(() => order(e, trader.id, C, 'buy', 6000), /资金不足/)
  e.cancel(trader.id, pa.id); e.cancel(trader.id, pb.id)
  order(e, a.id, A, 'sell', 5000); order(e, trader.id, A, 'buy', 5000)
  order(e, b.id, B, 'sell', 2000, 200); order(e, trader.id, B, 'buy', 2000, 200)
  const counterparty = e.createAccount('counterparty')
  order(e, counterparty.id, A, 'buy', 5500); order(e, trader.id, A, 'sell', 5500)
  assert.equal(trader.positions[A]?.cost, 0); assert.equal(trader.positions[A]?.realized, 50000)
  assert.equal(trader.positions[B]?.cost, 400000); assert.equal(trader.realized, 50000)
  e.stock(B).lastPrice = 2200
  const summary = e.accountSummary(trader.id)
  assert.equal(summary.marketValue, 440000); assert.equal(summary.equity, trader.cash + 440000)
  assert.equal(summary.unrealized, 40000); assert.equal(summary.pnl, 90000)
})

test('T+1 and daily limits apply to each stock instead of the combined portfolio', () => {
  const e = fresh(); e.state.config.mode = 'ashare'
  const buyer = e.createAccount('buyer', 'trader', 10000000, 100, A), seller = e.createAccount('seller', 'trader', 0, 100, B)
  order(e, seller.id, B, 'sell', 2580); order(e, buyer.id, B, 'buy', 2580)
  assert.equal(e.availableShares(buyer, A), 100); assert.equal(e.availableShares(buyer, B), 0)
  assert.deepEqual(e.limits(B), { lower: 2322, upper: 2838 })
  assert.throws(() => order(e, buyer.id, B, 'buy', 4000), /价格须在/)
  e.nextDay(); assert.equal(e.availableShares(buyer, B), 100)
})

test('self-only equity adjustments preserve trading profit, honor all freezes, and are idempotent', () => {
  const e = fresh(), admin = e.createAccount('owner', 'admin', 10000000, 100, A), trader = e.createAccount('trader')
  order(e, admin.id, B, 'buy', 2000)
  e.stock(A).lastPrice = 5000
  const profit = e.accountSummary(admin.id).pnl
  const input = { targetEquity: 20000000, reason: '增加练习资金', requestId: 'funding-test-1' }
  const first = e.adjustEquity(admin.id, input)
  assert.equal(e.accountSummary(admin.id).equity, input.targetEquity)
  assert.equal(e.accountSummary(admin.id).pnl, profit)
  assert.equal(admin.cash, input.targetEquity - 500000)
  assert.equal(admin.netFunding, first.delta); assert.equal(admin.totalDeposits, first.delta)
  e.stock(A).lastPrice += 1
  assert.equal(e.adjustEquity(admin.id, input).id, first.id); assert.equal(admin.fundingAdjustments.length, 1)
  assert.throws(() => e.adjustEquity(admin.id, { ...input, targetEquity: 30000000 }), /同一请求标识/)
  assert.throws(() => e.adjustEquity(trader.id, input), /仅管理员/)
  assert.throws(() => e.adjustEquity(admin.id, { ...input, requestId: 'funding-low', targetEquity: 600000 }), /持仓市值与冻结资金/)
  assert.throws(() => e.adjustEquity(admin.id, { ...input, requestId: 'invalid-target', targetEquity: 1.5 }), /精确到分/)
  const beforeWithdrawal = e.accountSummary(admin.id).pnl
  e.adjustEquity(admin.id, { ...input, requestId: 'withdraw-test', targetEquity: 700100 })
  assert.equal(e.frozenCash(admin.id), 200000); assert.equal(e.accountSummary(admin.id).availableCash, 0)
  assert.equal(e.accountSummary(admin.id).pnl, beforeWithdrawal)
  assert.equal(admin.equityHistory.at(-1)?.netFunding, admin.netFunding)
  const copy = new MarketEngine(JSON.parse(JSON.stringify(e.state)))
  assert.deepEqual(copy.account(admin.id).fundingAdjustments, admin.fundingAdjustments)
})

test('single-stock saves hydrate without changing assets, active orders, sessions or retry semantics', () => {
  const e = fresh(), owner = e.createAccount('owner', 'admin', 10000000, 200, A)
  const pending = order(e, owner.id, A, 'buy', 4000)
  e.state.sessions.sample = { accountId: owner.id, expires: Date.now() + 10000 }
  const current = JSON.parse(JSON.stringify(e.state))
  const primary = current.stocks[A]
  const legacy = { ...current, version: 1, ...{ lastPrice: primary.lastPrice, previousClose: primary.previousClose, totalVolume: primary.totalVolume, totalTurnover: primary.totalTurnover, candles: primary.candles } }
  delete legacy.stocks
  for (const account of legacy.accounts) { account.lots = account.positions[A]?.lots ?? []; account.cost = account.positions[A]?.cost ?? 0; delete account.positions; delete account.netFunding; delete account.totalDeposits; delete account.fundingAdjustments }
  for (const o of legacy.orders) delete o.symbol
  for (const entry of Object.values(legacy.requests) as { fingerprint: string }[]) entry.fingerprint = JSON.stringify(JSON.parse(entry.fingerprint).slice(1))
  const restored = new MarketEngine(legacy as EngineState)
  assert.equal(restored.state.version, 2); assert.equal(Object.keys(restored.state.stocks).length, 50)
  assert.equal(restored.account(owner.id).cash, owner.cash); assert.equal(restored.accountSummary(owner.id).equity, e.accountSummary(owner.id).equity)
  assert.equal(restored.availableShares(restored.account(owner.id), A), 200)
  assert.equal(restored.frozenCash(owner.id), 400000)
  const requestId = Object.keys(e.state.requests)[0]!.slice(owner.id.length + 1)
  assert.equal(restored.submit(owner.id, { side: 'buy', kind: 'limit', price: 4000, quantity: 100, requestId }).id, pending.id)
  assert.deepEqual(restored.state.sessions, e.state.sessions)
})

test('1015 independently scheduled bots trade all fifty stocks, conserve assets and resume deterministically', t => {
  const e = new MarketEngine(undefined, { warmup: false, time, seed: 321 })
  const supply = () => Object.fromEntries(STOCK_CATALOG.map(s => [s.symbol, e.state.accounts.reduce((sum, a) => sum + (a.positions[s.symbol]?.lots ?? []).reduce((v, l) => v + l.quantity, 0), 0)]))
  const beforeShares = supply(), beforeCash = e.state.accounts.reduce((sum, a) => sum + a.cash, 0)
  const durations: number[] = []
  for (let i = 0; i < 100; i++) { const start = performance.now(); e.advance(60); durations.push(performance.now() - start); e.operations.length = 0 }
  assert.equal(e.state.accounts.length, 1015)
  assert.ok(e.state.accounts.every(a => a.bot!.nextAt > time + 30000))
  assert.ok(Object.values(e.state.stocks).every(s => s.totalVolume > 0))
  assert.deepEqual(supply(), beforeShares)
  assert.equal(e.state.accounts.reduce((sum, a) => sum + a.cash, 0) + e.state.feesCollected, beforeCash)
  for (const a of e.state.accounts) {
    assert.ok(e.frozenCash(a.id) <= a.cash)
    for (const s of STOCK_CATALOG) assert.ok(e.availableShares(a, s.symbol) >= 0)
  }
  const restored = new MarketEngine(JSON.parse(JSON.stringify(e.state)))
  e.advance(60); restored.advance(60)
  assert.deepEqual(restored.state, e.state)
  const summaryStart = performance.now(); e.state.accounts.map(a => e.accountSummary(a.id))
  t.diagnostic(`1015 bots / 50 stocks: average tick ${(durations.reduce((s, n) => s + n, 0) / durations.length).toFixed(2)}ms, max ${Math.max(...durations).toFixed(2)}ms, all-account summary ${(performance.now() - summaryStart).toFixed(2)}ms`)
})
