import type { Candle, HotMoneyState, HotMoneyStyle, PositionView, Side } from '../src/shared/types.ts'
import { HOT_MONEY_STYLES } from '../src/shared/rules.ts'

export function hotMoneyProfile(index: number): HotMoneyState {
  const style = (Object.keys(HOT_MONEY_STYLES) as HotMoneyStyle[])[index % 5]!, variant = Math.floor(index / 5)
  return { style, lookback: 10 + variant * 5, sensitivity: .0008 + variant * .0004,
    maxPosition: .16 + variant * .04, maxExposure: .5 + variant * .1,
    orderFraction: .02 + variant * .01, participation: .15 + variant * .05,
    stopLoss: .02 + variant * .01, takeProfit: .045 + variant * .025, trailingStop: .015 + variant * .0075,
    cooldown: (50 + index * 7) * 1000, lastActionAt: 0, peaks: {} }
}

// Only public candles/depth and this account's own portfolio enter the strategy.
export interface HotMoneyMarket {
  symbol: string; price: number; previousClose: number; candles: Candle[];
  bidVolume: number; askVolume: number; lower: number; upper: number;
}
export interface HotMoneyInput {
  time: number; equity: number; marketValue: number; availableCash: number; frozenCash: number;
  positions: PositionView[]; pendingBuys: Record<string, number>; markets: HotMoneyMarket[];
}
export interface HotMoneyDecision { symbol: string; side: Side; price: number; quantity: number; reason: string }

function strength(market: HotMoneyMarket, profile: HotMoneyState, time: number) {
  const bars = market.candles.filter(c => c.time <= time / 1000 && c.volume > 0).slice(-Math.max(21, profile.lookback + 1))
  if (bars.length < Math.max(10, profile.lookback + 1)) return
  const latest = bars.at(-1)!, history = bars.slice(0, -1), last = market.price
  const average = (count: number) => bars.slice(-count).reduce((sum, c) => sum + c.close, 0) / Math.min(count, bars.length)
  const ma5 = average(5), ma10 = average(10), ma20 = average(20)
  const high = Math.max(...history.slice(-profile.lookback).map(c => c.high))
  const momentum = last / bars.at(-6)!.close - 1
  const volumeBase = history.slice(-10).reduce((sum, c) => sum + c.volume, 0) / Math.min(10, history.length)
  const volumeRatio = latest.volume / Math.max(1, volumeBase)
  const pressure = (market.bidVolume - market.askVolume) / Math.max(1, market.bidVolume + market.askVolume)
  const dayChange = last / market.previousClose - 1, sensitivity = profile.sensitivity
  if (volumeRatio < .55 || dayChange > .095 || last >= market.upper || pressure < -.65) return
  let signal = false
  switch (profile.style) {
    case 'breakout': signal = last > high * (1 + sensitivity) && volumeRatio >= 1.15 && momentum > 0; break
    case 'momentum': signal = last > ma5 && ma5 > ma20 && momentum > sensitivity * 2 && momentum < .035 && pressure > -.2; break
    case 'pullback': signal = last >= ma20 * .997 && high / last - 1 > sensitivity * 2 && Math.abs(last / ma5 - 1) < .012 && latest.close > latest.open && pressure > -.3; break
    case 'reversal': signal = history.at(-1)!.close < history.at(-5)!.close && latest.close / latest.open - 1 > sensitivity * 2 && volumeRatio >= 1.4; break
    case 'swing': signal = last > ma20 && ma5 > ma10 && momentum > sensitivity && last / ma20 - 1 < .04; break
  }
  if (!signal) return
  return { score: momentum * 100 + Math.min(volumeRatio, 5) + pressure + dayChange * 5,
    liquidity: bars.slice(-3).reduce((sum, c) => sum + c.volume, 0),
    reason: `${HOT_MONEY_STYLES[profile.style]}：近5周期涨幅 ${(momentum * 100).toFixed(2)}%，成交量比 ${volumeRatio.toFixed(2)}` }
}

export function decideHotMoney(profile: HotMoneyState, input: HotMoneyInput): HotMoneyDecision | undefined {
  for (const symbol of Object.keys(profile.peaks)) if (!input.positions.some(p => p.symbol === symbol && p.shares > 0)) delete profile.peaks[symbol]
  // Exit signals bypass entry cooldowns, but sellable shares still enforce T+1 and freezes.
  for (const position of input.positions) {
    if (!position.shares) continue
    const peak = profile.peaks[position.symbol] = Math.max(profile.peaks[position.symbol] ?? position.price, position.price)
    if (!position.sellable || !position.averageCost) continue
    const gain = position.price / position.averageCost - 1, drawdown = 1 - position.price / peak
    const reason = gain <= -profile.stopLoss ? '止损减仓' : gain >= profile.takeProfit ? '止盈落袋' : peak > position.averageCost * 1.015 && drawdown >= profile.trailingStop ? '回撤保护' : ''
    const market = input.markets.find(m => m.symbol === position.symbol)
    if (!reason || !market) continue
    const desired = Math.max(100, Math.floor(position.sellable * (reason === '止损减仓' ? 1 : .5) / 100) * 100)
    return { symbol: position.symbol, side: 'sell', price: Math.max(market.lower, Math.round(position.price * .99)),
      quantity: Math.min(position.sellable, desired, 50000), reason: `${reason}：持仓收益 ${(gain * 100).toFixed(2)}%，自持仓高点回撤 ${(drawdown * 100).toFixed(2)}%` }
  }
  if (input.time - profile.lastActionAt < profile.cooldown) return
  const totalRoom = input.equity * profile.maxExposure - input.marketValue - input.frozenCash
  if (totalRoom <= 0) return
  const ranked = input.markets.flatMap(market => {
    const signal = strength(market, profile, input.time)
    return signal ? [{ market, ...signal }] : []
  }).sort((a, b) => b.score - a.score || a.market.symbol.localeCompare(b.market.symbol))
  for (const { market, liquidity, reason } of ranked) {
    const held = input.positions.find(p => p.symbol === market.symbol)?.marketValue ?? 0
    const room = input.equity * profile.maxPosition - held - (input.pendingBuys[market.symbol] ?? 0)
    const price = Math.min(market.upper, Math.round(market.price * (1.002 + profile.sensitivity)))
    const budget = Math.min(input.availableCash - 500, totalRoom, room, input.equity * profile.orderFraction)
    const quantity = Math.floor(Math.min(budget / (price * 1.001), liquidity * profile.participation, 50000) / 100) * 100
    if (quantity >= 100) return { symbol: market.symbol, side: 'buy', price, quantity, reason }
  }
}
