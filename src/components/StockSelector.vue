<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDownRight, ArrowUpRight, Check, Layers3, Search, ChevronLeft, ChevronRight } from '@lucide/vue'
import type { StockQuote } from '../shared/types'
import { money, compact } from '../lib/market'
const props = defineProps<{ stocks: StockQuote[]; selected: string; disabled: boolean }>()
defineEmits<{ select: [symbol: string] }>()
const search = ref(''), sector = ref('all'), page = ref(1)
const sectors = computed(() => [...new Set(props.stocks.map(s => s.sector))])
const filtered = computed(() => props.stocks.filter(s => (sector.value === 'all' || s.sector === sector.value) && `${s.name} ${s.symbol}`.toLowerCase().includes(search.value.trim().toLowerCase())))
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10)))
const visibleStocks = computed(() => filtered.value.slice((page.value - 1) * 10, page.value * 10))
watch([search, sector], () => { page.value = 1 }, { flush: 'sync' })
watch(pageCount, count => { page.value = Math.min(page.value, count) })
watch(() => props.selected, () => {
  search.value = ''; sector.value = 'all'
  page.value = Math.floor(Math.max(0, props.stocks.findIndex(s => s.symbol === props.selected)) / 10) + 1
}, { immediate: true })
</script>
<template>
  <section class="stock-selector" aria-label="选择交易股票">
    <div class="selector-heading"><span><Layers3 :size="14"/>市场标的 <b>{{ stocks.length }}</b></span><small>独立盘口 · 独立 K 线 · 共享账户资金</small></div>
    <div class="stock-filters"><label><Search :size="14"/><input v-model="search" aria-label="搜索股票" placeholder="搜索股票名称或代码"/></label><select v-model="sector" aria-label="股票行业"><option value="all">全部行业</option><option v-for="item in sectors" :key="item" :value="item">{{ item }}</option></select><span>{{ filtered.length }} / {{ stocks.length }} 只</span></div>
    <div class="stock-selector-grid"><button v-for="stock in visibleStocks" :key="stock.symbol" :class="['stock-option', { selected: selected === stock.symbol }]" :disabled="disabled" :aria-pressed="selected === stock.symbol" @click="$emit('select', stock.symbol)">
      <div><strong>{{ stock.name }}</strong><Check v-if="selected === stock.symbol" :size="12"/><span v-else>{{ stock.sector }}</span></div>
      <div class="option-quote" :class="stock.change >= 0 ? 'up' : 'down'"><b>{{ money(stock.price) }}</b><span><ArrowUpRight v-if="stock.change >= 0" :size="12"/><ArrowDownRight v-else :size="12"/>{{ stock.changePct >= 0 ? '+' : '' }}{{ stock.changePct.toFixed(2) }}%</span></div>
      <div class="option-caption"><span>{{ stock.symbol }}</span><span>{{ compact(stock.volume) }} 股</span></div>
    </button></div>
    <p v-if="!filtered.length" class="stock-no-results">未找到匹配股票，请调整搜索词或行业。</p>
    <div class="stock-pages"><span>每页 10 只 · 第 {{ page }} / {{ pageCount }} 页</span><button :disabled="page <= 1" @click="page--"><ChevronLeft :size="13"/>上一页</button><button :disabled="page >= pageCount" @click="page++">下一页<ChevronRight :size="13"/></button></div>
  </section>
</template>
<style scoped>
.stock-selector{margin:0 0 20px}.selector-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px}.selector-heading>span{display:flex;align-items:center;gap:7px;font-size:12px;color:#a8a2b7}.selector-heading b{font-size:10px;background:#b9a2f718;color:#bfa8e8;border-radius:4px;padding:2px 6px}.selector-heading small{font-size:10px;color:#6d7280}.stock-selector-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.stock-option{display:block;text-align:left;border:1px solid #2b2d36;border-radius:8px;background:#181b20;padding:13px 14px;min-width:0}.stock-option:hover{background:#24222d;border-color:#716080}.stock-option.selected{background:linear-gradient(120deg,#b9a2f714,#b9a2f706);border-color:#796394}.stock-option>div{display:flex;align-items:center;justify-content:space-between;gap:6px}.stock-option strong{font-size:12px;font-weight:500;color:#d4cddf;white-space:nowrap}.stock-option>div:first-child>span{font-size:9px;color:#81758f}.stock-option>div:first-child>svg{color:#b9a2f7}.option-quote{margin:12px 0 9px}.option-quote b{font-size:20px;font-family:'Manrope',sans-serif;font-weight:600}.option-quote>span{font-size:10px;display:flex;gap:2px;align-items:center}.option-caption{font-size:8px;color:#68717e}.option-caption>span:last-child{text-align:right}
@media(max-width:1200px){.stock-option{padding:12px 10px}.stock-option strong{font-size:11px}.option-quote b{font-size:18px}.option-quote>span{font-size:9px}.option-quote svg{display:none}.option-caption>span:last-child{display:none}}
@media(max-width:760px){.stock-selector-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:270px;overflow:auto;padding-right:3px}.stock-option{padding:12px}.stock-option strong{font-size:12px}.option-caption>span:last-child{display:block}.selector-heading small{font-size:8px}.stock-option>div:first-child>span{font-size:8px}}
</style>
<style scoped>
.stock-filters{display:flex;align-items:center;gap:10px;margin-bottom:12px;font-size:10px;color:#8a8997}.stock-filters label{display:flex;align-items:center;gap:7px;border:1px solid #353440;background:#1a1c22;border-radius:5px;padding:8px 10px;flex:1;max-width:310px}.stock-filters input{background:transparent;border:0;outline:none;color:#d5cede;font-size:11px;min-width:0;width:100%}.stock-filters select{background:#1a1c22;border:1px solid #353440;border-radius:5px;padding:7px;color:#aaa1bc;font-size:10px;max-width:100px}.stock-filters>span{margin-left:auto;white-space:nowrap}.stock-pages{display:flex;align-items:center;gap:12px;margin-top:10px;font-size:10px;color:#83818e}.stock-pages>span{margin-right:auto}.stock-pages button{font-size:10px;color:#b8a7cc;padding:5px;white-space:nowrap}.stock-no-results{padding:30px;text-align:center;font-size:11px;color:#92919c}
</style>
