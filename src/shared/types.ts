export type Mode = 'free' | 'ashare'
export type Side = 'buy' | 'sell'
export type OrderKind = 'limit' | 'market'
export type BotKind = 'retail' | 'trend' | 'value' | 'whale' | 'maker' | 'hotMoney'
export type HotMoneyStyle = 'breakout' | 'momentum' | 'pullback' | 'reversal' | 'swing'
export interface HotMoneyState {
  style: HotMoneyStyle; lookback: number; sensitivity: number; maxPosition: number; maxExposure: number;
  orderFraction: number; participation: number; stopLoss: number; takeProfit: number; trailingStop: number;
  cooldown: number; lastActionAt: number; peaks: Record<string, number>;
}
export interface Lot { quantity: number; acquiredDay: string }
export interface Position { lots: Lot[]; cost: number; realized: number }
export interface EquityPoint { time: number; equity: number; netFunding?: number }
export interface StockGrant { id: string; time: number; symbol: string; quantity: number; price: number; value: number; sharesBefore: number; sharesAfter: number; reason: string }
export interface FundingAdjustment {
  id: string; requestId: string; time: number; reason: string; beforeEquity: number; targetEquity: number;
  delta: number; cashBefore: number; cashAfter: number;
}
export interface StockState {
  symbol: string; name: string; sector: string; lastPrice: number; previousClose: number;
  totalVolume: number; totalTurnover: number; candles: Candle[]; dailyCandles: Candle[];
}
export interface Account {
  id: string; name: string; role: 'admin' | 'trader' | 'bot'; username?: string; passwordHash?: string;
  cash: number; positions: Record<string, Position>; realized: number; initialEquity: number;
  netFunding: number; totalDeposits: number; fundingAdjustments: FundingAdjustment[];
  stockGrants: StockGrant[]; basePositionQuantity?: number;
  bot?: { kind: BotKind; nextAt: number; primarySymbol: string; anchors: Record<string, number>; frequency: number; risk: number; hotMoney?: HotMoneyState };
  equityHistory: EquityPoint[];
}
export interface Order {
  id: string; accountId: string; symbol: string; side: Side; kind: OrderKind; price: number; quantity: number;
  remaining: number; filled: number; averagePrice: number; status: 'open' | 'partial' | 'filled' | 'cancelled';
  createdAt: number; seq: number; fee: number; turnover: number; cancelReason?: 'self_trade' | 'no_liquidity'; strategyReason?: string;
}
export interface Trade { id: string; symbol: string; time: number; price: number; quantity: number; side: Side; buyAccountId: string; sellAccountId: string; buyOrderId: string; sellOrderId: string }
export type PublicTrade = Omit<Trade, 'buyAccountId' | 'sellAccountId' | 'buyOrderId' | 'sellOrderId'>
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface MarketConfig { mode: Mode; speed: number; paused: boolean; botCount: number; hotMoneyCount: number; feesEnabled: boolean; initialCash: number }
export interface EngineState {
  migrations?: string[];
  botCursor?: number;
  version: 2; round: number; time: number; day: string; seed: number; seq: number;
  config: MarketConfig; stocks: Record<string, StockState>; accounts: Account[]; orders: Order[]; trades: Trade[];
  feesCollected: number;
  sessions: Record<string, { accountId: string; expires: number }>;
  requests: Record<string, { orderId: string; fingerprint: string }>;
}
export interface PersonalView {
  id: string; name: string; role: 'admin' | 'trader' | 'bot'; registered: boolean;
  cash: number; availableCash: number; frozenCash: number; shares: number; sellable: number; frozenShares: number;
  cost: number; equity: number; initialEquity: number; realized: number; unrealized: number; pnl: number; returnPct: number;
  marketValue: number; positions: PositionView[]; netFunding: number; totalDeposits: number; fundingAdjustments: FundingAdjustment[];
  orders: Order[]; trades: (PublicTrade & { side: Side })[]; equityHistory: EquityPoint[];
  stockGrants: StockGrant[]; basePositionQuantity?: number;
}
export interface PositionView { symbol: string; name: string; shares: number; sellable: number; frozenShares: number; cost: number; averageCost: number; price: number; marketValue: number; unrealized: number; realized: number }
export interface StockQuote { symbol: string; name: string; sector: string; price: number; previousClose: number; change: number; changePct: number; open: number; high: number; low: number; volume: number; turnover: number; upperLimit: number | null; lowerLimit: number | null }
export interface Snapshot {
  round: number; time: number; day: string; config: MarketConfig; status: string;
  stock: StockQuote; stocks: StockQuote[];
  book: { bids: { price: number; quantity: number }[]; asks: { price: number; quantity: number }[] };
  candles: Candle[]; dailyCandles: Candle[]; trades: PublicTrade[]; bots: { kind: BotKind; count: number }[]; participants: number;
  account: PersonalView;
}
export interface SubmitOrder { symbol?: string; side: Side; kind: OrderKind; price?: number; quantity: number; requestId: string }

export interface AccountSummary {
  id: string; name: string; role: Account['role']; botKind: BotKind | null; botStyle: HotMoneyStyle | null;
  cash: number; availableCash: number; frozenCash: number; shares: number; sellable: number; frozenShares: number;
  marketValue: number; averageCost: number; equity: number; initialEquity: number;
  realized: number; unrealized: number; pnl: number; returnPct: number; openOrders: number;
  netFunding: number; totalDeposits: number; positions: PositionView[];
}
export type OperationType = 'submit' | 'fill' | 'cancel' | 'snapshot'
export interface AccountOperation {
  id: string; accountId: string; symbol: string; round: number; time: number; type: OperationType;
  orderId: string; side: Side; kind: OrderKind; price: number; quantity: number; remaining: number;
  status: Order['status']; fee: number | null; reason?: string;
  cashAfter: number | null; sharesAfter: number | null; realizedAfter: number | null;
}
export interface MonitorOverview {
  round: number; time: number; price: number; current: boolean;
  accounts: AccountSummary[]; rounds: { id: number; mode: Mode }[];
}
export interface MonitorDetail {
  round: number; time: number; account: AccountSummary; pending: Order[];
  operations: (AccountOperation & { cursor: number })[]; nextCursor: number | null;
  total: number; legacy: boolean;
  fundingAdjustments: FundingAdjustment[];
  stockGrants: StockGrant[];
}
