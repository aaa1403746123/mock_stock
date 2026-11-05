import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import type { Snapshot } from '../src/shared/types.ts'

test('API authentication, isolated portfolios, idempotent orders, websocket isolation, archives and restart persistence', { timeout: 45000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'marketlab-test-'))
  const port = 32179
  const base = `http://127.0.0.1:${port}`
  let process: ChildProcess | undefined
  const start = async () => {
    process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: resolve('.'), env: { ...globalThis.process.env, PORT: String(port), MARKET_DATA_DIR: dataDir }, stdio: 'pipe', windowsHide: true })
    let logs = ''
    process.stderr?.on('data', data => { logs += String(data) })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (process.exitCode !== null) throw new Error(`Server exited: ${logs}`)
      try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* wait for listener */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Server never started: ${logs}`)
  }
  const stop = async () => {
    if (!process || process.exitCode !== null) return
    const child = process
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill() })
  }
  const request = async (path: string, method = 'GET', token = '', body?: unknown) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    return { status: res.status, body: await res.json() as any }
  }
  try {
    await start()
    assert.equal((await request('/state')).status, 401)
    const first = await request('/auth/guest', 'POST'), second = await request('/auth/guest', 'POST')
    const adminToken = first.body.token as string, traderToken = second.body.token as string
    assert.equal(first.body.snapshot.account.role, 'admin'); assert.equal(second.body.snapshot.account.role, 'trader')
    assert.notEqual(first.body.snapshot.account.id, second.body.snapshot.account.id)
    assert.equal(first.body.snapshot.config.botCount, 1000)
    assert.equal(first.body.snapshot.stocks.length, 50)
    const fundingInput = { round: 1, targetEquity: 20000000, reason: '接口测试注资', requestId: 'api-funding-request' }
    assert.equal((await request('/admin/equity', 'POST', traderToken, fundingInput)).status, 403)
    assert.equal((await request('/admin/equity', 'POST', adminToken, { ...fundingInput, accountId: second.body.snapshot.account.id })).status, 400)
    const funded = await request('/admin/equity?symbol=600002.SH', 'POST', adminToken, fundingInput)
    assert.equal(funded.status, 200); assert.equal(funded.body.snapshot.account.equity, 20000000)
    assert.equal(funded.body.snapshot.account.pnl, 0); assert.equal(funded.body.snapshot.stock.symbol, '600002.SH')
    const repeatedFunding = await request('/admin/equity', 'POST', adminToken, fundingInput)
    assert.equal(repeatedFunding.body.adjustment.id, funded.body.adjustment.id)
    assert.equal(repeatedFunding.body.snapshot.account.fundingAdjustments.length, 1)
    assert.equal((await request('/admin/equity', 'POST', adminToken, { ...fundingInput, round: 999 })).status, 409)
    assert.equal((await request('/admin/accounts')).status, 401)
    assert.equal((await request('/admin/accounts', 'GET', traderToken)).status, 403)
    const monitored = await request('/admin/accounts', 'GET', adminToken)
    assert.equal(monitored.body.accounts.filter((a: { role: string }) => a.role === 'bot').length, 1015)
    assert.equal(monitored.body.accounts.length, 1017)
    const robotId = monitored.body.accounts.find((a: { role: string }) => a.role === 'bot').id
    const robotDetail = await request(`/admin/accounts/${robotId}`, 'GET', adminToken)
    assert.equal(robotDetail.status, 200); assert.ok(robotDetail.body.operations.length > 0)
    assert.equal((await request(`/admin/accounts/${robotId}`, 'GET', traderToken)).status, 403)
    assert.ok(!JSON.stringify(robotDetail.body).includes('passwordHash')); assert.ok(!JSON.stringify(robotDetail.body).includes('anchor'))
    assert.equal((await request('/admin/accounts?round=999', 'GET', adminToken)).status, 404)
    assert.equal((await request('/market', 'PATCH', traderToken, { speed: 5 })).status, 403)
    assert.equal((await request('/auth/register', 'POST', adminToken, { username: '市场管理员', password: 'example-password-2026' })).status, 200)
    assert.equal((await request('/auth/login', 'POST', '', { username: '市场管理员', password: 'wrong-password' })).status, 401)
    const loggedIn = await request('/auth/login', 'POST', '', { username: '市场管理员', password: 'example-password-2026' })
    assert.equal(loggedIn.body.snapshot.account.id, first.body.snapshot.account.id)
    const input = { side: 'buy', kind: 'limit', price: 100, quantity: 100, requestId: 'http-idempotent-request' }
    const submitted = await request('/orders', 'POST', adminToken, input)
    assert.equal(submitted.status, 200); assert.equal(submitted.body.snapshot.account.frozenCash, 10000)
    const duplicate = await request('/orders', 'POST', adminToken, input)
    assert.equal(duplicate.body.order.id, submitted.body.order.id)
    const submitLedger = await request(`/admin/accounts/${first.body.snapshot.account.id}?type=submit`, 'GET', adminToken)
    assert.equal(submitLedger.body.total, 1)
    assert.equal((await request(`/orders/${submitted.body.order.id}`, 'DELETE', traderToken)).status, 404)
    const other = await request('/state', 'GET', traderToken)
    assert.equal(other.body.account.orders.length, 0); assert.equal(other.body.account.frozenCash, 0)
    assert.ok(!JSON.stringify(other.body).includes('passwordHash'))
    const wsView = await new Promise<Snapshot>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error('Websocket timed out')) }, 5000)
      ws.on('open', () => ws.send(JSON.stringify({ token: traderToken, symbol: '600003.SH' })))
      ws.on('message', raw => { clearTimeout(timeout); ws.close(); resolve(JSON.parse(raw.toString())) })
      ws.on('error', reject)
    })
    assert.equal(wsView.account.id, second.body.snapshot.account.id); assert.equal(wsView.account.orders.length, 0)
    assert.equal(wsView.stock.symbol, '600003.SH'); assert.equal(wsView.stocks.length, 50)
    assert.equal(wsView.account.fundingAdjustments.length, 0)
    await stop(); await start()
    const restored = await request('/state', 'GET', adminToken)
    assert.equal(restored.status, 200); assert.equal(restored.body.account.frozenCash, 10000)
    assert.equal(restored.body.account.netFunding, 10000000)
    assert.equal(restored.body.account.fundingAdjustments.length, 1)
    assert.equal((await request(`/admin/accounts/${first.body.snapshot.account.id}?type=submit`, 'GET', adminToken)).body.total, 1)
    assert.equal((await request(`/orders/${submitted.body.order.id}`, 'DELETE', adminToken)).body.snapshot.account.frozenCash, 0)
    const reset = await request('/market/reset', 'POST', adminToken, { mode: 'ashare', botCount: 8, feesEnabled: true })
    assert.equal(reset.status, 200); assert.equal(reset.body.round, 2); assert.equal(reset.body.account.role, 'admin'); assert.equal(reset.body.account.cash, 10000000)
    assert.equal(reset.body.account.orders.length, 0)
    const oldMonitor = await request('/admin/accounts?round=1', 'GET', adminToken)
    assert.equal(oldMonitor.body.current, false); assert.equal(oldMonitor.body.accounts.length, 1017)
    const oldLedger = await request(`/admin/accounts/${first.body.snapshot.account.id}?round=1`, 'GET', adminToken)
    assert.equal(oldLedger.body.total, 2)
    assert.equal(oldLedger.body.fundingAdjustments.length, 1)
    assert.equal(reset.body.account.fundingAdjustments.length, 0)
    assert.equal((await request(`/admin/accounts/${first.body.snapshot.account.id}`, 'GET', adminToken)).body.total, 0)
    const archives = await request('/rounds', 'GET', adminToken)
    assert.equal(archives.body.length, 1); assert.equal(archives.body[0].account.orders.length, 1)
    const otherArchives = await request('/rounds', 'GET', traderToken)
    assert.equal(otherArchives.body[0].account.orders.length, 0)
    assert.equal((await request('/market/reset', 'POST', traderToken, { mode: 'free', botCount: 8, feesEnabled: false })).status, 403)
    await stop(); await start()
    assert.equal((await request('/state', 'GET', adminToken)).body.round, 2)
    assert.equal((await request('/rounds', 'GET', adminToken)).body.length, 1)
    assert.equal((await request(`/admin/accounts/${first.body.snapshot.account.id}?round=1`, 'GET', adminToken)).body.total, 2)
  } finally { await stop() }
})
