import { DEFAULT_SYMBOL, STOCK_CATALOG } from '../src/shared/rules.ts'
import { aggregateCandles } from '../src/shared/chart-data.ts'
import type { Account, EngineState, Lot, StockState } from '../src/shared/types.ts'

export const newStocks = (): Record<string, StockState> => Object.fromEntries(STOCK_CATALOG.map(s => [s.symbol, {
  symbol: s.symbol, name: s.name, sector: s.sector, lastPrice: s.initialPrice, previousClose: s.initialPrice,
  totalVolume: 0, totalTurnover: 0, candles: [], dailyCandles: [],
}]))

/** Preserve old portfolio costs, lots, market history, sessions and order IDs on read. */
export function hydrateState(value: unknown): EngineState {
  const state = value as EngineState & { lastPrice?: number; previousClose?: number; candles?: StockState['candles']; totalVolume?: number; totalTurnover?: number }
  if (!state.stocks) {
    state.stocks = newStocks()
    Object.assign(state.stocks[DEFAULT_SYMBOL]!, { lastPrice: state.lastPrice, previousClose: state.previousClose,
      candles: state.candles ?? [], totalVolume: state.totalVolume ?? 0, totalTurnover: state.totalTurnover ?? 0 })
  }
  for (const definition of STOCK_CATALOG) state.stocks[definition.symbol] ??= newStocks()[definition.symbol]!
  state.config.hotMoneyCount ??= state.accounts.filter(a => a.bot?.kind === 'hotMoney').length
  for (const stock of Object.values(state.stocks)) {
    if (!stock.dailyCandles?.length) stock.dailyCandles = aggregateCandles(stock.candles, '1d')
  }
  for (const account of state.accounts) {
    const old = account as Account & { lots?: Lot[]; cost?: number; bot?: Account['bot'] & { anchor?: number } }
    account.positions ??= { [DEFAULT_SYMBOL]: { lots: old.lots ?? [], cost: old.cost ?? 0, realized: account.realized } }
    account.netFunding ??= 0; account.totalDeposits ??= 0; account.fundingAdjustments ??= []
    if (old.bot) {
      old.bot.primarySymbol ??= DEFAULT_SYMBOL
      old.bot.anchors ??= Object.fromEntries(STOCK_CATALOG.map(s => [s.symbol, s.symbol === DEFAULT_SYMBOL ? old.bot!.anchor ?? s.initialPrice : s.initialPrice]))
      delete old.bot.anchor
    }
    delete old.lots; delete old.cost
  }
  for (const order of state.orders) order.symbol ??= DEFAULT_SYMBOL
  for (const trade of state.trades) trade.symbol ??= DEFAULT_SYMBOL
  // Keep deduplication fingerprints valid for orders accepted by the single-stock version.
  for (const entry of Object.values(state.requests)) {
    const parts: unknown[] = JSON.parse(entry.fingerprint)
    if (parts.length === 4) entry.fingerprint = JSON.stringify([DEFAULT_SYMBOL, ...parts])
  }
  state.version = 2
  delete state.lastPrice; delete state.previousClose; delete state.candles; delete state.totalVolume; delete state.totalTurnover
  return state
}
