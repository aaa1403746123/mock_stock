<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowDownToLine, ArrowRight, Check, ChevronDown, History, LoaderCircle, LockKeyhole, RefreshCw, Search, Users, Wallet } from '@lucide/vue'
import { api, clock, money, notify } from '../lib/market'
import { stockName } from '../shared/rules'
import type { AccountSummary, BotKind, MonitorDetail, MonitorOverview, OperationType, Order } from '../shared/types'

const props = defineProps<{ round: number; accountId: string }>()
const overview = ref<MonitorOverview | null>(null)
const detail = ref<MonitorDetail | null>(null)
const selectedId = ref('')
const selectedRound = ref(0)
const search = ref('')
const category = ref('all')
const sort = ref('pnl')
const operationType = ref<OperationType | 'all'>('all')
const detailTab = ref<'operations' | 'pending' | 'funding'>('operations')
const accountPage = ref(1)
const error = ref(''), detailError = ref('')
const overviewBusy = ref(false), detailBusy = ref(false)
const liveHistory = ref(true)
let overviewRequest = 0, detailRequest = 0
let timer: ReturnType<typeof setInterval> | undefined
let disposed = false
const botNames: Record<BotKind, string> = { retail: '随机散户', trend: '趋势散户', value: '价值投资者', whale: '资金大户', maker: '流动性提供者' }
const roleName = (account: AccountSummary) => account.botKind ? botNames[account.botKind] : account.role === 'admin' ? '真人 · 管理员' : '真人交易者'
const signed = (cents: number) => `${cents > 0 ? '+' : ''}${money(cents)}`
const changeClass = (value: number) => value > 0 ? 'up' : value < 0 ? 'down' : 'neutral'
const actionNames: Record<OperationType, string> = { submit: '下单', fill: '成交', cancel: '撤单', snapshot: '旧委托快照' }
const reasons: Record<string, string> = { user: '主动撤单', strategy: '策略调整', day_end: '当日委托到期', round_end: '本轮练习结束', self_trade: '自成交保护', no_liquidity: '市价剩余自动撤销' }
const orderStatus = (order: Order) => ({ open: '待成交', partial: '部分成交', filled: '全部成交', cancelled: '已撤单' })[order.status]
const accounts = computed(() => overview.value?.accounts ?? [])
const selected = computed(() => accounts.value.find(a => a.id === selectedId.value))
const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase()
  return accounts.value.filter(account => (!needle || `${account.name} ${account.id}`.toLowerCase().includes(needle)) && (category.value === 'all' || (category.value === 'human' ? account.role !== 'bot' : category.value === 'bot' ? account.role === 'bot' : account.botKind === category.value)))
    .sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : (sort.value === 'equity' ? b.equity - a.equity : sort.value === 'return' ? b.returnPct - a.returnPct : b.pnl - a.pnl) || a.id.localeCompare(b.id))
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 50)))
const pageAccounts = computed(() => filtered.value.slice((accountPage.value - 1) * 50, accountPage.value * 50))
watch([search, category, sort], () => { accountPage.value = 1 })
watch(pageCount, count => { accountPage.value = Math.min(accountPage.value, count) })
const totalEquity = computed(() => accounts.value.reduce((sum, a) => sum + a.equity, 0))
const profitable = computed(() => accounts.value.filter(a => a.pnl > 0).length)
const botCount = computed(() => accounts.value.filter(a => a.role === 'bot').length)
const openOrders = computed(() => accounts.value.reduce((sum, a) => sum + a.openOrders, 0))
const date = (time: number) => new Date(time + 8 * 3600_000).toISOString().slice(5, 10)

async function loadOverview(quiet = false) {
  if (disposed || (quiet && overviewBusy.value)) return
  const request = ++overviewRequest
  overviewBusy.value = true
  const round = selectedRound.value
  try {
    const data = await api<MonitorOverview>(`/admin/accounts${round ? `?round=${round}` : ''}`)
    if (disposed || request !== overviewRequest) return
    overview.value = data; error.value = ''
    if (!data.accounts.some(a => a.id === selectedId.value)) selectedId.value = data.accounts.find(a => a.id === props.accountId)?.id ?? data.accounts[0]?.id ?? ''
  } catch (err) { if (!disposed && request === overviewRequest) error.value = (err as Error).message }
  finally { if (!disposed && request === overviewRequest) overviewBusy.value = false }
}
async function loadDetail(older = false, quiet = false) {
  if (!selected.value || !overview.value || disposed || (quiet && (detailBusy.value || !liveHistory.value))) return
  const before = older ? detail.value?.nextCursor : null
  if (older && !before) return
  const request = ++detailRequest, id = selectedId.value, round = overview.value.round, type = operationType.value
  detailBusy.value = true
  try {
    const data = await api<MonitorDetail>(`/admin/accounts/${encodeURIComponent(id)}?round=${round}&type=${type}${before ? `&before=${before}` : ''}`)
    if (disposed || request !== detailRequest || selectedId.value !== id || overview.value?.round !== round) return
    detail.value = older && detail.value ? { ...data, operations: [...detail.value.operations, ...data.operations] } : data
    if (older) liveHistory.value = false
    else if (!quiet) liveHistory.value = true
    detailError.value = ''
  } catch (err) { if (!disposed && request === detailRequest) detailError.value = (err as Error).message }
  finally { if (!disposed && request === detailRequest) detailBusy.value = false }
}
async function refresh() { await loadOverview(); await loadDetail() }
function exportAccounts() {
  const rows: (string | number)[][] = [['账户', '类型', '现金余额(元)', '可用资金(元)', '冻结资金(元)', '持股(股)', '可卖(股)', '持仓市值(元)', '总资产(元)', '初始总资产(元)', '净资金调整(元)', '已实现盈亏(元)', '浮动盈亏(元)', '累计盈亏(元)', '收益率(%)'], ...filtered.value.map(a => [a.name, roleName(a), a.cash / 100, a.availableCash / 100, a.frozenCash / 100, a.shares, a.sellable, a.marketValue / 100, a.equity / 100, a.initialEquity / 100, a.netFunding / 100, a.realized / 100, a.unrealized / 100, a.pnl / 100, Number(a.returnPct.toFixed(4))])]
  const csv = rows.map(row => row.map(value => {
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value)
    return `"${safe.replaceAll('"', '""')}"`
  }).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' }))
  const link = document.createElement('a'); link.href = url; link.download = `MarketLab-第${overview.value?.round}轮-账户报表.csv`; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  notify(`已导出 ${filtered.value.length} 个账户的资金与盈亏报表`)
}
watch(selectedId, () => { ++detailRequest; detail.value = null; detailError.value = ''; liveHistory.value = true; loadDetail() })
watch(operationType, () => { ++detailRequest; detail.value = null; liveHistory.value = true; loadDetail() })
watch(selectedRound, () => {
  ++overviewRequest; ++detailRequest; overview.value = null; detail.value = null; selectedId.value = ''; detailError.value = ''; liveHistory.value = true; loadOverview()
})
watch(() => props.round, () => { if (!selectedRound.value) { ++detailRequest; detail.value = null; selectedId.value = ''; loadOverview() } })
onMounted(() => {
  loadOverview()
  timer = setInterval(async () => { if (!selectedRound.value && !document.hidden) { await loadOverview(true); await loadDetail(false, true) } }, 3000)
})
onBeforeUnmount(() => { disposed = true; ++overviewRequest; ++detailRequest; clearInterval(timer) })
</script>

<template>
  <div class="account-monitor">
    <div class="monitor-toolbar">
      <div class="select-wrap"><History :size="16"/><select v-model.number="selectedRound" aria-label="监控练习轮次"><option :value="0">当前练习 · 第 {{ props.round }} 轮</option><option v-for="round in overview?.rounds.filter(r => r.id !== props.round) ?? []" :key="round.id" :value="round.id">第 {{ round.id }} 轮 · {{ round.mode === 'free' ? '自由练习' : 'A 股规则' }}</option></select></div>
      <span class="monitor-access"><LockKeyhole :size="13"/>管理员只读视角</span>
      <button class="secondary" :disabled="overviewBusy" @click="refresh"><RefreshCw :size="14" :class="{ spin: overviewBusy }"/>刷新</button>
      <button class="secondary" :disabled="!filtered.length" @click="exportAccounts"><ArrowDownToLine :size="14"/>导出账户报表</button>
    </div>
    <div v-if="error" class="form-error" role="alert">{{ error }}<button class="text-button" @click="refresh">重试</button></div>
    <div class="stat-grid monitor-stats">
      <article class="stat-card"><div class="stat-label"><span>市场账户</span><Users :size="16"/></div><div class="stat-value">{{ accounts.length }}<small>个</small></div><div class="stat-note">{{ botCount }} 个机器人 · {{ accounts.length - botCount }} 个真人账户</div></article>
      <article class="stat-card"><div class="stat-label"><span>全市场账户总资产</span><Wallet :size="16"/></div><div class="stat-value"><small>¥</small>{{ money(totalEquity, 0) }}</div><div class="stat-note">现金余额 + 当前持仓市值</div></article>
      <article class="stat-card"><div class="stat-label">盈利账户</div><div class="stat-value up">{{ profitable }}<small>/ {{ accounts.length }}</small></div><div class="stat-note">累计盈亏大于 0 的账户数量</div></article>
      <article class="stat-card"><div class="stat-label">当前有效委托</div><div class="stat-value">{{ openOrders }}<small>笔</small></div><div class="stat-note">{{ overview?.current ? '每 3 秒自动刷新' : '历史练习最终状态' }} · {{ overview ? clock(overview.time) : '—' }}</div></article>
    </div>

    <section class="panel monitor-list">
      <div class="panel-heading"><h2>账户资金与盈亏<span class="muted">{{ filtered.length }} / {{ accounts.length }} 个账户</span></h2><span class="muted tiny">点击账户查看明细</span></div>
      <div class="monitor-filters"><label class="monitor-search"><Search :size="15"/><input v-model="search" placeholder="搜索账户名称或编号" aria-label="搜索账户"/></label><select v-model="category" aria-label="账户类型筛选"><option value="all">全部账户</option><option value="human">真人账户</option><option value="bot">全部机器人</option><option v-for="(name, kind) in botNames" :key="kind" :value="kind">{{ name }}</option></select><select v-model="sort" aria-label="账户排序"><option value="pnl">累计盈亏：从高到低</option><option value="return">收益率：从高到低</option><option value="equity">总资产：从高到低</option><option value="name">账户名称</option></select></div>
      <div class="table-wrap monitor-account-table"><table><thead><tr><th>账户 / 类型</th><th>现金余额</th><th>可用 / 冻结资金</th><th>持仓 / 市值</th><th>总资产</th><th>累计盈亏</th><th>收益率</th><th></th></tr></thead><tbody><tr v-for="account in pageAccounts" :key="account.id" :class="{ 'monitor-selected-row': selectedId === account.id }"><td><button class="monitor-account-name" :aria-pressed="selectedId === account.id" @click="selectedId = account.id"><span :class="['monitor-avatar', { human: account.role !== 'bot' }]">{{ account.role === 'bot' ? '机' : '人' }}</span><span><strong>{{ account.name }}</strong><small>{{ roleName(account) }}</small></span></button></td><td>¥ {{ money(account.cash) }}</td><td>{{ money(account.availableCash) }}<small>冻结 {{ money(account.frozenCash) }}</small></td><td>{{ account.shares.toLocaleString() }} 股<small>¥ {{ money(account.marketValue) }}</small></td><td>¥ {{ money(account.equity) }}</td><td :class="changeClass(account.pnl)">{{ signed(account.pnl) }}</td><td :class="changeClass(account.returnPct)">{{ account.returnPct > 0 ? '+' : '' }}{{ account.returnPct.toFixed(2) }}%</td><td><button class="small-button" @click="selectedId = account.id"><Check v-if="selectedId === account.id" :size="12"/><ArrowRight v-else :size="12"/>{{ selectedId === account.id ? '查看中' : '详情' }}</button></td></tr></tbody></table>
        <div v-if="!filtered.length" class="empty-state"><LoaderCircle v-if="overviewBusy" class="spin" :size="24"/><template v-else><Users :size="25"/><strong>没有符合条件的账户</strong><p>调整搜索词或账户类型后重试。</p></template></div>
      </div>
      <div class="monitor-pagination"><span>共 {{ filtered.length }} 个账户 · 第 {{ accountPage }} / {{ pageCount }} 页</span><button class="small-button" :disabled="accountPage <= 1" @click="accountPage--">上一页</button><button class="small-button" :disabled="accountPage >= pageCount" @click="accountPage++">下一页</button></div><div class="monitor-table-caption">总资产汇总全部股票市值；盈亏剔除净资金调整，收益率以初始资产及累计注资为基数。每页显示 50 个账户。</div>
    </section>

    <section v-if="selected" class="panel monitor-detail">
      <div class="panel-heading"><div><h2>{{ selected.name }}<span class="tag">{{ roleName(selected) }}</span></h2><p class="monitor-account-id">{{ selected.id }} · 第 {{ overview?.round }} 轮</p></div><span class="muted tiny">资金更新 {{ overview ? clock(overview.time) : '—' }}</span></div>
      <div class="monitor-balance-grid">
        <div><span>初始总资产</span><strong>¥ {{ money(selected.initialEquity) }}</strong></div><div><span>当前总资产</span><strong>¥ {{ money(selected.equity) }}</strong></div><div><span>已实现盈亏</span><strong :class="changeClass(selected.realized)">{{ signed(selected.realized) }}</strong></div><div><span>浮动盈亏</span><strong :class="changeClass(selected.unrealized)">{{ signed(selected.unrealized) }}</strong></div><div><span>现金余额 / 可用</span><strong>{{ money(selected.cash) }} / {{ money(selected.availableCash) }}</strong></div><div><span>持仓 / 可卖</span><strong>{{ selected.shares.toLocaleString() }} / {{ selected.sellable.toLocaleString() }} 股</strong></div><div><span>净资金调整</span><strong>{{ signed(selected.netFunding) }}</strong></div><div><span>冻结资金 / 股票</span><strong>¥ {{ money(selected.frozenCash) }} / {{ selected.frozenShares.toLocaleString() }} 股</strong></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>持仓股票</th><th>持仓 / 可卖</th><th>平均成本</th><th>当前市值</th><th>浮动盈亏</th></tr></thead><tbody><tr v-for="position in selected.positions.filter(p => p.shares > 0)" :key="position.symbol"><td>{{ position.name }}<small>{{ position.symbol }}</small></td><td>{{ position.shares.toLocaleString() }} / {{ position.sellable.toLocaleString() }}</td><td>{{ money(position.averageCost) }}</td><td>¥ {{ money(position.marketValue) }}</td><td :class="changeClass(position.unrealized)">{{ signed(position.unrealized) }}</td></tr></tbody></table></div><div class="section-tabs"><div><button :class="{ active: detailTab === 'operations' }" @click="detailTab = 'operations'">操作记录<span>{{ detail?.total ?? 0 }}</span></button><button :class="{ active: detailTab === 'pending' }" @click="detailTab = 'pending'; loadDetail()">当前委托<span>{{ selected.openOrders }}</span></button><button :class="{ active: detailTab === 'funding' }" @click="detailTab = 'funding'; loadDetail()">资金调整<span>{{ detail?.fundingAdjustments.length ?? 0 }}</span></button></div><button class="text-button" :disabled="detailBusy" @click="loadDetail()"><RefreshCw :size="12" :class="{ spin: detailBusy }"/>{{ liveHistory ? '刷新记录' : '回到最新记录' }}</button></div>
      <div v-if="detailTab === 'operations'" class="monitor-history-filters"><button v-for="option in [{ id: 'all', text: '全部' }, { id: 'submit', text: '下单' }, { id: 'fill', text: '成交' }, { id: 'cancel', text: '撤单' }] as const" :key="option.id" :class="{ active: operationType === option.id }" @click="operationType = option.id">{{ option.text }}</button><span>{{ liveHistory && overview?.current ? '自动更新' : '历史浏览中' }}<template v-if="detail"> · {{ clock(detail.time) }}</template></span></div>
      <p v-if="detailError" class="form-error" role="alert">{{ detailError }}</p>
      <div v-if="detailTab === 'operations'" class="table-wrap monitor-operations-table"><table><thead><tr><th>模拟时间</th><th>股票</th><th>操作 / 方向</th><th>委托编号</th><th>价格 / 股数</th><th>本次费用</th><th>操作后现金</th><th>操作后持仓</th><th>累计已实现盈亏</th></tr></thead><tbody><tr v-for="operation in detail?.operations ?? []" :key="operation.id"><td>{{ clock(operation.time) }}<small>{{ date(operation.time) }}</small></td><td>{{ stockName(operation.symbol) }}<small>{{ operation.symbol }}</small></td><td><span :class="['operation-pill', operation.type]">{{ actionNames[operation.type] }}</span><span :class="operation.side === 'buy' ? 'up' : 'down'"> {{ operation.side === 'buy' ? '买入' : '卖出' }}</span><small>{{ operation.reason ? reasons[operation.reason] ?? operation.reason : operation.kind === 'market' ? '市价保护' : '限价委托' }}</small></td><td class="monitor-order-id">{{ operation.orderId }}</td><td>¥ {{ money(operation.price) }}<small>{{ operation.quantity.toLocaleString() }} 股{{ operation.type === 'cancel' ? '未成交撤销' : '' }}</small></td><td>{{ operation.fee === null ? '—' : `¥ ${money(operation.fee)}` }}<small v-if="operation.type === 'snapshot'">委托累计费用</small></td><td>{{ operation.cashAfter === null ? '—' : `¥ ${money(operation.cashAfter)}` }}</td><td>{{ operation.sharesAfter === null ? '—' : `${operation.sharesAfter.toLocaleString()} 股` }}</td><td :class="operation.realizedAfter === null ? '' : changeClass(operation.realizedAfter)">{{ operation.realizedAfter === null ? '—' : signed(operation.realizedAfter) }}</td></tr></tbody></table><div v-if="!detail?.operations.length" class="empty-state"><LoaderCircle v-if="detailBusy" class="spin" :size="22"/><template v-else><History :size="23"/><strong>暂无此类操作记录</strong><p>该账户下单、成交或撤单后，记录将出现在这里。</p></template></div></div>
      <div v-else-if="detailTab === 'pending'" class="table-wrap"><table><thead><tr><th>委托时间</th><th>股票</th><th>方向 / 类型</th><th>委托价</th><th>已成交 / 委托</th><th>成交均价</th><th>状态</th></tr></thead><tbody><tr v-for="order in detail?.pending ?? []" :key="order.id"><td>{{ date(order.createdAt) }} {{ clock(order.createdAt) }}</td><td>{{ stockName(order.symbol) }}<small>{{ order.symbol }}</small></td><td :class="order.side === 'buy' ? 'up' : 'down'">{{ order.side === 'buy' ? '买入' : '卖出' }}<small>{{ order.kind === 'market' ? '市价保护' : '限价委托' }}</small></td><td>{{ money(order.price) }}</td><td>{{ order.filled }} / {{ order.quantity }}</td><td>{{ order.filled ? money(order.averagePrice) : '—' }}</td><td>{{ orderStatus(order) }}</td></tr></tbody></table><div v-if="!detail?.pending.length" class="empty-state"><LoaderCircle v-if="detailBusy" class="spin" :size="22"/><strong v-else>该账户暂无有效委托</strong></div></div>
      <div v-if="detailTab === 'funding'" class="table-wrap"><table><thead><tr><th>调整时间</th><th>原因</th><th>调整前总资产</th><th>目标总资产</th><th>现金增减</th></tr></thead><tbody><tr v-for="adjustment in [...(detail?.fundingAdjustments ?? [])].reverse()" :key="adjustment.id"><td>{{ date(adjustment.time) }} {{ clock(adjustment.time) }}</td><td>{{ adjustment.reason }}</td><td>{{ money(adjustment.beforeEquity) }}</td><td>{{ money(adjustment.targetEquity) }}</td><td>{{ signed(adjustment.delta) }}</td></tr></tbody></table><div v-if="!detail?.fundingAdjustments.length" class="empty-state"><strong>暂无资金调整</strong></div></div><div v-if="detailTab === 'operations' && detail?.operations.length" class="monitor-pagination"><span>已显示 {{ detail.operations.length }} / {{ detail.total }} 条记录</span><button v-if="detail.nextCursor" class="secondary" :disabled="detailBusy" @click="loadDetail(true)"><LoaderCircle v-if="detailBusy" class="spin" :size="14"/><ChevronDown v-else :size="14"/>加载更早记录</button><span v-else>已显示全部记录</span></div>
      <p v-if="detail?.legacy" class="monitor-legacy-note">升级前的记录根据现存委托与成交回填，未记录的余额显示为「—」；此前已清理的机器人历史无法补回。升级后的下单、成交、撤单会完整保存。</p>
    </section>
  </div>
</template>

<style scoped>
.monitor-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap}.monitor-access{display:flex;align-items:center;gap:6px;color:#a699bf;font-size:11px;margin-right:auto}.monitor-stats .stat-value{font-size:24px}.monitor-stats .stat-value small{margin-left:5px}.monitor-list{margin-bottom:20px}.monitor-filters{display:flex;gap:10px;padding:0 18px 17px;flex-wrap:wrap}.monitor-search{display:flex;align-items:center;gap:9px;padding:9px 12px;flex:1;min-width:190px;border:1px solid #353440;border-radius:6px;color:#8b829d;background:#202127}.monitor-search input{background:none;border:0;color:#d6d0e0;min-width:0;width:100%;font-size:11px}.monitor-filters>select{border:1px solid #353440;border-radius:6px;background:#202127;padding:9px 12px;color:#aaa3bb;font-size:11px}.monitor-account-table{max-height:465px}.monitor-account-table th{position:sticky;top:0;z-index:2;background:#202228}.monitor-account-table td{padding-top:12px;padding-bottom:12px}.monitor-selected-row{background:#b9a2f70b}.monitor-account-name{justify-content:flex-start;padding:0;text-align:left;gap:10px;white-space:nowrap}.monitor-avatar{display:flex;justify-content:center;align-items:center;width:30px;height:30px;background:#6d8ca51a;border:1px solid #6d8ca533;color:#8cacc7;border-radius:8px;font-size:11px}.monitor-avatar.human{background:#b9a2f717;border-color:#b9a2f735;color:#c9b6f1}.monitor-account-name small{font-size:9px}.monitor-account-name:hover strong{color:#c9b6f1}.monitor-table-caption{padding:12px 18px;color:#77798c;font-size:10px;border-top:1px solid var(--line);line-height:1.8}.monitor-account-id{font-size:10px;color:#77788d;margin-top:7px}.monitor-detail>.panel-heading{padding:22px}.monitor-balance-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:22px 18px;padding:4px 22px 26px}.monitor-balance-grid>div{display:flex;flex-direction:column;gap:9px}.monitor-balance-grid span{font-size:10px;color:#7f8594}.monitor-balance-grid strong{font-size:13px;font-weight:500;font-variant-numeric:tabular-nums;color:#d0c9df}.monitor-history-filters{padding:14px 19px;display:flex;align-items:center;gap:7px}.monitor-history-filters>button{padding:6px 11px;border-radius:5px;color:#868092;font-size:10px}.monitor-history-filters>button.active{background:#b9a2f719;color:#cab9ee}.monitor-history-filters>span{margin-left:auto;color:#6f7483;font-size:9px}.monitor-operations-table{max-height:570px}.monitor-operations-table th{position:sticky;top:0;z-index:2}.monitor-operations-table td small{white-space:normal;max-width:230px;line-height:1.8}.monitor-order-id{font-size:10px;color:#828193}.operation-pill{display:inline-flex;padding:3px 5px;border-radius:4px;background:#b9a2f717;color:#c5b2e7;font-size:9px}.operation-pill.fill{background:#55c5a417;color:#72cdb1}.operation-pill.cancel{background:#dfb87617;color:#c6ad88}.operation-pill.snapshot{background:#9496a617;color:#9496a6}.monitor-pagination{display:flex;justify-content:space-between;align-items:center;padding:15px 19px;border-top:1px solid var(--line);font-size:10px;color:#7c8190;gap:15px}.monitor-pagination .secondary{min-height:31px;font-size:10px;padding:0 12px}.monitor-legacy-note{border-top:1px solid var(--line);padding:14px 19px;font-size:10px;color:#888095;line-height:1.9}.monitor-list .empty-state,.monitor-detail .empty-state{gap:12px}.account-monitor>.form-error{margin-bottom:18px;display:flex;justify-content:space-between}.monitor-detail>.form-error{margin:0 18px 15px}
@media(max-width:1200px){.monitor-stats .stat-value{font-size:21px}.monitor-balance-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.monitor-toolbar .secondary{font-size:11px;padding:0 13px}}
@media(max-width:760px){.monitor-access{font-size:9px}.monitor-toolbar{gap:9px}.monitor-toolbar .secondary{font-size:10px;min-height:34px}.monitor-filters{padding:0 14px 14px}.monitor-search{flex-basis:100%}.monitor-filters>select{flex:1;min-width:0;font-size:10px}.monitor-stats .stat-value{font-size:20px}.monitor-balance-grid{padding:3px 16px 22px;gap:20px 12px}.monitor-balance-grid strong{font-size:11px}.monitor-balance-grid span{font-size:9px}.monitor-detail>.panel-heading{padding:19px 16px}.monitor-history-filters{padding:12px}.monitor-history-filters>button{padding:5px 8px}.monitor-history-filters>span{font-size:8px}.monitor-account-table{max-height:400px}.monitor-table-caption,.monitor-legacy-note{padding:12px 14px;font-size:9px}.monitor-detail .section-tabs>.text-button{display:flex;font-size:9px}.monitor-detail .section-tabs>div{gap:16px}}
</style>
