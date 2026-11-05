import type { Account, AccountOperation, AccountSummary, BotKind, Candle, EngineState, FundingAdjustment, MarketConfig, Mode, Order, PersonalView, Position, PositionView, Side, Snapshot, StockQuote, SubmitOrder, Trade } from '../src/shared/types.ts'
import { DEFAULT_BOT_COUNT, DEFAULT_HOT_MONEY_COUNT, DEFAULT_SYMBOL, HOT_MONEY_INITIAL_CASH, MAX_ACCOUNT_EQUITY, MIN_BOT_COUNT, MAX_BOT_COUNT, STOCK_CATALOG } from '../src/shared/rules.ts'
import { hydrateState, newStocks } from './migrations.ts'
import { candleStart } from '../src/shared/chart-data.ts'
import { decideHotMoney, hotMoneyProfile } from './hot-money.ts'

export const INITIAL_PRICE = 4862
const INITIAL_CASH = 10_000_000
const active = (order: Order) => order.remaining > 0 && (order.status === 'open' || order.status === 'partial')
export const dayOf = (time: number) => new Date(time + 8 * 3600_000).toISOString().slice(0, 10)
const minuteOf = (time: number) => { const d = new Date(time + 8 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const weekday = (time: number) => new Date(time + 8 * 3600_000).getUTCDay()
const sharesOf = (account: Account, symbol: string) => (account.positions[symbol]?.lots ?? []).reduce((sum, lot) => sum + lot.quantity, 0)
const publicTrade = ({ buyAccountId, sellAccountId, buyOrderId, sellOrderId, ...trade }: Trade) => trade
export class MarketError extends Error { constructor(message: string, public status = 400) { super(message) } }

export class MarketEngine {
  state: EngineState
  operations: AccountOperation[] = []
  private accountIndex = new Map<string, Account>()
  private orderIndex = new Map<string, Order>()
  private openByAccount = new Map<string, Set<Order>>()
  private books = new Map<string, { buy: Set<Order>; sell: Set<Order> }>()
  private get botCursor() { return this.state.botCursor ?? 0 }
  private set botCursor(value: number) { this.state.botCursor = value }
  private nextPrune = 0
  constructor(saved?: EngineState, options: { warmup?: boolean; botCount?: number; hotMoneyCount?: number; mode?: Mode; seed?: number; time?: number; round?: number; feesEnabled?: boolean } = {}) {
    if (saved) { this.state = hydrateState(saved); this.rebuildIndexes(); return }
    let start = options.time ?? new Date(`${dayOf(Date.now())}T09:30:00+08:00`).getTime()
    while ([0, 6].includes(weekday(start))) start += 86400_000
    this.state = {
      version: 2, round: options.round ?? 1, time: start, day: dayOf(start), seed: options.seed ?? 20261105, seq: 0,
      stocks: newStocks(), migrations: ['population-1000-v1', 'hot-money-15-v1', 'hot-money-capital-200m-3b-v1'],
      config: { mode: options.mode ?? 'free', speed: 1, paused: false, botCount: options.botCount ?? DEFAULT_BOT_COUNT, hotMoneyCount: options.hotMoneyCount ?? (options.botCount === 0 ? 0 : DEFAULT_HOT_MONEY_COUNT), feesEnabled: options.feesEnabled ?? options.mode === 'ashare', initialCash: INITIAL_CASH },
      accounts: [], orders: [], trades: [], feesCollected: 0, sessions: {}, requests: {},
    }
    this.rebuildIndexes()
    this.addBots(this.state.config.botCount)
    this.addHotMoney(this.state.config.hotMoneyCount)
    if (options.warmup !== false && this.state.config.botCount) for (let i = 0; i < 180; i++) this.advance(30)
    for (const symbol of Object.keys(this.state.stocks)) this.ensureCandle(symbol)
  }
  rebuildIndexes() {
    this.accountIndex = new Map(this.state.accounts.map(a => [a.id, a]))
    this.orderIndex = new Map(this.state.orders.map(o => [o.id, o]))
    this.openByAccount.clear()
    this.books = new Map(Object.keys(this.state.stocks).map(symbol => [symbol, { buy: new Set<Order>(), sell: new Set<Order>() }]))
    for (const order of this.state.orders) if (active(order)) this.trackActive(order)
  }
  private ownOrders(id: string) { return this.openByAccount.get(id) ?? new Set<Order>() }
  private trackActive(order: Order) {
    if (!this.openByAccount.has(order.accountId)) this.openByAccount.set(order.accountId, new Set())
    this.openByAccount.get(order.accountId)!.add(order)
    this.books.get(order.symbol)![order.side].add(order)
  }
  private untrackActive(order: Order) { this.openByAccount.get(order.accountId)?.delete(order); this.books.get(order.symbol)?.[order.side].delete(order) }
  random() { this.state.seed = (Math.imul(this.state.seed, 1664525) + 1013904223) >>> 0; return this.state.seed / 4294967296 }
  id(prefix: string) { return `${prefix}-${this.state.round}-${++this.state.seq}` }
  stock(symbol = DEFAULT_SYMBOL) {
    if (typeof symbol !== 'string' || !Object.hasOwn(this.state.stocks, symbol)) throw new MarketError('股票代码无效', 400)
    return this.state.stocks[symbol]!
  }
  account(id: string) {
    const account = this.accountIndex.get(id)
    if (!account) throw new MarketError('账户不存在', 404)
    return account
  }
  private position(account: Account, symbol: string): Position { return account.positions[symbol] ??= { lots: [], cost: 0, realized: 0 } }
  marketValue(account: Account) { return Object.keys(account.positions).reduce((sum, symbol) => sum + sharesOf(account, symbol) * this.stock(symbol).lastPrice, 0) }
  createAccount(name: string, role: Account['role'] = 'trader', cash = this.state.config.initialCash, shares = 0, symbol = DEFAULT_SYMBOL) {
    const stock = this.stock(symbol)
    const account: Account = {
      id: this.id('a'), name, role, cash, positions: shares ? { [symbol]: { lots: [{ quantity: shares, acquiredDay: '2000-01-01' }], cost: shares * stock.lastPrice, realized: 0 } } : {},
      realized: 0, initialEquity: cash + shares * stock.lastPrice, netFunding: 0, totalDeposits: 0, fundingAdjustments: [], equityHistory: [],
    }
    this.state.accounts.push(account); this.accountIndex.set(account.id, account); this.recordEquity(account)
    return account
  }
  addBots(count: number) {
    const kinds: BotKind[] = ['maker', 'maker', 'retail', 'trend', 'value', 'retail', 'whale', 'retail']
    const offset = this.state.accounts.filter(a => a.role === 'bot' && a.bot?.kind !== 'hotMoney').length
    for (let i = offset; i < offset + count; i++) {
      const kind = kinds[Math.floor(i / STOCK_CATALOG.length) % kinds.length]!
      const symbol = STOCK_CATALOG[i % STOCK_CATALOG.length]!.symbol
      const account = this.createAccount(`策略代理 ${i + 1}`, 'bot', kind === 'whale' ? 100_000_000 : kind === 'maker' ? 200_000_000 : 20_000_000, kind === 'maker' ? 50000 : kind === 'whale' ? 20000 : 5000, symbol)
      account.bot = { kind, nextAt: this.state.time + this.random() * 30000, primarySymbol: symbol,
        anchors: Object.fromEntries(STOCK_CATALOG.map(s => [s.symbol, Math.round(this.stock(s.symbol).lastPrice * (0.97 + this.random() * 0.06))])),
        frequency: kind === 'maker' ? 10 + this.random() * 20 : 20 + this.random() * 100, risk: .2 + this.random() * .7 }
    }
  }
  addHotMoney(count: number) {
    const names = ['破晓', '凌峰', '听潮', '惊雷', '远岫', '逐日', '赤霄', '潜川', '回澜', '云帆', '长虹', '锐锋', '静渊', '星火', '苍穹']
    const offset = this.state.accounts.filter(a => a.bot?.kind === 'hotMoney').length
    for (let i = offset; i < Math.min(offset + count, DEFAULT_HOT_MONEY_COUNT); i++) {
      const symbol = STOCK_CATALOG[i % STOCK_CATALOG.length]!.symbol
      const account = this.createAccount(`游资 ${String(i + 1).padStart(2, '0')} · ${names[i]}`, 'bot', HOT_MONEY_INITIAL_CASH[i]!)
      account.bot = { kind: 'hotMoney', primarySymbol: symbol, anchors: {}, risk: .7,
        frequency: 12 + i * 2, nextAt: this.state.time + this.random() * 30000, hotMoney: hotMoneyProfile(i) }
    }
  }
  upgradePopulation() {
    if (!this.state.migrations?.includes('population-1000-v1')) {
      const count = this.state.accounts.filter(a => a.role === 'bot' && a.bot?.kind !== 'hotMoney').length
      this.addBots(Math.max(0, DEFAULT_BOT_COUNT - count))
      this.state.config.botCount = this.state.accounts.filter(a => a.role === 'bot' && a.bot?.kind !== 'hotMoney').length
      this.state.migrations = [...(this.state.migrations ?? []), 'population-1000-v1']
    }
    if (!this.state.migrations?.includes('hot-money-15-v1')) {
      this.addHotMoney(Math.max(0, DEFAULT_HOT_MONEY_COUNT - this.state.accounts.filter(a => a.bot?.kind === 'hotMoney').length))
      this.state.config.hotMoneyCount = this.state.accounts.filter(a => a.bot?.kind === 'hotMoney').length
      this.state.migrations = [...(this.state.migrations ?? []), 'hot-money-15-v1']
    }
    const capitalMigration = 'hot-money-capital-200m-3b-v1'
    if (!this.state.migrations?.includes(capitalMigration)) {
      const accounts = this.state.accounts.filter(a => a.role === 'bot' && a.bot?.kind === 'hotMoney')
      accounts.slice(0, DEFAULT_HOT_MONEY_COUNT).forEach((account, index) => {
        const capital = HOT_MONEY_INITIAL_CASH[index]!
        const delta = Math.max(0, capital - account.initialEquity - account.netFunding)
        if (!delta) return
        const beforeEquity = account.cash + this.marketValue(account)
        account.fundingAdjustments.push({ id: this.id('fund'), requestId: `${capitalMigration}:${account.id}`, time: this.state.time,
          reason: `游资资金档位升级至 ${capital / 100 / 100_000_000} 亿元`, beforeEquity, targetEquity: beforeEquity + delta,
          delta, cashBefore: account.cash, cashAfter: account.cash + delta })
        account.cash += delta; account.netFunding += delta; account.totalDeposits += delta
      })
      this.state.migrations = [...(this.state.migrations ?? []), capitalMigration]
    }
  }
  logOperation(order: Order, type: 'submit' | 'fill' | 'cancel', options: { tradeId?: string; price?: number; quantity?: number; fee?: number; reason?: string } = {}) {
    const account = this.account(order.accountId)
    this.operations.push({ id: `${this.state.round}:${type}:${options.tradeId ?? order.id}:${account.id}`, round: this.state.round,
      accountId: account.id, symbol: order.symbol, time: this.state.time, type, orderId: order.id, side: order.side, kind: order.kind,
      price: options.price ?? order.price, quantity: options.quantity ?? (type === 'cancel' ? order.remaining : order.quantity),
      remaining: order.remaining, status: order.status, fee: options.fee ?? 0, reason: options.reason ?? order.strategyReason,
      cashAfter: account.cash, sharesAfter: sharesOf(account, order.symbol), realizedAfter: account.realized })
  }
  cancelActive(order: Order, reason: string) {
    if (!active(order)) return
    order.status = 'cancelled'; this.untrackActive(order)
    if (reason === 'self_trade' || reason === 'no_liquidity') order.cancelReason = reason
    this.logOperation(order, 'cancel', { reason })
  }
  isTrading() {
    if (this.state.config.mode === 'free') return true
    const minute = minuteOf(this.state.time)
    return ![0, 6].includes(weekday(this.state.time)) && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900))
  }
  status() {
    if (this.state.config.paused) return '市场已暂停'
    if (this.isTrading()) return '交易进行中'
    const minute = minuteOf(this.state.time)
    return minute >= 690 && minute < 780 && ![0, 6].includes(weekday(this.state.time)) ? '午间休市' : '非交易时段'
  }
  limits(symbol = DEFAULT_SYMBOL) { const stock = this.stock(symbol); return this.state.config.mode === 'ashare' ? { lower: Math.round(stock.previousClose * .9), upper: Math.round(stock.previousClose * 1.1) } : { lower: 1, upper: 10_000_000 } }
  feeFor(turnover: number, side: Side) {
    if (!this.state.config.feesEnabled || !turnover) return 0
    return Math.max(500, Math.round(turnover * .0003)) + Math.round(turnover * .00001) + (side === 'sell' ? Math.round(turnover * .0005) : 0)
  }
  reserveFor(order: Order) { return order.remaining * order.price + Math.max(0, this.feeFor(order.turnover + order.remaining * order.price, 'buy') - order.fee) }
  sellFeeReserve(order: Order) { return Math.max(0, this.feeFor(order.turnover + order.price, 'sell') - order.fee - order.price) }
  frozenCash(id: string) { let sum = 0; for (const o of this.ownOrders(id)) sum += o.side === 'buy' ? this.reserveFor(o) : this.sellFeeReserve(o); return sum }
  frozenShares(id: string, symbol = DEFAULT_SYMBOL) { let sum = 0; for (const o of this.ownOrders(id)) if (o.side === 'sell' && o.symbol === symbol) sum += o.remaining; return sum }
  availableShares(account: Account, symbol = DEFAULT_SYMBOL) { return (account.positions[symbol]?.lots ?? []).filter(lot => this.state.config.mode === 'free' || lot.acquiredDay < this.state.day).reduce((sum, lot) => sum + lot.quantity, 0) - this.frozenShares(account.id, symbol) }
  submit(accountId: string, input: SubmitOrder, internal = false, strategyReason?: string): Order {
    const account = this.account(accountId), symbol = input.symbol ?? DEFAULT_SYMBOL, stock = this.stock(symbol)
    const fingerprint = JSON.stringify([symbol, input.side, input.kind, input.price ?? null, input.quantity])
    if (!internal) {
      if (typeof input.requestId !== 'string' || input.requestId.length < 8 || input.requestId.length > 100) throw new MarketError('订单请求标识无效')
      const prior = this.state.requests[`${accountId}:${input.requestId}`]
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new MarketError('同一请求标识不能用于不同订单', 409)
        const original = this.orderIndex.get(prior.orderId)
        if (!original) throw new MarketError('该请求已处理，请刷新订单记录', 409)
        return original
      }
    }
    if (this.state.config.paused) throw new MarketError('市场已暂停，请继续运行后交易')
    if (!this.isTrading()) throw new MarketError('当前为非交易时段，可在交易时段下单')
    if (input.side !== 'buy' && input.side !== 'sell') throw new MarketError('买卖方向无效')
    if (input.kind !== 'limit' && input.kind !== 'market') throw new MarketError('委托类型无效')
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000_000) throw new MarketError('委托数量须为 1 至 1,000,000 的整数')
    if (this.state.config.mode === 'ashare' && input.quantity % 100 !== 0 && !(input.side === 'sell' && input.quantity === this.availableShares(account, symbol))) throw new MarketError('普通主板买入须为 100 股的整数倍；卖出零股须一次卖出全部可卖数量')
    const { lower, upper } = this.limits(symbol)
    const price = input.kind === 'market' ? Math.min(upper, Math.max(lower, Math.round(stock.lastPrice * (input.side === 'buy' ? 1.02 : .98)))) : input.price
    if (!Number.isSafeInteger(price) || price! < lower || price! > upper) throw new MarketError(`价格须在 ${(lower / 100).toFixed(2)} 至 ${(upper / 100).toFixed(2)} 元之间，精确到分`)
    if (this.ownOrders(accountId).size >= 100) throw new MarketError('当前委托已达上限，请先撤销部分订单')
    if (input.side === 'buy' && account.cash - this.frozenCash(accountId) < price! * input.quantity + this.feeFor(price! * input.quantity, 'buy')) throw new MarketError('可用资金不足，委托金额需包含价格保护及费用预留')
    if (input.side === 'sell' && this.availableShares(account, symbol) < input.quantity) throw new MarketError(this.state.config.mode === 'ashare' ? '该股票可卖数量不足；当日买入须到下一模拟交易日才能卖出' : '该股票可卖数量不足，请检查持仓及冻结数量')
    if (input.side === 'sell' && account.cash - this.frozenCash(accountId) < Math.max(0, this.feeFor(price!, 'sell') - price!)) throw new MarketError('低价股票卖出须预留可用资金，以支付首次部分成交的最低佣金')
    const order: Order = { id: this.id('o'), accountId, symbol, side: input.side, kind: input.kind, price: price!, quantity: input.quantity, remaining: input.quantity, filled: 0, averagePrice: 0, status: 'open', createdAt: this.state.time, seq: this.state.seq, fee: 0, turnover: 0 }
    if (internal && strategyReason) order.strategyReason = strategyReason
    this.state.orders.push(order); this.orderIndex.set(order.id, order); this.trackActive(order)
    if (!internal) this.state.requests[`${accountId}:${input.requestId}`] = { orderId: order.id, fingerprint }
    this.logOperation(order, 'submit')
    const opposite = [...this.books.get(symbol)![order.side === 'buy' ? 'sell' : 'buy']]
      .filter(o => order.side === 'buy' ? o.price <= order.price : o.price >= order.price)
      .sort((a, b) => (order.side === 'buy' ? a.price - b.price : b.price - a.price) || a.seq - b.seq)
    for (const resting of opposite) {
      if (!order.remaining) break
      if (resting.accountId === accountId) { this.cancelActive(order, 'self_trade'); break }
      this.execute(order, resting, Math.min(order.remaining, resting.remaining), resting.price)
    }
    if (order.kind === 'market' && order.remaining) this.cancelActive(order, 'no_liquidity')
    return order
  }
  execute(incoming: Order, resting: Order, quantity: number, price: number) {
    if (incoming.symbol !== resting.symbol) throw new MarketError('不同股票不能撮合')
    const buy = incoming.side === 'buy' ? incoming : resting, sell = incoming.side === 'sell' ? incoming : resting
    const buyer = this.account(buy.accountId), seller = this.account(sell.accountId), symbol = buy.symbol, stock = this.stock(symbol)
    const buyerPosition = this.position(buyer, symbol), sellerPosition = this.position(seller, symbol)
    const value = quantity * price, buyFee = this.feeFor(buy.turnover + value, 'buy') - buy.fee, sellFee = this.feeFor(sell.turnover + value, 'sell') - sell.fee
    const sellerShares = sharesOf(seller, symbol)
    const soldCost = quantity === sellerShares ? sellerPosition.cost : Math.round(sellerPosition.cost * quantity / sellerShares)
    buyer.cash -= value + buyFee
    const sameDayLot = buyerPosition.lots.find(lot => lot.acquiredDay === this.state.day)
    if (sameDayLot) sameDayLot.quantity += quantity
    else buyerPosition.lots.push({ quantity, acquiredDay: this.state.day })
    buyerPosition.cost += value + buyFee; seller.cash += value - sellFee; sellerPosition.cost -= soldCost
    const realized = value - sellFee - soldCost
    seller.realized += realized; sellerPosition.realized += realized
    let toRemove = quantity
    for (const lot of sellerPosition.lots) {
      if (this.state.config.mode === 'ashare' && lot.acquiredDay >= this.state.day) continue
      const removed = Math.min(lot.quantity, toRemove); lot.quantity -= removed; toRemove -= removed
      if (!toRemove) break
    }
    sellerPosition.lots = sellerPosition.lots.filter(lot => lot.quantity > 0)
    this.state.feesCollected += buyFee + sellFee
    for (const [order, fee] of [[buy, buyFee], [sell, sellFee]] as const) {
      order.remaining -= quantity; order.filled += quantity; order.turnover += value; order.fee += fee; order.averagePrice = order.turnover / order.filled
      order.status = order.remaining ? 'partial' : 'filled'
      if (!order.remaining) this.untrackActive(order)
    }
    stock.lastPrice = price; stock.totalVolume += quantity; stock.totalTurnover += value
    const trade: Trade = { id: this.id('t'), symbol, time: this.state.time, price, quantity, side: incoming.side, buyAccountId: buyer.id, sellAccountId: seller.id, buyOrderId: buy.id, sellOrderId: sell.id }
    this.state.trades.push(trade)
    for (const candle of [this.ensureCandle(symbol), this.ensureDailyCandle(symbol)]) {
      if (candle.volume === 0) candle.open = candle.high = candle.low = price
      candle.high = Math.max(candle.high, price); candle.low = Math.min(candle.low, price); candle.close = price; candle.volume += quantity
    }
    this.recordEquity(buyer); this.recordEquity(seller)
    this.logOperation(buy, 'fill', { tradeId: trade.id, price, quantity, fee: buyFee }); this.logOperation(sell, 'fill', { tradeId: trade.id, price, quantity, fee: sellFee })
  }
  cancel(accountId: string, orderId: string) {
    const order = this.orderIndex.get(orderId)
    if (!order || order.accountId !== accountId) throw new MarketError('委托不存在', 404)
    if (!active(order)) throw new MarketError('该委托已结束，无法撤销')
    this.cancelActive(order, 'user'); return order
  }
  ensureCandle(symbol = DEFAULT_SYMBOL): Candle {
    this.ensureDailyCandle(symbol)
    const stock = this.stock(symbol), time = Math.floor(this.state.time / 60_000) * 60
    let candle = stock.candles.at(-1)
    if (!candle || candle.time !== time) {
      candle = { time, open: stock.lastPrice, high: stock.lastPrice, low: stock.lastPrice, close: stock.lastPrice, volume: 0 }
      stock.candles.push(candle); if (stock.candles.length > 1440) stock.candles.shift()
    }
    return candle
  }
  private ensureDailyCandle(symbol: string): Candle {
    const stock = this.stock(symbol), time = candleStart(this.state.time / 1000, '1d')
    let candle = stock.dailyCandles.at(-1)
    if (!candle || candle.time !== time) {
      candle = { time, open: stock.lastPrice, high: stock.lastPrice, low: stock.lastPrice, close: stock.lastPrice, volume: 0 }
      stock.dailyCandles.push(candle)
    }
    return candle
  }
  recordEquity(account: Account) {
    if (account.role === 'bot') return
    const point = { time: Math.floor(this.state.time / 60_000) * 60, equity: account.cash + this.marketValue(account), netFunding: account.netFunding }
    if (account.equityHistory.at(-1)?.time === point.time) account.equityHistory[account.equityHistory.length - 1] = point
    else account.equityHistory.push(point)
    if (account.equityHistory.length > 1440) account.equityHistory.shift()
  }
  rollDay() {
    if (this.state.day === dayOf(this.state.time)) return
    this.state.day = dayOf(this.state.time)
    for (const stock of Object.values(this.state.stocks)) { stock.previousClose = stock.lastPrice; stock.totalVolume = 0; stock.totalTurnover = 0 }
    if (this.state.config.mode === 'ashare') for (const orders of this.openByAccount.values()) for (const order of [...orders]) this.cancelActive(order, 'day_end')
  }
  advance(seconds: number) {
    if (this.state.config.paused) return
    const oldTime = this.state.time
    this.state.time += seconds * 1000; this.rollDay()
    if (this.state.config.mode === 'ashare' && minuteOf(oldTime) < 900 && minuteOf(this.state.time) >= 900) for (const orders of this.openByAccount.values()) for (const order of [...orders]) this.cancelActive(order, 'day_end')
    if (this.isTrading()) { for (const symbol of Object.keys(this.state.stocks)) this.ensureCandle(symbol); this.runBots() }
    for (const account of this.state.accounts) this.recordEquity(account)
    if (this.state.time >= this.nextPrune) { this.prune(); this.nextPrune = this.state.time + 30000 }
  }
  nextDay() {
    let next = new Date(`${this.state.day}T09:30:00+08:00`).getTime() + 86400_000
    while ([0, 6].includes(weekday(next))) next += 86400_000
    this.state.time = next; this.rollDay()
    for (const symbol of Object.keys(this.state.stocks)) this.ensureCandle(symbol)
    for (const a of this.state.accounts) this.recordEquity(a)
  }
  runBots() {
    // Fair rotating batches bound work per tick; every bot has its own assets, clock and strategy state.
    const bots = this.state.accounts.filter(a => a.bot)
    let decisions = 0, inspected = 0
    while (inspected < bots.length && decisions < 200) {
      const account = bots[this.botCursor % bots.length]!
      this.botCursor = (this.botCursor + 1) % bots.length; inspected++
      const bot = account.bot!
      if (bot.nextAt > this.state.time) continue
      decisions++; bot.nextAt = this.state.time + bot.frequency * (.5 + this.random()) * 1000
      for (const order of [...this.ownOrders(account.id)]) if (this.state.time - order.createdAt > (bot.kind === 'maker' ? 4000 : 30000)) this.cancelActive(order, 'strategy')
      if (bot.kind === 'hotMoney') { this.runHotMoney(account); continue }
      // Decisions use this bot's private state and the public tape, never another portfolio.
      const symbol = bot.kind === 'maker' || this.random() < .75 ? bot.primarySymbol : STOCK_CATALOG[Math.floor(this.random() * STOCK_CATALOG.length)]!.symbol
      const stock = this.stock(symbol), last = stock.lastPrice, reference = stock.candles.at(-6)?.close ?? last
      const { lower, upper } = this.limits(symbol), clamp = (p: number) => Math.max(lower, Math.min(upper, Math.round(p)))
      const send = (side: Side, price: number, desired: number) => {
        const budget = account.cash - this.frozenCash(account.id)
        const maximum = side === 'buy' ? Math.floor(Math.max(0, budget - 500) / (price * 1.001)) : this.availableShares(account, symbol)
        const quantity = Math.floor(Math.min(desired, maximum) / 100) * 100
        if (quantity < 100) return
        try { this.submit(account.id, { symbol, side, kind: 'limit', price, quantity, requestId: '' }, true) } catch (e) { if (!(e instanceof MarketError)) throw e }
      }
      if (bot.kind === 'maker') {
        const center = clamp(last - (sharesOf(account, symbol) - 50000) / 50000 * 4), spread = 1 + Math.floor(this.random() * 6)
        send('buy', clamp(center - spread), 300 + Math.floor(this.random() * 12) * 100); send('sell', clamp(center + spread), 300 + Math.floor(this.random() * 12) * 100); continue
      }
      if (this.random() < .2) continue
      let buyProbability = .5
      if (bot.kind === 'trend') buyProbability = last > reference ? .72 : last < reference ? .28 : .5
      const anchor = bot.anchors[symbol] ?? stock.previousClose
      if (bot.kind === 'value') buyProbability = Math.max(.15, Math.min(.85, .5 + (anchor - last) / Math.max(50, stock.previousClose * .05)))
      if (bot.kind === 'whale') buyProbability = Math.max(.2, Math.min(.8, .5 + (anchor - last) / Math.max(80, stock.previousClose * .08)))
      const side: Side = this.random() < buyProbability ? 'buy' : 'sell', aggressive = this.random() < (bot.kind === 'trend' ? .75 : .58)
      const distance = 1 + Math.floor(this.random() * (bot.kind === 'whale' ? 20 : 12))
      send(side, clamp(last + (side === 'buy' ? 1 : -1) * distance * (aggressive ? 1 : -1)), (1 + Math.floor(this.random() * (bot.kind === 'whale' ? 24 : 5))) * 100)
    }
  }
  private runHotMoney(account: Account) {
    const profile = account.bot?.hotMoney
    if (!profile) return
    const markets = Object.values(this.state.stocks).map(stock => {
      const depth = (side: Side) => {
        const levels = new Map<number, number>()
        for (const order of this.books.get(stock.symbol)![side]) levels.set(order.price, (levels.get(order.price) ?? 0) + order.remaining)
        return [...levels].sort((a, b) => side === 'buy' ? b[0] - a[0] : a[0] - b[0]).slice(0, 5).reduce((sum, [, quantity]) => sum + quantity, 0)
      }
      return { symbol: stock.symbol, price: stock.lastPrice, previousClose: stock.previousClose, candles: stock.candles,
        bidVolume: depth('buy'), askVolume: depth('sell'), ...this.limits(stock.symbol) }
    })
    const marketValue = this.marketValue(account), frozenCash = this.frozenCash(account.id), pendingBuys: Record<string, number> = {}
    for (const order of this.ownOrders(account.id)) if (order.side === 'buy') pendingBuys[order.symbol] = (pendingBuys[order.symbol] ?? 0) + this.reserveFor(order)
    const decision = decideHotMoney(profile, { time: this.state.time, equity: account.cash + marketValue, marketValue,
      availableCash: account.cash - frozenCash, frozenCash, positions: this.positionViews(account), pendingBuys, markets })
    if (!decision) return
    try {
      this.submit(account.id, { ...decision, kind: 'limit', requestId: '' }, true, decision.reason)
      profile.lastActionAt = this.state.time
    } catch (error) { if (!(error instanceof MarketError)) throw error }
  }
  prune() {
    const cutoff = this.state.time - 2 * 3600_000
    let keptBotOrders = 0
    this.state.orders = this.state.orders.filter(o => active(o) || this.account(o.accountId).role !== 'bot' || o.createdAt >= cutoff).reverse()
      .filter(o => active(o) || this.account(o.accountId).role !== 'bot' || ++keptBotOrders <= 2000).reverse()
    this.orderIndex = new Map(this.state.orders.map(o => [o.id, o]))
    if (this.state.trades.length > 10000) this.state.trades = this.state.trades.filter((t, i, all) => i >= all.length - 5000 || this.account(t.buyAccountId).role !== 'bot' || this.account(t.sellAccountId).role !== 'bot')
  }
  configure(config: Partial<MarketConfig>) {
    if (config.speed !== undefined && ![1, 5, 20, 60].includes(config.speed)) throw new MarketError('不支持的时间倍率')
    if (config.paused !== undefined && typeof config.paused !== 'boolean') throw new MarketError('暂停状态无效')
    if (config.speed !== undefined) this.state.config.speed = config.speed
    if (config.paused !== undefined) this.state.config.paused = config.paused
  }
  reset(mode: Mode, botCount: number, feesEnabled: boolean) {
    if (!['free', 'ashare'].includes(mode) || !Number.isInteger(botCount) || botCount < MIN_BOT_COUNT || botCount > MAX_BOT_COUNT || typeof feesEnabled !== 'boolean') throw new MarketError('新练习配置无效')
    const old = this.state
    const fresh = new MarketEngine(undefined, { mode, botCount, feesEnabled, round: old.round + 1, seed: old.seed, time: new Date(`${old.day}T09:30:00+08:00`).getTime() })
    for (const orders of this.openByAccount.values()) for (const order of [...orders]) this.cancelActive(order, 'round_end')
    fresh.state.sessions = old.sessions
    for (const account of old.accounts.filter(a => a.role !== 'bot')) {
      fresh.state.accounts.push({ ...account, cash: fresh.state.config.initialCash, positions: {}, realized: 0, initialEquity: fresh.state.config.initialCash, netFunding: 0, totalDeposits: 0, fundingAdjustments: [], equityHistory: [] })
      fresh.recordEquity(fresh.state.accounts.at(-1)!)
    }
    this.state = fresh.state; this.rebuildIndexes(); this.botCursor = 0; this.nextPrune = 0
    for (const operation of fresh.operations) this.operations.push(operation)
  }
  positionViews(account: Account): PositionView[] {
    return Object.keys(account.positions).map(symbol => {
      const position = account.positions[symbol]!, stock = this.stock(symbol), shares = sharesOf(account, symbol), marketValue = shares * stock.lastPrice
      return { symbol, name: stock.name, shares, sellable: this.availableShares(account, symbol), frozenShares: this.frozenShares(account.id, symbol), cost: position.cost, averageCost: shares ? position.cost / shares : 0, price: stock.lastPrice, marketValue, unrealized: marketValue - position.cost, realized: position.realized }
    })
  }
  accountSummary(accountId: string): AccountSummary {
    const account = this.account(accountId), positions = this.positionViews(account), frozenCash = this.frozenCash(accountId)
    const marketValue = positions.reduce((s, p) => s + p.marketValue, 0), shares = positions.reduce((s, p) => s + p.shares, 0)
    const equity = account.cash + marketValue, pnl = equity - account.initialEquity - account.netFunding
    const invested = account.initialEquity + account.totalDeposits, held = positions.filter(p => p.shares > 0)
    return { id: account.id, name: account.name, role: account.role, botKind: account.bot?.kind ?? null, botStyle: account.bot?.hotMoney?.style ?? null,
      cash: account.cash, availableCash: account.cash - frozenCash, frozenCash, shares,
      sellable: positions.reduce((s, p) => s + p.sellable, 0), frozenShares: positions.reduce((s, p) => s + p.frozenShares, 0),
      marketValue, averageCost: held.length === 1 ? held[0]!.averageCost : 0, equity, initialEquity: account.initialEquity,
      realized: account.realized, unrealized: positions.reduce((s, p) => s + p.unrealized, 0), pnl, returnPct: invested > 0 ? pnl / invested * 100 : 0,
      openOrders: this.ownOrders(accountId).size, netFunding: account.netFunding, totalDeposits: account.totalDeposits, positions }
  }
  adjustEquity(accountId: string, input: { targetEquity: number; reason: string; requestId: string }): FundingAdjustment {
    const account = this.account(accountId)
    if (account.role !== 'admin') throw new MarketError('仅管理员可调整自己的总资产', 403)
    if (typeof input.requestId !== 'string' || input.requestId.length < 8 || input.requestId.length > 100) throw new MarketError('资金调整请求标识无效')
    if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 100) throw new MarketError('请填写 1–100 字的调整原因')
    if (!Number.isSafeInteger(input.targetEquity) || input.targetEquity < 0 || input.targetEquity > MAX_ACCOUNT_EQUITY) throw new MarketError('总资产须为 0–100 亿元之间的金额，精确到分')
    const previous = account.fundingAdjustments.find(a => a.requestId === input.requestId)
    if (previous) {
      if (previous.targetEquity !== input.targetEquity || previous.reason !== input.reason.trim()) throw new MarketError('同一请求标识不能用于不同资金调整', 409)
      return previous
    }
    const marketValue = this.marketValue(account), frozen = this.frozenCash(accountId), cash = input.targetEquity - marketValue
    if (cash < frozen) throw new MarketError(`目标总资产不能低于持仓市值与冻结资金之和：¥${((marketValue + frozen) / 100).toFixed(2)}`)
    const beforeEquity = account.cash + marketValue, delta = input.targetEquity - beforeEquity
    const adjustment: FundingAdjustment = { id: this.id('fund'), requestId: input.requestId, time: this.state.time, reason: input.reason.trim(), beforeEquity, targetEquity: input.targetEquity, delta, cashBefore: account.cash, cashAfter: cash }
    account.cash = cash; account.netFunding += delta; account.totalDeposits += Math.max(0, delta); account.fundingAdjustments.push(adjustment); this.recordEquity(account)
    return adjustment
  }
  quote(symbol = DEFAULT_SYMBOL): StockQuote {
    const stock = this.stock(symbol), today = stock.dailyCandles.at(-1), hasTrades = today && dayOf(today.time * 1000) === this.state.day && today.volume > 0, { lower, upper } = this.limits(symbol)
    return { symbol, name: stock.name, sector: stock.sector, price: stock.lastPrice, previousClose: stock.previousClose,
      change: stock.lastPrice - stock.previousClose, changePct: (stock.lastPrice / stock.previousClose - 1) * 100,
      open: hasTrades ? today.open : stock.lastPrice, high: hasTrades ? today.high : stock.lastPrice, low: hasTrades ? today.low : stock.lastPrice,
      volume: stock.totalVolume, turnover: stock.totalTurnover, upperLimit: this.state.config.mode === 'ashare' ? upper : null, lowerLimit: this.state.config.mode === 'ashare' ? lower : null }
  }
  view(accountId: string, symbol = DEFAULT_SYMBOL): Snapshot {
    const account = this.account(accountId), stock = this.stock(symbol), summary = this.accountSummary(accountId)
    const personal: PersonalView = { ...summary, registered: !!account.username, cost: summary.positions.reduce((s, p) => s + p.cost, 0),
      orders: this.state.orders.filter(o => o.accountId === accountId).slice(-200).reverse().map(o => ({ ...o })),
      trades: this.state.trades.filter(t => t.buyAccountId === accountId || t.sellAccountId === accountId).slice(-200).reverse().map(t => ({ ...publicTrade(t), side: t.buyAccountId === accountId ? 'buy' : 'sell' })),
      equityHistory: account.equityHistory, fundingAdjustments: account.fundingAdjustments }
    const levels = (side: Side) => {
      const grouped = new Map<number, number>()
      for (const order of this.books.get(symbol)![side]) grouped.set(order.price, (grouped.get(order.price) ?? 0) + order.remaining)
      return [...grouped].sort((a, b) => side === 'buy' ? b[0] - a[0] : a[0] - b[0]).slice(0, 5).map(([price, quantity]) => ({ price, quantity }))
    }
    return { round: this.state.round, time: this.state.time, day: this.state.day, config: { ...this.state.config }, status: this.status(),
      stock: this.quote(symbol), stocks: Object.keys(this.state.stocks).map(s => this.quote(s)), book: { bids: levels('buy'), asks: levels('sell') }, candles: stock.candles, dailyCandles: stock.dailyCandles,
      trades: this.state.trades.filter(t => t.symbol === symbol).slice(-40).reverse().map(publicTrade),
      bots: (['retail', 'trend', 'value', 'whale', 'maker', 'hotMoney'] as BotKind[]).map(kind => ({ kind, count: this.state.accounts.filter(a => a.bot?.kind === kind).length })), participants: this.state.accounts.length, account: personal }
  }
}
