<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowRight, History, LoaderCircle, SlidersHorizontal, Wallet, X } from '@lucide/vue'
import { api, money, notify, selectedSymbol, snapshot, clock } from '../lib/market'
import type { FundingAdjustment, PersonalView, Snapshot } from '../shared/types'
import { MAX_ACCOUNT_EQUITY } from '../shared/rules'
const props = defineProps<{ account: PersonalView; round: number }>()
const opened = ref(false), busy = ref(false), error = ref(''), target = ref(''), reason = ref('练习资金调整')
const minimum = computed(() => props.account.marketValue + props.account.frozenCash)
const targetCents = computed(() => Math.round(Number(target.value) * 100))
const delta = computed(() => targetCents.value - props.account.equity)
let lastRequest: { fingerprint: string; id: string } | undefined
function open() { target.value = (props.account.equity / 100).toFixed(2); error.value = ''; opened.value = true; lastRequest = undefined }
async function submit() {
  if (busy.value) return
  if (!Number.isSafeInteger(targetCents.value) || Math.abs(Number(target.value) * 100 - targetCents.value) > .000001 || targetCents.value < 0 || targetCents.value > MAX_ACCOUNT_EQUITY) { error.value = '请输入有效的总资产金额，最多保留两位小数'; return }
  const input = { targetEquity: targetCents.value, reason: reason.value, round: props.round }
  const fingerprint = JSON.stringify(input)
  if (lastRequest?.fingerprint !== fingerprint) lastRequest = { fingerprint, id: crypto.randomUUID() }
  busy.value = true; error.value = ''
  try {
    const result = await api<{ snapshot: Snapshot; adjustment: FundingAdjustment }>('/admin/equity', 'POST', { ...input, requestId: lastRequest.id })
    if (result.snapshot.stock.symbol === selectedSymbol.value) snapshot.value = result.snapshot
    notify(`总资产已调整为 ¥${money(result.adjustment.targetEquity)}，本次${result.adjustment.delta >= 0 ? '增加' : '减少'}现金 ¥${money(Math.abs(result.adjustment.delta))}`)
    opened.value = false; lastRequest = undefined
  } catch (err) { error.value = (err as Error).message; if ((err as { status?: number }).status) lastRequest = undefined }
  finally { busy.value = false }
}
watch(() => props.round, () => { opened.value = false; lastRequest = undefined })
</script>
<template>
  <button v-if="account.role === 'admin'" class="adjust-trigger" @click="open"><SlidersHorizontal :size="12"/>调整</button>
  <Teleport to="body"><div v-if="opened" class="modal-backdrop" @click.self="!busy && (opened = false)"><section class="modal asset-modal" role="dialog" aria-modal="true" aria-label="调整我的总资产"><button class="icon-button modal-close" :disabled="busy" aria-label="关闭资产调整" @click="opened = false"><X :size="19"/></button>
    <div class="modal-icon"><Wallet :size="24"/></div><h2>调整我的总资产</h2><p class="modal-intro">仅调整 {{ account.name }} 的虚拟现金。股票持仓、挂单和交易盈亏保留；资金增减单独记账。</p>
    <div class="fund-facts"><div><span>当前总资产</span><b>¥ {{ money(account.equity) }}</b></div><div><span>其中持仓市值</span><b>¥ {{ money(account.marketValue) }}</b></div><div><span>最低可设总资产</span><b>¥ {{ money(minimum) }}</b></div></div>
    <form @submit.prevent="submit"><label class="field-label" for="asset-target">目标总资产<span>人民币 / 元</span></label><input id="asset-target" class="text-input" v-model="target" type="number" min="0" :max="MAX_ACCOUNT_EQUITY / 100" step="0.01" required/><div class="fund-presets"><button v-for="amount in [100000, 1000000, 10000000, 100000000]" :key="amount" type="button" @click="target = amount.toFixed(2)">{{ amount === 100000000 ? '1 亿' : `${amount / 10000} 万` }}</button></div><label class="field-label" for="asset-reason">调整原因</label><input id="asset-reason" class="text-input" v-model="reason" maxlength="100" required placeholder="例如：增加资金练习大额交易"/><div class="fund-preview"><span>预计现金{{ delta >= 0 ? '增加' : '减少' }}</span><strong>¥ {{ Number.isFinite(delta) ? money(Math.abs(delta)) : '—' }}</strong></div><p class="fund-note">按提交时行情计算。目标金额须覆盖持仓市值和冻结资金；成交后总资产仍随股价变化。注资不计作盈利，提款不计作亏损。</p><p v-if="error" class="form-error" role="alert">{{ error }}</p><button class="primary modal-primary" :disabled="busy"><LoaderCircle v-if="busy" class="spin" :size="16"/>确认调整我的资产<ArrowRight :size="15"/></button></form>
    <div v-if="account.fundingAdjustments.length" class="fund-history"><h3><History :size="14"/>最近调整</h3><div v-for="item in account.fundingAdjustments.slice(-5).reverse()" :key="item.id"><span>{{ clock(item.time) }} · {{ item.reason }}</span><b>{{ item.delta >= 0 ? '+' : '' }}{{ money(item.delta) }}</b></div></div>
  </section></div></Teleport>
</template>
<style scoped>
.adjust-trigger{padding:3px 5px;border-radius:4px;color:#c2aee6;font-size:10px;background:#b9a2f711}.adjust-trigger:hover{background:#b9a2f726}.fund-facts{display:flex;flex-direction:column;gap:11px;background:#14161b;border:1px solid #302d38;border-radius:7px;padding:15px;margin-top:18px}.fund-facts>div,.fund-preview{display:flex;justify-content:space-between;align-items:center;gap:15px;font-size:11px;color:#838291}.fund-facts b{font-size:12px;font-weight:400;color:#c6bdd6}.fund-presets{display:flex;gap:7px;margin:10px 0 16px}.fund-presets button{flex:1;padding:6px 4px;border:1px solid #3a3348;border-radius:5px;font-size:10px;color:#ad99ce}.fund-presets button:hover{background:#b9a2f712}.fund-preview{margin:19px 0 13px}.fund-preview strong{color:#cfbce9;font-size:16px;font-weight:500}.fund-note{font-size:10px;color:#79788b;line-height:1.9}.asset-modal{width:480px}.fund-history{margin-top:22px;padding-top:15px;border-top:1px solid #33303b}.fund-history h3{display:flex;gap:7px;align-items:center;font-size:11px;color:#a59bb8;font-weight:400;margin-bottom:12px}.fund-history>div{display:flex;justify-content:space-between;gap:15px;font-size:10px;line-height:1.8;padding:7px 0;color:#7e7c8f}.fund-history>div>span{max-width:70%;overflow-wrap:anywhere}.fund-history b{font-weight:400;color:#bcaacf;white-space:nowrap}
</style>
