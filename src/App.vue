<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Activity, ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpRight, BarChart3, BookOpen, Check, CheckCircle2, ChevronDown, CircleHelp, Clock3, Coins, FlaskConical, History, Layers3, LoaderCircle, LockKeyhole, Maximize2, Minus, Pause, Play, Plus, RotateCcw, Settings2, ShieldCheck, Sparkles, TrendingUp, Users, Wallet, WifiOff, X, Zap } from '@lucide/vue'
import PriceChart from './components/PriceChart.vue'
import AccountMonitor from './components/AccountMonitor.vue'
import StockSelector from './components/StockSelector.vue'
import AssetAdjuster from './components/AssetAdjuster.vue'
import { DEFAULT_BOT_COUNT, MAX_BOT_COUNT, MIN_BOT_COUNT, stockName } from './shared/rules'
import { api, clock, compact, connected, connectionError, initialize, loading, login, money, newGuest, notices, notify, snapshot, selectedSymbol, selectSymbol } from './lib/market'
import type { BotKind, Candle, Mode, Order, PersonalView, Side, Snapshot, SubmitOrder } from './shared/types'

const page = ref<'trade' | 'review' | 'settings' | 'monitor'>('trade')
const tab = ref<'positions' | 'orders' | 'history'>('positions')
const interval = ref('1m')
const averages = ref(true)
const hoverCandle = ref<Candle>()
const side = ref<Side>('buy')
const kind = ref<'limit' | 'market'>('limit')
const price = ref('48.62')
const quantity = ref(100)
const busy = ref(false)
const formError = ref('')
const accountMenu = ref(false)
const modal = ref<'reset' | 'auth' | 'guide' | null>(null)
const modalError = ref('')
const authMode = ref<'register' | 'login'>('register')
const username = ref(''), password = ref('')
const newMode = ref<Mode>('free'), botCount = ref(DEFAULT_BOT_COUNT), fees = ref(false)
const expandedChart = ref(false)
const archives = ref<{ id: number; createdAt: string; mode: Mode; account: PersonalView; lastPrice: number }[]>([])
const reviewRound = ref(0)
const archiveLoading = ref(false)
const s = snapshot
const a = computed(() => s.value?.account)
const heldPositions = computed(() => a.value?.positions.filter(p => p.shares > 0) ?? [])
const selectedPosition = computed(() => a.value?.positions.find(p => p.symbol === s.value?.stock.symbol))
const switchingStock = computed(() => s.value?.stock.symbol !== selectedSymbol.value)
const isAdmin = computed(() => a.value?.role === 'admin')
const pending = computed(() => a.value?.orders.filter(o => ['open', 'partial'].includes(o.status)) ?? [])
const finished = computed(() => a.value?.orders.filter(o => !['open', 'partial'].includes(o.status)) ?? [])
const selectedCandle = computed(() => hoverCandle.value ?? s.value?.candles.at(-1))
const priceCents = computed(() => Math.round(Number(price.value) * 100))
const notional = computed(() => (kind.value === 'market' ? s.value?.stock.price ?? 0 : priceCents.value) * (Number(quantity.value) || 0))
const orderFee = computed(() => !s.value?.config.feesEnabled || notional.value <= 0 ? 0 : Math.max(500, Math.round(notional.value * .0003)) + Math.round(notional.value * .00001) + (side.value === 'sell' ? Math.round(notional.value * .0005) : 0))
const tradingAllowed = computed(() => connected.value && !switchingStock.value && s.value?.status === '交易进行中')
const depthMax = computed(() => Math.max(1, ...[...(s.value?.book.asks ?? []), ...(s.value?.book.bids ?? [])].map(l => l.quantity)))
const asks = computed(() => Array.from({ length: 5 }, (_, i) => ({ level: 5 - i, ...s.value?.book.asks[4 - i] })))
const bids = computed(() => Array.from({ length: 5 }, (_, i) => ({ level: i + 1, ...s.value?.book.bids[i] })))
const spread = computed(() => s.value?.book.asks[0] && s.value?.book.bids[0] ? money(s.value.book.asks[0].price - s.value.book.bids[0].price) : '—')
const buyDepth = computed(() => {
  const bid = s.value?.book.bids.reduce((t, l) => t + l.quantity, 0) ?? 0
  const ask = s.value?.book.asks.reduce((t, l) => t + l.quantity, 0) ?? 0
  return bid + ask ? Math.round(bid / (bid + ask) * 100) : 50
})
const reviewAccount = computed(() => reviewRound.value ? archives.value.find(r => r.id === reviewRound.value)?.account ?? a.value : a.value)
const reviewTrades = computed(() => reviewAccount.value?.trades ?? [])
const drawdown = computed(() => {
  let peak = reviewAccount.value?.initialEquity ?? 1, maximum = 0
  for (const point of reviewAccount.value?.equityHistory ?? []) { const adjusted = point.equity - (point.netFunding ?? 0); peak = Math.max(peak, adjusted); maximum = Math.max(maximum, (peak - adjusted) / peak * 100) }
  return maximum
})
const equityPoints = computed(() => {
  const points = (reviewAccount.value?.equityHistory ?? []).map(p => ({ ...p, equity: p.equity - (p.netFunding ?? 0) }))
  if (!points.length) return '0,100 900,100'
  const values = points.map(p => p.equity), min = Math.min(...values), max = Math.max(...values)
  return points.map((p, i) => `${(i / Math.max(1, points.length - 1) * 900).toFixed(1)},${(max === min ? 100 : 175 - (p.equity - min) / (max - min) * 140).toFixed(1)}`).join(' ')
})
const pnlSparkline = computed(() => {
  const values = (a.value?.equityHistory ?? []).slice(-30).map(p => p.equity - (p.netFunding ?? 0))
  if (values.length < 2) return '0,18 100,18'
  const min = Math.min(...values), max = Math.max(...values)
  return values.map((value, i) => `${i / (values.length - 1) * 100},${max === min ? 18 : 30 - (value - min) / (max - min) * 26}`).join(' ')
})
const botMeta: Record<BotKind, { name: string; description: string; color: string }> = {
  retail: { name: '随机散户', description: '小额交易，独立随机决策', color: '#a7aab8' },
  trend: { name: '趋势散户', description: '观察近期涨跌，顺势交易', color: '#b8a0ff' },
  value: { name: '价值投资者', description: '围绕自己的估值买卖', color: '#76b5db' },
  whale: { name: '资金大户', description: '大额资金，分批建仓减仓', color: '#e9b974' },
  maker: { name: '流动性提供者', description: '双边报价，管理自身库存', color: '#72c8ac' },
}
const statusText = (order: Order) => ({ open: '待成交', partial: '部分成交', filled: '全部成交', cancelled: order.cancelReason === 'self_trade' ? '自成交保护' : order.kind === 'market' && order.remaining ? '余量已撤' : '已撤单' })[order.status]
const signed = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`
const changeClass = (n: number | undefined) => n === undefined || n === 0 ? 'neutral' : n > 0 ? 'up' : 'down'
function setPrice(value?: number) { if (value) { price.value = (value / 100).toFixed(2); kind.value = 'limit'; formError.value = '' } }
function changeStock(symbol: string) { if (!busy.value) selectSymbol(symbol) }
function sellHolding(symbol: string, sellable: number, currentPrice: number) { if (busy.value) return; side.value = 'sell'; quantity.value = sellable; setPrice(currentPrice); selectSymbol(symbol) }
function fraction(ratio: number) {
  if (!a.value || !s.value) return
  const lot = s.value.config.mode === 'ashare' ? 100 : 1
  const effectivePrice = kind.value === 'market' ? Math.min(s.value.stock.upperLimit ?? Infinity, Math.round(s.value.stock.price * 1.02)) : priceCents.value
  const max = side.value === 'buy' ? Math.floor(Math.max(0, a.value.availableCash - (s.value.config.feesEnabled ? 500 : 0)) / Math.max(1, effectivePrice * (s.value.config.feesEnabled ? 1.00031 : 1))) : (selectedPosition.value?.sellable ?? 0)
  quantity.value = side.value === 'sell' && ratio === 1 ? max : Math.floor(max * ratio / lot) * lot
}
let lastRequest: { fingerprint: string; id: string } | undefined
async function placeOrder() {
  if (busy.value || !s.value || !tradingAllowed.value) return
  formError.value = ''
  if (!Number.isInteger(Number(quantity.value)) || Number(quantity.value) <= 0) { formError.value = '请输入大于 0 的整数股数'; return }
  if (kind.value === 'limit' && (!Number.isFinite(Number(price.value)) || Number(price.value) <= 0 || Math.abs(Number(price.value) * 100 - priceCents.value) > 0.000001)) { formError.value = '请输入有效价格，最多保留两位小数'; return }
  const input = { symbol: s.value.stock.symbol, side: side.value, kind: kind.value, ...(kind.value === 'limit' ? { price: priceCents.value } : {}), quantity: Number(quantity.value) }
  const fingerprint = JSON.stringify([s.value.round, a.value?.id, input])
  if (lastRequest?.fingerprint !== fingerprint) lastRequest = { fingerprint, id: crypto.randomUUID() }
  busy.value = true
  try {
    const result = await api<{ order: Order; snapshot: Snapshot }>('/orders', 'POST', { ...input, requestId: lastRequest.id } satisfies SubmitOrder)
    s.value = result.snapshot; lastRequest = undefined
    const order = result.order
    notify(order.cancelReason === 'self_trade' ? `触发自成交保护，已撤销${order.filled ? `剩余委托（此前已成交 ${order.filled} 股）` : '本次委托'}，请先撤销自己的反向挂单` : order.filled ? `已成交 ${order.filled.toLocaleString()} 股，均价 ¥${money(order.averagePrice)}${order.remaining ? order.status === 'cancelled' ? '，剩余数量已撤销' : '，剩余数量继续挂单' : ''}` : order.status === 'cancelled' ? '价格保护范围内没有对手盘，市价委托已撤销' : '委托已提交，等待撮合成交')
    tab.value = order.status === 'open' || order.status === 'partial' ? 'orders' : 'history'
  } catch (error) { formError.value = error instanceof Error ? error.message : '下单失败'; if ((error as { status?: number }).status) lastRequest = undefined }
  finally { busy.value = false }
}
async function cancel(order: Order) {
  try { const result = await api<{ snapshot: Snapshot }>(`/orders/${order.id}`, 'DELETE'); s.value = result.snapshot; notify('委托已撤销，冻结资产已释放') }
  catch (error) { notify((error as Error).message, true) }
}
async function control(body: unknown) { try { s.value = await api('/market', 'PATCH', body) } catch (error) { notify((error as Error).message, true) } }
async function nextDay() { try { s.value = await api('/market/next-day', 'POST'); notify('已进入下一个模拟交易日') } catch (error) { notify((error as Error).message, true) } }
function openReset(mode = s.value?.config.mode ?? 'free') {
  if (!isAdmin.value) { notify('只有市场管理员可以切换规则与重开市场', true); return }
  newMode.value = mode; fees.value = mode === 'ashare'; botCount.value = s.value?.config.botCount ?? DEFAULT_BOT_COUNT; modalError.value = ''; modal.value = 'reset'
}
async function resetMarket() {
  busy.value = true; modalError.value = ''
  try { const result = await api<Snapshot>('/market/reset', 'POST', { mode: newMode.value, botCount: Number(botCount.value), feesEnabled: fees.value }); s.value = result; modal.value = null; formError.value = ''; price.value = (result.stock.price / 100).toFixed(2); notify('新一轮练习已就绪，所有账户已获得初始资金'); if (page.value === 'review') await loadArchives() }
  catch (error) { modalError.value = (error as Error).message }
  finally { busy.value = false }
}
function openAuth() { accountMenu.value = false; authMode.value = a.value?.registered ? 'login' : 'register'; username.value = ''; password.value = ''; modalError.value = ''; modal.value = 'auth' }
async function authenticate() {
  busy.value = true; modalError.value = ''
  try { await login(username.value, password.value, authMode.value === 'register'); modal.value = null; notify(authMode.value === 'register' ? '账户已保存，可用用户名和密码登录' : '已切换到账户'); if (page.value === 'review') await loadArchives() }
  catch (error) { modalError.value = (error as Error).message }
  finally { busy.value = false }
}
async function createGuest() {
  if (!a.value?.registered) { notify('请先保存当前访客账户，再创建独立账户，避免丢失当前账户的访问凭证', true); openAuth(); return }
  try { await newGuest(); modal.value = null; accountMenu.value = false; notify('已进入新的独立账户，共享市场行情'); if (page.value === 'review') await loadArchives() }
  catch (error) { notify((error as Error).message, true) }
}
async function loadArchives() {
  archiveLoading.value = true; reviewRound.value = 0
  try { archives.value = await api('/rounds') } catch (error) { notify((error as Error).message, true) }
  finally { archiveLoading.value = false }
}
function exportTrades() {
  const trades = reviewTrades.value
  if (!trades.length) { notify('当前练习还没有成交记录'); return }
  const rows = [['成交编号', '模拟时间', '股票', '方向', '成交价(元)', '数量(股)', '成交额(元)'], ...trades.map(t => [t.id, `${new Date(t.time + 8 * 3600_000).toISOString().slice(0, 10)} ${clock(t.time)}`, t.symbol, t.side === 'buy' ? '买入' : '卖出', (t.price / 100).toFixed(2), String(t.quantity), (t.price * t.quantity / 100).toFixed(2)])]
  const blob = new Blob(['\ufeff' + rows.map(r => r.map(v => `"${v.replaceAll('"', '""')}"`).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = `MarketLab-第${reviewRound.value || s.value?.round}轮-成交记录.csv`; link.click(); URL.revokeObjectURL(url)
}
watch(page, value => { accountMenu.value = false; if (value === 'review') loadArchives() })
watch(side, () => { formError.value = '' })
watch(() => s.value?.stock.symbol, () => { if (!s.value) return; price.value = (s.value.stock.price / 100).toFixed(2); hoverCandle.value = undefined; formError.value = ''; lastRequest = undefined })
watch(() => a.value?.id, () => { formError.value = ''; tab.value = 'positions'; lastRequest = undefined })
watch(isAdmin, admin => { if (!admin && page.value === 'monitor') page.value = 'trade' })
onMounted(async () => { await initialize(); if (s.value) price.value = (s.value.stock.price / 100).toFixed(2) })
</script>

<template>
  <div v-if="!s" class="boot-screen">
    <div class="brand-mark"><BarChart3 :size="25"/></div><h1>MarketLab<span>模拟交易实验室</span></h1>
    <template v-if="loading"><LoaderCircle class="spin" :size="22"/><p>正在连接你的模拟市场…</p></template>
    <template v-else><p class="up">{{ connectionError || '暂时无法连接市场' }}</p><button class="primary" @click="initialize">重新连接</button></template>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar">
      <button class="brand-mark" title="MarketLab 交易大厅" aria-label="返回交易大厅" @click="page = 'trade'"><BarChart3 :size="25"/></button>
      <div class="nav-stack">
        <button :class="['nav-button', { active: page === 'trade' }]" @click="page = 'trade'"><BarChart3 :size="21"/><span>交易</span></button>
        <button :class="['nav-button', { active: page === 'review' }]" @click="page = 'review'"><History :size="21"/><span>复盘</span></button>
        <button :class="['nav-button', { active: page === 'settings' }]" @click="page = 'settings'"><Settings2 :size="21"/><span>市场</span></button>
        <button v-if="isAdmin" :class="['nav-button', { active: page === 'monitor' }]" @click="page = 'monitor'"><Users :size="21"/><span>监控</span></button>
      </div>
      <div class="sidebar-bottom"><span class="sidebar-divider"></span><button class="nav-button" @click="modal = 'guide'"><CircleHelp :size="20"/><span>指南</span></button><div class="sidebar-avatar" :title="a?.name">{{ a?.name.slice(0, 1) }}</div></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <a class="wordmark" href="#" @click.prevent="page = 'trade'">Market<span>Lab</span><span class="wordmark-divider"></span><span class="wordmark-sub">模拟交易实验室</span></a>
        <div class="topbar-actions"><span class="sandbox-label"><FlaskConical :size="13"/>虚拟资金 · 真实博弈</span><span class="topbar-divider"></span><div class="account-dropdown">
          <button class="account-button" @click="accountMenu = !accountMenu"><span class="small-avatar">{{ a?.name.slice(0, 1) }}</span><span>{{ a?.name }}</span><ChevronDown :size="13"/></button>
          <div v-if="accountMenu" class="dropdown"><div class="dropdown-caption">{{ isAdmin ? '市场管理员' : '独立交易账户' }}<span>第 {{ s.round }} 轮练习</span></div><button @click="openAuth"><LockKeyhole :size="15"/>{{ a?.registered ? '登录其他账户' : '保存账户 / 登录' }}</button><button @click="createGuest"><Plus :size="15"/>创建独立练习账户</button></div>
        </div></div>
      </header>
      <main>
        <div v-if="!connected" class="connection-banner"><WifiOff :size="15"/>{{ connectionError || '市场连接暂时中断，正在重连。连接恢复前无法提交委托。' }}<button @click="initialize">重新连接</button></div>
        <section class="page-heading">
          <div><div class="eyebrow">YOUR PERSONAL MARKET SANDBOX</div><h1>{{ page === 'trade' ? '交易大厅' : page === 'review' ? '交易复盘' : page === 'monitor' ? '账户监控' : '市场控制台' }}<span class="round-tag">ROUND {{ String(s.round).padStart(2, '0') }}</span></h1><p>{{ page === 'trade' ? '观察市场，验证你的交易直觉。' : page === 'review' ? '让每一次交易，都成为下一次判断的依据。' : page === 'monitor' ? '观察每个参与者的交易行为、资金流向与收益。' : '设定交易规则，让市场按照你的节奏运行。' }}</p></div>
          <div class="market-mode"><div class="mode-caption"><span class="live-dot" :class="{ paused: s.config.paused || !connected }"></span>{{ s.status }}<span class="mode-help" title="规则适用于市场内的所有账户">全市场统一规则</span></div><div class="mode-switch"><button :class="{ selected: s.config.mode === 'free' }" :disabled="!isAdmin" @click="s.config.mode !== 'free' && openReset('free')"><Zap :size="14"/>自由练习<span>T+0</span></button><button :class="{ selected: s.config.mode === 'ashare' }" :disabled="!isAdmin" @click="s.config.mode !== 'ashare' && openReset('ashare')"><ShieldCheck :size="14"/>A 股规则<span>T+1</span></button></div></div>
        </section>

        <template v-if="page === 'trade'">
          <section class="stat-grid">
            <article class="stat-card"><div class="stat-label"><span>账户总资产</span><AssetAdjuster v-if="isAdmin" :key="a!.id" :account="a!" :round="s.round"/><Wallet v-else :size="16"/></div><div class="stat-value"><small>¥</small>{{ money(a!.equity) }}</div><div class="stat-note"><span class="subtle-dot"></span>初始资金 ¥{{ money(a!.initialEquity, 0) }}</div></article>
            <article class="stat-card"><div class="stat-label"><span>可用资金</span><Coins :size="16"/></div><div class="stat-value"><small>¥</small>{{ money(a!.availableCash) }}</div><div class="stat-note">冻结资金 <span>¥{{ money(a!.frozenCash) }}</span></div></article>
            <article class="stat-card"><div class="stat-label"><span>持仓市值</span><Layers3 :size="16"/></div><div class="stat-value"><small>¥</small>{{ money(a!.marketValue) }}</div><div class="stat-note">{{ heldPositions.length }} 只股票<span>共 {{ a!.shares.toLocaleString() }} 股</span></div></article>
            <article class="stat-card pnl-card"><div class="stat-label"><span>本轮累计盈亏</span><TrendingUp :size="16"/></div><div :class="['stat-value', changeClass(a!.pnl)]"><small>{{ a!.pnl >= 0 ? '+' : '−' }} ¥</small>{{ money(Math.abs(a!.pnl)) }}</div><div class="stat-note"><span :class="['return-badge', changeClass(a!.pnl)]">{{ a!.returnPct >= 0 ? '+' : '' }}{{ a!.returnPct.toFixed(2) }}%</span>剔除资金调整</div><svg class="stat-sparkline" viewBox="0 0 100 34" aria-hidden="true"><polyline :points="pnlSparkline" fill="none" stroke="#b9a2f7" stroke-width="1.7"/></svg></article>
          </section>

          <StockSelector :stocks="s.stocks" :selected="selectedSymbol" :disabled="busy || !connected" @select="changeStock"/>
          <div v-if="switchingStock" class="info-note"><LoaderCircle class="spin" :size="15"/>正在切换股票行情，下单暂时锁定。</div>
          <div class="trading-grid">
            <div class="left-column">
              <section :class="['panel', 'chart-panel', { 'expanded-chart': expandedChart }]">
                <div class="stock-header"><div class="stock-identity"><div class="stock-icon"><Sparkles :size="22"/></div><div><h2>{{ s.stock.name }}<span class="tag">模拟标的</span></h2><span class="stock-symbol">{{ s.stock.symbol }}<span>沪市主板</span></span></div></div><div class="stock-quote"><strong :class="changeClass(s.stock.change)">{{ money(s.stock.price) }}</strong><span :class="changeClass(s.stock.change)">{{ signed(s.stock.change) }} <span>{{ s.stock.changePct >= 0 ? '+' : '' }}{{ s.stock.changePct.toFixed(2) }}%</span></span></div><button class="icon-button expand-button" :aria-label="expandedChart ? '收起图表' : '展开图表'" @click="expandedChart = !expandedChart"><X v-if="expandedChart" :size="16"/><Maximize2 v-else :size="16"/></button></div>
                <div class="quote-facts"><span>今开 <b>{{ money(s.stock.open) }}</b></span><span>最高 <b class="up">{{ money(s.stock.high) }}</b></span><span>最低 <b class="down">{{ money(s.stock.low) }}</b></span><span>成交量 <b>{{ compact(s.stock.volume) }} 股</b></span><span>成交额 <b>{{ compact(s.stock.turnover / 100) }}</b></span></div>
                <div class="chart-toolbar"><div class="chart-periods"><button v-for="item in [{ id: 'line', label: '分时' }, { id: '1m', label: '1 分' }, { id: '5m', label: '5 分' }, { id: '15m', label: '15 分' }]" :key="item.id" :class="{ active: interval === item.id }" @click="interval = item.id">{{ item.label }}</button></div><div class="chart-tools"><button :class="{ enabled: averages }" :aria-pressed="averages" @click="averages = !averages"><Activity :size="13"/>均线</button><span>价格 / 元</span></div></div>
                <div class="candle-readout"><template v-if="selectedCandle"><span>开 <b>{{ money(selectedCandle.open) }}</b></span><span>高 <b>{{ money(selectedCandle.high) }}</b></span><span>低 <b>{{ money(selectedCandle.low) }}</b></span><span>收 <b :class="changeClass(selectedCandle.close - selectedCandle.open)">{{ money(selectedCandle.close) }}</b></span></template><span v-if="averages && interval !== 'line'" class="ma-legend"><i>MA5</i><i>MA10</i><i>MA20</i></span></div>
                <PriceChart :key="s.stock.symbol" :candles="s.candles" :interval="interval" :averages="averages" :round="s.round" @hover="hoverCandle = $event"/>
                <div class="chart-footer"><span><span class="live-dot"></span>由实际撮合成交生成</span><span class="chart-credit">图表由 <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView Lightweight Charts™</a> 提供</span></div>
              </section>

              <section class="panel account-panel"><div class="section-tabs"><div><button :class="{ active: tab === 'positions' }" @click="tab = 'positions'">我的持仓<span v-if="heldPositions.length">{{ heldPositions.length }}</span></button><button :class="{ active: tab === 'orders' }" @click="tab = 'orders'">当前委托<span>{{ pending.length }}</span></button><button :class="{ active: tab === 'history' }" @click="tab = 'history'">历史委托</button></div><button class="text-button" @click="page = 'review'">交易复盘<ArrowUpRight :size="13"/></button></div>
                <div v-if="tab === 'positions'" class="table-wrap"><table><thead><tr><th>股票</th><th>持仓 / 可卖</th><th>平均成本</th><th>最新价</th><th>浮动盈亏</th><th></th></tr></thead><tbody><tr v-for="position in heldPositions" :key="position.symbol"><td><button class="text-button" @click="changeStock(position.symbol)"><strong>{{ position.name }}</strong></button><small>{{ position.symbol }}</small></td><td>{{ position.shares.toLocaleString() }}<small>{{ position.sellable.toLocaleString() }} 股可卖</small></td><td>{{ money(position.averageCost) }}</td><td>{{ money(position.price) }}</td><td :class="changeClass(position.unrealized)">{{ signed(position.unrealized) }}</td><td><button class="small-button" :disabled="busy || !position.sellable" @click="sellHolding(position.symbol, position.sellable, position.price)">卖出</button></td></tr></tbody></table><div v-if="!heldPositions.length" class="empty-state"><div class="empty-icon"><Layers3 :size="24"/></div><strong>第一笔交易，从这里开始</strong><p>选择股票后提交买入委托，这里会汇总全部股票持仓。</p></div></div>
                <div v-else class="table-wrap"><table><thead><tr><th>委托时间</th><th>股票</th><th>方向 / 类型</th><th>委托价</th><th>成交 / 委托</th><th>状态</th><th></th></tr></thead><tbody><tr v-for="order in (tab === 'orders' ? pending : finished).slice(0, 8)" :key="order.id"><td>{{ clock(order.createdAt) }}<small>{{ new Date(order.createdAt + 8 * 3600_000).toISOString().slice(5, 10) }}</small></td><td>{{ stockName(order.symbol) }}<small>{{ order.symbol }}</small></td><td><span :class="order.side === 'buy' ? 'up' : 'down'">{{ order.side === 'buy' ? '买入' : '卖出' }}</span><small>{{ order.kind === 'limit' ? '限价' : '市价保护' }}</small></td><td>{{ order.kind === 'market' ? '市价' : money(order.price) }}</td><td>{{ order.filled.toLocaleString() }} / {{ order.quantity.toLocaleString() }}</td><td><span :class="['order-status', order.status]">{{ statusText(order) }}</span></td><td><button v-if="['open', 'partial'].includes(order.status)" class="small-button" @click="cancel(order)">撤单</button></td></tr></tbody></table><div v-if="!(tab === 'orders' ? pending : finished).length" class="empty-state compact-empty"><div class="empty-icon"><BookOpen :size="22"/></div><strong>{{ tab === 'orders' ? '暂无待成交委托' : '暂无历史委托' }}</strong><p>{{ tab === 'orders' ? '提交限价委托后，可以在这里查看进度或撤单。' : '完成或撤销的委托会保留在这里。' }}</p></div></div>
              </section>

              <section class="market-strip"><div class="strip-icon"><Users :size="18"/></div><div><strong>{{ s.config.botCount }} 个独立机器人正在参与市场</strong><span>独立资产 · 独立策略 · 共享公共行情</span></div><div class="agent-dots"><i v-for="bot in s.bots" :key="bot.kind" :style="{ background: botMeta[bot.kind].color }" :title="`${botMeta[bot.kind].name}：${bot.count} 个`"></i></div><button class="text-button" @click="page = 'settings'">查看市场<ArrowRight :size="14"/></button></section>
            </div>

            <div class="right-column">
              <section class="panel order-panel"><div class="panel-heading"><h2>交易委托</h2><span class="muted tiny">{{ s.config.mode === 'free' ? 'T+0 · 当日可卖' : 'T+1 · 次日可卖' }}</span></div><div class="side-switch"><button :class="{ selected: side === 'buy' }" @click="side = 'buy'"><ArrowDownLeft :size="16"/>买入</button><button :class="{ selected: side === 'sell' }" @click="side = 'sell'"><ArrowUpRight :size="16"/>卖出</button></div>
                <form @submit.prevent="placeOrder"><div class="order-kind"><button type="button" :class="{ active: kind === 'limit' }" @click="kind = 'limit'">限价委托</button><button type="button" :class="{ active: kind === 'market' }" @click="kind = 'market'">市价委托</button><span :title="kind === 'limit' ? '以指定价格或更优价格成交，剩余部分继续挂单' : '按当前盘口成交，价格保护范围为最新成交价上下 2%，剩余部分自动撤销'"><CircleHelp :size="13"/></span></div>
                  <label class="field-label" for="order-price">{{ kind === 'limit' ? '委托价格' : '参考价格' }}<span>CNY</span></label><div :class="['number-field', { disabled: kind === 'market' }]"><button type="button" aria-label="价格减一分" :disabled="kind === 'market'" @click="price = (Math.max(1, priceCents - 1) / 100).toFixed(2)"><Minus :size="14"/></button><input id="order-price" v-model="price" v-if="kind === 'limit'" type="number" min="0.01" step="0.01" required/><input v-else id="order-price" :value="money(s.stock.price)" disabled/><button type="button" aria-label="价格加一分" :disabled="kind === 'market'" @click="price = ((priceCents + 1) / 100).toFixed(2)"><Plus :size="14"/></button></div>
                  <div class="field-hint"><template v-if="kind === 'market'">±2% 价格保护，未成交数量自动撤销</template><template v-else><span>最新价 {{ money(s.stock.price) }}</span><button type="button" @click="setPrice(s.stock.price)">使用最新价</button></template></div>
                  <label class="field-label" for="order-quantity">委托数量<span>股</span></label><div class="number-field"><button type="button" aria-label="数量减一百股" @click="quantity = Math.max(s.config.mode === 'ashare' ? 100 : 1, Number(quantity) - 100)"><Minus :size="14"/></button><input id="order-quantity" v-model.number="quantity" type="number" min="1" max="1000000" step="1" required/><button type="button" aria-label="数量加一百股" @click="quantity = Number(quantity) + 100"><Plus :size="14"/></button></div>
                  <div class="fraction-buttons"><button v-for="ratio in [.25, .5, .75, 1]" :key="ratio" type="button" @click="fraction(ratio)">{{ ratio === 1 ? '全部' : `${ratio * 100}%` }}</button></div>
                  <div class="order-summary"><div><span>{{ side === 'buy' ? '可用资金' : '可卖数量' }}</span><b>{{ side === 'buy' ? `¥ ${money(a!.availableCash)}` : `${(selectedPosition?.sellable ?? 0).toLocaleString()} 股` }}</b></div><div><span>预计成交金额</span><strong>¥ {{ Number.isFinite(notional) ? money(notional) : '0.00' }}</strong></div><div v-if="s.config.feesEnabled"><span>预计费用</span><b>¥ {{ money(orderFee) }}</b></div></div>
                  <p v-if="formError" class="form-error" role="alert">{{ formError }}</p><button :class="['submit-order', side]" :disabled="busy || !tradingAllowed"><LoaderCircle v-if="busy" :size="16" class="spin"/><template v-else>{{ side === 'buy' ? '买入' : '卖出' }} {{ s.stock.name }}<ArrowRight :size="16"/></template></button><p class="order-footnote"><ShieldCheck :size="12"/>{{ !tradingAllowed ? s.status === '交易进行中' ? '连接恢复后可提交委托' : s.status : '仅使用虚拟资产，成交由市场撮合' }}</p>
                </form>
              </section>

              <section class="panel book-panel"><div class="panel-heading"><h2>五档盘口</h2><span class="live-label"><span class="live-dot"></span>实时</span></div><div class="book-head"><span>档位</span><span>价格 / 元</span><span>数量 / 股</span></div><button v-for="level in asks" :key="`ask${level.level}`" class="book-row ask" :disabled="!level.price" @click="setPrice(level.price)"><i :style="{ width: `${(level.quantity ?? 0) / depthMax * 100}%` }"></i><span>卖 {{ level.level }}</span><b>{{ level.price ? money(level.price) : '—' }}</b><span>{{ level.quantity?.toLocaleString() ?? '—' }}</span></button><div class="book-spread"><b :class="changeClass(s.stock.change)">{{ money(s.stock.price) }}<ArrowUpRight v-if="s.stock.change >= 0" :size="15"/><ArrowDownLeft v-else :size="15"/></b><span>价差 {{ spread }}</span></div><button v-for="level in bids" :key="`bid${level.level}`" class="book-row bid" :disabled="!level.price" @click="setPrice(level.price)"><i :style="{ width: `${(level.quantity ?? 0) / depthMax * 100}%` }"></i><span>买 {{ level.level }}</span><b>{{ level.price ? money(level.price) : '—' }}</b><span>{{ level.quantity?.toLocaleString() ?? '—' }}</span></button><div class="depth-meter"><div><span class="up">买 {{ buyDepth }}%</span><span class="down">卖 {{ 100 - buyDepth }}%</span></div><div class="depth-bar"><i :style="{ width: `${buyDepth}%` }"></i></div></div></section>
            </div>
          </div>
          <section class="panel tape-panel"><div class="panel-heading"><h2>市场最新成交<span class="muted">匿名公开行情</span></h2><span class="muted tiny">成交量按单边股数计算</span></div><div class="trade-tape"><div v-for="trade in s.trades.slice(0, 8)" :key="trade.id" class="tape-item"><span class="tape-time">{{ clock(trade.time) }}</span><b :class="trade.side === 'buy' ? 'up' : 'down'">{{ money(trade.price) }}<ArrowUpRight v-if="trade.side === 'buy'" :size="12"/><ArrowDownLeft v-else :size="12"/></b><span>{{ trade.quantity.toLocaleString() }} 股</span></div><p v-if="!s.trades.length" class="muted">等待第一笔市场成交</p></div></section>
        </template>

        <AccountMonitor v-if="page === 'monitor' && isAdmin" :key="a!.id" :account-id="a!.id" :round="s.round"/>

        <template v-if="page === 'review'">
          <div class="review-toolbar"><div class="select-wrap"><History :size="16"/><select v-model.number="reviewRound" aria-label="选择复盘轮次"><option :value="0">当前练习 · 第 {{ s.round }} 轮</option><option v-for="round in archives" :key="round.id" :value="round.id">第 {{ round.id }} 轮 · {{ round.mode === 'free' ? '自由练习' : 'A 股规则' }}</option></select></div><button class="secondary" :disabled="archiveLoading" @click="exportTrades"><ArrowDownToLine :size="15"/>导出成交记录</button></div>
          <div class="stat-grid"><article class="stat-card"><div class="stat-label">累计收益</div><div :class="['stat-value', changeClass(reviewAccount?.pnl)]">{{ signed(reviewAccount?.pnl ?? 0) }}</div><div class="stat-note">元 · 包含已实现及浮动盈亏</div></article><article class="stat-card"><div class="stat-label">收益率</div><div :class="['stat-value', changeClass(reviewAccount?.returnPct)]">{{ (reviewAccount?.returnPct ?? 0).toFixed(2) }}<small>%</small></div><div class="stat-note">相对初始资产及累计注资</div></article><article class="stat-card"><div class="stat-label">最大回撤</div><div class="stat-value">{{ drawdown.toFixed(2) }}<small>%</small></div><div class="stat-note">基于剔除资金调整后的分钟快照</div></article><article class="stat-card"><div class="stat-label">成交笔数</div><div class="stat-value">{{ reviewTrades.length }}<small>笔</small></div><div class="stat-note">最近 200 笔成交明细</div></article></div>
          <section class="panel equity-panel"><div class="panel-heading"><h2>交易净值曲线</h2><span class="tag">按模拟时间记录</span></div><div class="equity-chart"><div class="equity-baseline"><span>¥ {{ money(reviewAccount?.initialEquity ?? 10000000, 0) }} 初始资产</span></div><svg viewBox="0 0 900 210" preserveAspectRatio="none" role="img" aria-label="当前所选练习的账户资产变化曲线"><defs><linearGradient id="equity-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#b8a0ff" stop-opacity=".25"/><stop offset="100%" stop-color="#b8a0ff" stop-opacity="0"/></linearGradient></defs><polygon :points="`0,210 ${equityPoints} 900,210`" fill="url(#equity-fill)"/><polyline :points="equityPoints" fill="none" stroke="#b8a0ff" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></div><div class="equity-caption"><span>练习开始</span><span>剔除净资金调整 · ¥{{ money((reviewAccount?.equity ?? 0) - (reviewAccount?.netFunding ?? 0)) }}</span><span>最近记录</span></div></section>
          <section class="panel review-table"><div class="panel-heading"><h2>我的成交记录</h2><span class="muted tiny">仅展示当前账户的交易</span></div><div class="table-wrap"><table><thead><tr><th>成交时间</th><th>标的</th><th>方向</th><th>成交价格</th><th>成交数量</th><th>成交金额</th></tr></thead><tbody><tr v-for="trade in reviewTrades" :key="trade.id"><td>{{ new Date(trade.time + 8 * 3600_000).toISOString().slice(5, 10) }} {{ clock(trade.time) }}</td><td>{{ stockName(trade.symbol) }} <span class="muted">{{ trade.symbol }}</span></td><td :class="trade.side === 'buy' ? 'up' : 'down'">{{ trade.side === 'buy' ? '买入' : '卖出' }}</td><td>¥ {{ money(trade.price) }}</td><td>{{ trade.quantity.toLocaleString() }} 股</td><td>¥ {{ money(trade.price * trade.quantity) }}</td></tr></tbody></table><div v-if="!reviewTrades.length" class="empty-state"><div class="empty-icon"><History :size="25"/></div><strong>你的交易故事，还未开始</strong><p>完成第一笔成交后，在这里回看买卖时机与资产变化。</p><button class="secondary" @click="page = 'trade'">前往交易<ArrowRight :size="14"/></button></div></div></section>
        </template>

        <template v-if="page === 'settings'">
          <div v-if="!isAdmin" class="info-note"><LockKeyhole :size="17"/>你正在使用独立交易账户。以下为公共市场配置，由管理员统一调整。</div>
          <section class="panel settings-panel"><div class="panel-heading"><h2>交易规则</h2><span class="tag">当前：{{ s.config.mode === 'free' ? '自由练习' : 'A 股规则' }}</span></div><div class="rule-cards"><button :class="['rule-card', { chosen: s.config.mode === 'free' }]" :disabled="!isAdmin" @click="s.config.mode !== 'free' && openReset('free')"><Zap :size="23"/><div><h3>自由练习<span>T+0</span></h3><p>随时买卖，把想法放进市场验证。</p><ul><li><Check :size="13"/>当日买入，当日可卖</li><li><Check :size="13"/>全天交易，无涨跌幅限制</li><li><Check :size="13"/>1 股起买，默认免手续费</li></ul></div><CheckCircle2 v-if="s.config.mode === 'free'" class="chosen-icon" :size="19"/></button><button :class="['rule-card', { chosen: s.config.mode === 'ashare' }]" :disabled="!isAdmin" @click="s.config.mode !== 'ashare' && openReset('ashare')"><ShieldCheck :size="23"/><div><h3>A 股规则<span>T+1</span></h3><p>在普通主板股票规则下练习。</p><ul><li><Check :size="13"/>当日买入，下个模拟交易日可卖</li><li><Check :size="13"/>买入 100 股起，涨跌幅 ±10%</li><li><Check :size="13"/>工作日 09:30–11:30 / 13:00–15:00</li></ul></div><CheckCircle2 v-if="s.config.mode === 'ashare'" class="chosen-icon" :size="19"/></button></div><p class="settings-note"><CircleHelp :size="14"/>首版模拟普通主板连续竞价；不含集合竞价、法定节假日、ST 及新股特殊规则。切换模式会创建新一轮练习并归档当前记录。</p></section>
          <div class="settings-grid"><section class="panel settings-panel"><div class="panel-heading"><h2>模拟时间</h2><Clock3 :size="17" class="muted"/></div><div class="big-clock">{{ clock(s.time) }}<span>{{ s.day }} · 北京时间</span></div><div class="settings-speeds"><button v-for="speed in [1, 5, 20, 60]" :key="speed" :class="{ selected: s.config.speed === speed }" :disabled="!isAdmin" @click="control({ speed })">{{ speed }}×</button></div><div class="settings-buttons"><button class="secondary" :disabled="!isAdmin" @click="control({ paused: !s.config.paused })"><Play v-if="s.config.paused" :size="15"/><Pause v-else :size="15"/>{{ s.config.paused ? '继续运行' : '暂停市场' }}</button><button class="secondary" :disabled="!isAdmin" @click="nextDay"><ArrowRight :size="15"/>下一交易日</button></div><p class="settings-note">时间加速同时影响行情与机器人节奏。每次最多调度 200 个到期机器人，高倍率下轮流执行；无人在线时时钟停止。</p></section><section class="panel settings-panel"><div class="panel-heading"><h2>资产与费用</h2><Wallet :size="17" class="muted"/></div><div class="settings-facts"><div><span>每个账户初始资金</span><b>¥ {{ money(s.config.initialCash, 0) }}</b></div><div><span>交易费用模板</span><b>{{ s.config.feesEnabled ? '已启用' : '免手续费' }}</b></div><div><span>撮合规则</span><b>价格优先 · 时间优先</b></div><div><span>市价保护范围</span><b>最新成交价 ±2%</b></div></div><p class="settings-note">启用费用时：佣金 0.03%（每单最低 ¥5），过户费 0.001%，卖出印花税 0.05%。按委托累计成交额计算；此为练习费用模板。</p></section></div>
          <section class="panel settings-panel"><div class="panel-heading"><h2>机器人生态<span class="muted">{{ s.config.botCount }} 个独立参与者</span></h2><span class="privacy-badge"><LockKeyhole :size="12"/>私有信息互不可见</span></div><div class="bot-grid"><div v-for="bot in s.bots" :key="bot.kind" class="bot-card"><div class="bot-card-heading"><span :style="{ color: botMeta[bot.kind].color, background: `${botMeta[bot.kind].color}15` }"><Users :size="18"/></span><b>{{ bot.count }}<small>个</small></b></div><h3>{{ botMeta[bot.kind].name }}</h3><p>{{ botMeta[bot.kind].description }}</p></div></div></section>
          <section class="reset-section"><div><h3>新的市场，新的开始</h3><p>当前练习会被归档，所有真人账户将重置为初始资金。可在新一轮调整机器人数量及交易费用。</p></div><button class="secondary" :disabled="!isAdmin" @click="openReset()"><RotateCcw :size="15"/>新建一轮练习</button></section>
        </template>
      </main>
      <footer class="statusbar"><div><span :class="['live-dot', { paused: !connected }]"></span>{{ connected ? '市场已连接' : '连接已断开' }}<span class="footer-divider"></span><Users :size="12"/>{{ s.participants }} 位参与者<span class="footer-divider"></span><span class="footer-mode">{{ s.config.mode === 'free' ? '自由练习模式' : 'A 股规则模式' }}</span></div><div><Clock3 :size="12"/><span>{{ s.day }} {{ clock(s.time) }}</span><span class="sim-label">模拟时间</span><span class="footer-divider"></span><select :value="s.config.speed" aria-label="模拟时间倍率" :disabled="!isAdmin" @change="control({ speed: Number(($event.target as HTMLSelectElement).value) })"><option v-for="speed in [1, 5, 20, 60]" :key="speed" :value="speed">{{ speed }}× 速度</option></select><button class="icon-button" :disabled="!isAdmin" :aria-label="s.config.paused ? '继续市场' : '暂停市场'" @click="control({ paused: !s.config.paused })"><Play v-if="s.config.paused" :size="13"/><Pause v-else :size="13"/></button></div></footer>
    </div>
  </div>

  <div v-if="modal" class="modal-backdrop" @click.self="!busy && (modal = null)" @keydown.esc="!busy && (modal = null)"><section class="modal" role="dialog" aria-modal="true" :aria-label="modal === 'reset' ? '新建练习' : modal === 'auth' ? '账户管理' : '练习指南'"><button class="icon-button modal-close" aria-label="关闭弹窗" :disabled="busy" @click="modal = null"><X :size="20"/></button>
    <template v-if="modal === 'reset'"><div class="modal-icon"><FlaskConical :size="25"/></div><h2>开始新一轮练习</h2><p class="modal-intro">当前所有账户的交易与资产将归档，在复盘页可以再次查看。新一轮每人获得 ¥100,000 虚拟资金。</p><div class="modal-mode-switch"><button :class="{ selected: newMode === 'free' }" @click="newMode = 'free'; fees = false"><Zap :size="16"/>自由练习</button><button :class="{ selected: newMode === 'ashare' }" @click="newMode = 'ashare'; fees = true"><ShieldCheck :size="16"/>A 股规则</button></div><label class="field-label" for="bot-count">机器人数量<strong>{{ botCount }} 个</strong></label><input id="bot-count" class="range-input" v-model.number="botCount" type="range" :min="MIN_BOT_COUNT" :max="MAX_BOT_COUNT" step="1"/><div class="range-labels"><span>8 个 · 安静市场</span><span>1000 个 · 活跃市场</span></div><label class="checkbox-row"><input v-model="fees" type="checkbox"/><span>启用交易费用模板<small>佣金、过户费及卖出印花税</small></span></label><div class="info-note"><History :size="16"/>当前委托将结束，历史练习可在「复盘」中查看。</div><p v-if="modalError" class="form-error" role="alert">{{ modalError }}</p><button class="primary modal-primary" :disabled="busy" @click="resetMarket"><LoaderCircle v-if="busy" :size="16" class="spin"/>{{ busy ? '正在初始化市场…' : '归档当前练习并开始' }}<ArrowRight :size="15"/></button></template>
    <template v-else-if="modal === 'auth'"><div class="modal-icon"><LockKeyhole :size="25"/></div><h2>{{ authMode === 'register' ? '保存你的练习账户' : '登录交易账户' }}</h2><p class="modal-intro">{{ authMode === 'register' ? '设置用户名和密码，保留当前资产与交易记录，之后可在其他浏览器登录。' : '每个账户拥有独立资产和交易记录，共享同一个市场。' }}</p><div class="modal-mode-switch"><button :class="{ selected: authMode === 'register' }" :disabled="a?.registered" @click="authMode = 'register'; modalError = ''">保存当前账户</button><button :class="{ selected: authMode === 'login' }" @click="authMode = 'login'; modalError = ''">登录已有账户</button></div><form @submit.prevent="authenticate"><label class="field-label" for="username">用户名</label><input id="username" class="text-input" v-model="username" placeholder="2–20 个字符" autocomplete="username" required minlength="2" maxlength="20"/><label class="field-label" for="password">密码</label><input id="password" class="text-input" v-model="password" type="password" placeholder="至少 8 个字符" :autocomplete="authMode === 'register' ? 'new-password' : 'current-password'" required minlength="8" maxlength="128"/><p v-if="modalError" class="form-error" role="alert">{{ modalError }}</p><button class="primary modal-primary" :disabled="busy"><LoaderCircle v-if="busy" :size="16" class="spin"/>{{ authMode === 'register' ? '保存账户' : '登录账户' }}<ArrowRight :size="15"/></button></form></template>
    <template v-else><div class="modal-icon"><BookOpen :size="25"/></div><h2>欢迎来到你的市场实验室</h2><p class="modal-intro">这里的每一根 K 线，都来自参与者之间的真实模拟成交。</p><div class="guide-step"><span>01</span><div><h3>观察市场</h3><p>查看价格走势与五档盘口。点击盘口价格，可以直接填入委托价格。</p></div></div><div class="guide-step"><span>02</span><div><h3>提交你的判断</h3><p>限价单等待指定价格或更优价格成交；市价单在 ±2% 保护范围内成交，剩余数量自动撤销。</p></div></div><div class="guide-step"><span>03</span><div><h3>复盘，再练一次</h3><p>在复盘页查看资产曲线并导出成交记录。管理员可加速时间或开启新一轮练习。</p></div></div><div class="info-note"><Users :size="18"/>机器人拥有有限的独立资金和持仓，只能看到公共行情及自身信息，不知道你的仓位或计划。</div><button class="primary modal-primary" @click="modal = null">开始探索<ArrowRight :size="15"/></button></template>
  </section></div>
  <div class="toast-stack" aria-live="polite"><div v-for="notice in notices" :key="notice.id" :class="['toast', { error: notice.error }]"><CircleHelp v-if="notice.error" :size="17"/><CheckCircle2 v-else :size="17"/><span>{{ notice.message }}</span><button class="icon-button" aria-label="关闭提示" @click="notices = notices.filter(n => n.id !== notice.id)"><X :size="13"/></button></div></div>
</template>
