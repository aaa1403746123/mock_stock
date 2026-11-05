export const DEFAULT_BOT_COUNT = 1000
export const MIN_BOT_COUNT = 8
export const MAX_BOT_COUNT = 1000
export const MAX_ACCOUNT_EQUITY = 1_000_000_000_000
export const DEFAULT_SYMBOL = '600001.SH'
export const STOCK_CATALOG = [
  { symbol: DEFAULT_SYMBOL, name: '星海科技', sector: '科技', initialPrice: 4862 },
  { symbol: '600002.SH', name: '远航新能源', sector: '新能源', initialPrice: 2580 },
  { symbol: '600003.SH', name: '云川医药', sector: '医药', initialPrice: 8650 },
  { symbol: '600004.SH', name: '华岭消费', sector: '消费', initialPrice: 3260 },
  { symbol: '600005.SH', name: '长青银行', sector: '金融', initialPrice: 1280 },
  { symbol: '600006.SH', name: '天枢半导体', sector: '芯片', initialPrice: 10850 },
  { symbol: '600007.SH', name: '海岳制造', sector: '工业', initialPrice: 2175 },
  { symbol: '600008.SH', name: '澄明传媒', sector: '传媒', initialPrice: 1840 },
  { symbol: '600009.SH', name: '北辰资源', sector: '资源', initialPrice: 3560 },
  { symbol: '600010.SH', name: '凌云通信', sector: '通信', initialPrice: 6240 },
] as const
export const stockName = (symbol: string) => STOCK_CATALOG.find(s => s.symbol === symbol)?.name ?? symbol
