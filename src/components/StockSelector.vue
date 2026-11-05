<script setup lang="ts">
import { ArrowDownRight, ArrowUpRight, Check, Layers3 } from '@lucide/vue'
import type { StockQuote } from '../shared/types'
import { money, compact } from '../lib/market'
defineProps<{ stocks: StockQuote[]; selected: string; disabled: boolean }>()
defineEmits<{ select: [symbol: string] }>()
</script>
<template>
  <section class="stock-selector" aria-label="选择交易股票">
    <div class="selector-heading"><span><Layers3 :size="14"/>市场标的 <b>{{ stocks.length }}</b></span><small>独立盘口 · 独立 K 线 · 共享账户资金</small></div>
    <div class="stock-selector-grid"><button v-for="stock in stocks" :key="stock.symbol" :class="['stock-option', { selected: selected === stock.symbol }]" :disabled="disabled" :aria-pressed="selected === stock.symbol" @click="$emit('select', stock.symbol)">
      <div><strong>{{ stock.name }}</strong><Check v-if="selected === stock.symbol" :size="12"/><span v-else>{{ stock.sector }}</span></div>
      <div class="option-quote" :class="stock.change >= 0 ? 'up' : 'down'"><b>{{ money(stock.price) }}</b><span><ArrowUpRight v-if="stock.change >= 0" :size="12"/><ArrowDownRight v-else :size="12"/>{{ stock.changePct >= 0 ? '+' : '' }}{{ stock.changePct.toFixed(2) }}%</span></div>
      <div class="option-caption"><span>{{ stock.symbol }}</span><span>{{ compact(stock.volume) }} 股</span></div>
    </button></div>
  </section>
</template>
<style scoped>
.stock-selector{margin:0 0 20px}.selector-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px}.selector-heading>span{display:flex;align-items:center;gap:7px;font-size:12px;color:#a8a2b7}.selector-heading b{font-size:10px;background:#b9a2f718;color:#bfa8e8;border-radius:4px;padding:2px 6px}.selector-heading small{font-size:10px;color:#6d7280}.stock-selector-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.stock-option{display:block;text-align:left;border:1px solid #2b2d36;border-radius:8px;background:#181b20;padding:13px 14px;min-width:0}.stock-option:hover{background:#24222d;border-color:#716080}.stock-option.selected{background:linear-gradient(120deg,#b9a2f714,#b9a2f706);border-color:#796394}.stock-option>div{display:flex;align-items:center;justify-content:space-between;gap:6px}.stock-option strong{font-size:12px;font-weight:500;color:#d4cddf;white-space:nowrap}.stock-option>div:first-child>span{font-size:9px;color:#81758f}.stock-option>div:first-child>svg{color:#b9a2f7}.option-quote{margin:12px 0 9px}.option-quote b{font-size:20px;font-family:'Manrope',sans-serif;font-weight:600}.option-quote>span{font-size:10px;display:flex;gap:2px;align-items:center}.option-caption{font-size:8px;color:#68717e}.option-caption>span:last-child{text-align:right}
@media(max-width:1200px){.stock-option{padding:12px 10px}.stock-option strong{font-size:11px}.option-quote b{font-size:18px}.option-quote>span{font-size:9px}.option-quote svg{display:none}.option-caption>span:last-child{display:none}}
@media(max-width:760px){.stock-selector-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:270px;overflow:auto;padding-right:3px}.stock-option{padding:12px}.stock-option strong{font-size:12px}.option-caption>span:last-child{display:block}.selector-heading small{font-size:8px}.stock-option>div:first-child>span{font-size:8px}}
</style>
