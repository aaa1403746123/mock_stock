import { ref, shallowRef } from 'vue'
import type { Snapshot } from '../shared/types'
import { DEFAULT_SYMBOL, STOCK_CATALOG } from '../shared/rules'

export const snapshot = shallowRef<Snapshot | null>(null)
export const connected = ref(false)
export const loading = ref(true)
export const selectedSymbol = ref(STOCK_CATALOG.some(s => s.symbol === localStorage.getItem('marketlab-symbol')) ? localStorage.getItem('marketlab-symbol')! : DEFAULT_SYMBOL)
export const connectionError = ref('')
export const notices = ref<{ id: number; message: string; error: boolean }[]>([])
let token = localStorage.getItem('marketlab-token') ?? ''
let socket: WebSocket | null = null
let reconnect: ReturnType<typeof setTimeout> | undefined
let noticeId = 0
let generation = 0
export function notify(message: string, error = false) {
  const id = ++noticeId
  notices.value.push({ id, message, error })
  setTimeout(() => { notices.value = notices.value.filter(n => n.id !== id) }, error ? 7000 : 4500)
}
export async function api<T = Snapshot>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 12000)
  try {
    const url = new URL(`/api${path}`, location.origin)
    if (!url.searchParams.has('symbol')) url.searchParams.set('symbol', selectedSymbol.value)
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal })
    const result = await response.json()
    if (!response.ok) throw Object.assign(new Error(result.error ?? '请求失败'), { status: response.status })
    return result as T
  } finally { clearTimeout(timeout) }
}
function connect() {
  const current = ++generation
  clearTimeout(reconnect)
  socket?.close()
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  socket = ws
  ws.onopen = () => ws.send(JSON.stringify({ token, symbol: selectedSymbol.value }))
  ws.onmessage = event => {
    if (current !== generation) return
    const next = JSON.parse(event.data) as Snapshot
    if (next.stock.symbol !== selectedSymbol.value) return
    if (snapshot.value && snapshot.value.round !== next.round) notify(`已进入第 ${next.round} 轮练习，上一轮记录已保存`)
    snapshot.value = next; connected.value = true; connectionError.value = ''
  }
  ws.onclose = event => {
    if (current !== generation) return
    connected.value = false
    if (event.code === 4001) { connectionError.value = '登录已过期，请重新登录账户'; return }
    reconnect = setTimeout(connect, 2000)
  }
  ws.onerror = () => { connected.value = false }
}
export function selectSymbol(symbol: string) {
  if (!STOCK_CATALOG.some(s => s.symbol === symbol) || symbol === selectedSymbol.value) return
  selectedSymbol.value = symbol; localStorage.setItem('marketlab-symbol', symbol)
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ token, symbol }))
  else connect()
}
export async function initialize() {
  loading.value = true; connectionError.value = ''
  try {
    if (token) {
      try { snapshot.value = await api('/state') }
      catch (error) { if ((error as { status?: number }).status === 401) { token = ''; localStorage.removeItem('marketlab-token') } else throw error }
    }
    if (!token) {
      const result = await api<{ token: string; snapshot: Snapshot }>('/auth/guest', 'POST')
      token = result.token; localStorage.setItem('marketlab-token', token); snapshot.value = result.snapshot
    }
    connect()
  } catch (error) { connectionError.value = error instanceof Error ? error.message : '无法连接市场' }
  finally { loading.value = false }
}
export async function login(username: string, password: string, register: boolean) {
  const result = await api<{ token?: string; snapshot: Snapshot }>(register ? '/auth/register' : '/auth/login', 'POST', { username, password })
  if (result.token) { token = result.token; localStorage.setItem('marketlab-token', token) }
  snapshot.value = result.snapshot; connect()
}
export async function newGuest() {
  const result = await api<{ token: string; snapshot: Snapshot }>('/auth/guest', 'POST')
  token = result.token; localStorage.setItem('marketlab-token', token); snapshot.value = result.snapshot; connect()
}
export function money(cents: number, decimals = 2) { return (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) }
export function compact(value: number) { return value >= 1e8 ? `${(value / 1e8).toFixed(2)} 亿` : value >= 1e4 ? `${(value / 1e4).toFixed(2)} 万` : value.toLocaleString('zh-CN') }
export function clock(time: number, seconds = true) { return new Date(time).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' as const } : {}) }) }
