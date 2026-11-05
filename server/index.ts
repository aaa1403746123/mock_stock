import express from 'express'
import { createServer } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MarketEngine, MarketError } from './engine.ts'
import { MonitorStore } from './monitor.ts'
import { initAdminAccess, applyAdminAccess, hasPendingAdminAccess } from './admin-access.ts'
import type { EngineState } from '../src/shared/types.ts'
import { DEFAULT_SYMBOL } from '../src/shared/rules.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.MARKET_DATA_DIR ?? resolve(root, 'data')
mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(resolve(dataDir, 'market.sqlite'))
db.exec('PRAGMA busy_timeout=5000')
initAdminAccess(db)
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL);')
const saved = db.prepare('SELECT json FROM state WHERE id=1').get() as { json: string } | undefined
const engine = new MarketEngine(saved ? JSON.parse(saved.json) as EngineState : undefined)
const monitor = new MonitorStore(db)
if (monitor.needsBackfill()) {
  const archivedStates = db.prepare('SELECT json FROM rounds ORDER BY id').all() as { json: string }[]
  monitor.backfill([...(saved ? [engine.state] : []), ...archivedStates.map(row => JSON.parse(row.json) as EngineState)])
}
engine.upgradePopulation()
const persist = db.prepare('INSERT INTO state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json')
const save = (extra?: () => void) => {
  db.exec('BEGIN')
  let undoGrant: (() => void) | undefined
  try {
    extra?.()
    undoGrant = applyAdminAccess(db, engine.state)
    persist.run(JSON.stringify(engine.state))
    monitor.append(engine.operations)
    db.exec('COMMIT')
    engine.operations.length = 0
  } catch (error) { db.exec('ROLLBACK'); undoGrant?.(); throw error }
}
save()
const hash = (token: string) => createHash('sha256').update(token).digest('hex')
const passwordHash = (password: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}` }
const verifyPassword = (password: string, stored: string) => { const [salt, key] = stored.split(':'); return !!salt && !!key && timingSafeEqual(Buffer.from(key, 'hex'), scryptSync(password, salt, 64)) }
const session = (accountId: string) => {
  const token = randomBytes(32).toString('hex')
  engine.state.sessions[hash(token)] = { accountId, expires: Date.now() + 30 * 86400_000 }
  return token
}
const authenticate = (token?: string) => {
  if (!token || token.length > 200) throw new MarketError('请重新登录账户', 401)
  const found = engine.state.sessions[hash(token)]
  if (!found || found.expires < Date.now()) throw new MarketError('登录已过期，请重新登录', 401)
  return engine.account(found.accountId)
}
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '16kb' }))
app.use((_req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store'); next() })
const attempts = new Map<string, { time: number; count: number }>()
app.use('/api', (req, _res, next) => {
  if (req.query.symbol !== undefined) engine.stock(String(req.query.symbol))
  const key = `${req.ip}:${req.path.startsWith('/auth') ? 'auth' : 'api'}`
  let entry = attempts.get(key)
  if (!entry || Date.now() - entry.time > 60_000) { entry = { time: Date.now(), count: 0 }; attempts.set(key, entry) }
  if (++entry.count > (req.path.startsWith('/auth') ? 30 : 240)) return next(new MarketError('操作过于频繁，请稍后重试', 429))
  next()
})
const readAccount = (req: express.Request) => authenticate(req.headers.authorization?.replace(/^Bearer /, ''))
const admin = (req: express.Request) => { const account = readAccount(req); if (account.role !== 'admin') throw new MarketError('此操作仅限市场管理员', 403); return account }
const requestedSymbol = (req: express.Request) => req.query.symbol === undefined ? DEFAULT_SYMBOL : String(req.query.symbol)
const viewFor = (req: express.Request, id: string) => engine.view(id, requestedSymbol(req))
app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0', round: engine.state.round }))
app.post('/api/auth/guest', (req, res) => {
  engine.stock(requestedSymbol(req))
  const humans = engine.state.accounts.filter(a => a.role !== 'bot')
  if (humans.length >= 200) throw new MarketError('本地市场账户已达上限，请登录已有账户')
  const account = engine.createAccount(`练习者 ${String(humans.length + 1).padStart(2, '0')}`, humans.length ? 'trader' : 'admin')
  const token = session(account.id)
  save(); res.json({ token, snapshot: viewFor(req, account.id) }); broadcast()
})
const credentials = (body: unknown) => {
  const { username, password } = (body ?? {}) as { username: unknown; password: unknown }
  if (typeof username !== 'string' || !/^[\p{L}\p{N}_-]{2,20}$/u.test(username)) throw new MarketError('用户名须为 2–20 个中文、字母、数字、下划线或短横线')
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw new MarketError('密码须为 8–128 个字符')
  return { username, password }
}
app.post('/api/auth/register', (req, res) => {
  const account = readAccount(req), { username, password } = credentials(req.body)
  if (account.username) throw new MarketError('当前账户已经注册')
  if (engine.state.accounts.some(a => a.username?.toLowerCase() === username.toLowerCase())) throw new MarketError('用户名已被使用')
  account.username = username; account.name = username; account.passwordHash = passwordHash(password)
  save(); res.json({ snapshot: viewFor(req, account.id) }); broadcast()
})
app.post('/api/auth/login', (req, res) => {
  const { username, password } = credentials(req.body)
  const account = engine.state.accounts.find(a => a.username?.toLowerCase() === username.toLowerCase())
  if (!account?.passwordHash || !verifyPassword(password, account.passwordHash)) throw new MarketError('用户名或密码不正确', 401)
  const token = session(account.id); save(); res.json({ token, snapshot: viewFor(req, account.id) })
})
app.post('/api/auth/logout', (req, res) => {
  readAccount(req)
  delete engine.state.sessions[hash(req.headers.authorization!.replace(/^Bearer /, ''))]
  save(); res.json({ ok: true })
})
app.get('/api/state', (req, res) => res.json(viewFor(req, readAccount(req).id)))
app.post('/api/admin/equity', (req, res) => {
  const account = admin(req)
  if (!req.body || Object.keys(req.body).some(key => !['targetEquity', 'reason', 'requestId', 'round'].includes(key))) throw new MarketError('只能调整自己的总资产，请提供金额和原因')
  if (req.body.round !== engine.state.round) throw new MarketError('练习轮次已改变，请重新打开资产调整', 409)
  engine.stock(requestedSymbol(req))
  const adjustment = engine.adjustEquity(account.id, req.body)
  save(); res.json({ adjustment, snapshot: viewFor(req, account.id) }); broadcast()
})
app.post('/api/orders', (req, res) => {
  const account = readAccount(req)
  if (!req.body || typeof req.body !== 'object') throw new MarketError('订单内容无效')
  const order = engine.submit(account.id, req.body)
  save(); res.json({ order, snapshot: viewFor(req, account.id) }); broadcast()
})
app.delete('/api/orders/:id', (req, res) => {
  const account = readAccount(req)
  const order = engine.cancel(account.id, String(req.params.id))
  save(); res.json({ order, snapshot: viewFor(req, account.id) }); broadcast()
})
app.patch('/api/market', (req, res) => {
  const account = admin(req)
  if (Object.keys(req.body ?? {}).some(key => !['speed', 'paused'].includes(key))) throw new MarketError('交易规则只能在新一轮练习中切换')
  engine.configure(req.body); save(); res.json(viewFor(req, account.id)); broadcast()
})
app.post('/api/market/next-day', (req, res) => { const account = admin(req); engine.nextDay(); save(); res.json(viewFor(req, account.id)); broadcast() })
app.post('/api/market/reset', (req, res) => {
  const account = admin(req)
  const before = JSON.stringify(engine.state)
  const previousState = engine.state
  const operationCount = engine.operations.length
  const previousRound = engine.state.round
  engine.reset(req.body?.mode, req.body?.botCount, req.body?.feesEnabled)
  try {
    save(() => db.prepare('INSERT INTO rounds(id,created_at,json) VALUES(?,?,?)').run(previousRound, new Date().toISOString(), JSON.stringify(previousState)))
  } catch (error) { engine.state = JSON.parse(before); engine.rebuildIndexes(); engine.operations.length = operationCount; throw error }
  res.json(viewFor(req, account.id)); broadcast()
})
app.get('/api/rounds', (req, res) => {
  const account = readAccount(req)
  const rows = db.prepare('SELECT id,created_at,json FROM rounds ORDER BY id DESC LIMIT 20').all() as unknown as { id: number; created_at: string; json: string }[]
  res.json(rows.flatMap(row => {
    const archived = new MarketEngine(JSON.parse(row.json))
    if (!archived.state.accounts.some(a => a.id === account.id)) return []
    const snapshot = archived.view(account.id)
    return [{ id: row.id, createdAt: row.created_at, mode: snapshot.config.mode, account: snapshot.account, lastPrice: snapshot.stock.price }]
  }))
})
const monitorEngine = (req: express.Request) => {
  admin(req)
  if (req.query.round === undefined) return engine
  const round = Number(req.query.round)
  if (!Number.isSafeInteger(round) || round < 1) throw new MarketError('练习轮次无效')
  if (round === engine.state.round) return engine
  const row = db.prepare('SELECT json FROM rounds WHERE id=?').get(round) as { json: string } | undefined
  if (!row) throw new MarketError('找不到该轮练习', 404)
  return new MarketEngine(JSON.parse(row.json))
}
app.get('/api/admin/accounts', (req, res) => {
  const market = monitorEngine(req)
  const rows = db.prepare('SELECT id,json_extract(json,\'$.config.mode\') AS mode FROM rounds ORDER BY id DESC LIMIT 100').all()
  res.json({ round: market.state.round, time: market.state.time, price: market.stock().lastPrice,
    current: market === engine, accounts: market.state.accounts.map(a => market.accountSummary(a.id)),
    rounds: [{ id: engine.state.round, mode: engine.state.config.mode }, ...rows],
  })
})
app.get('/api/admin/accounts/:id', (req, res) => {
  const market = monitorEngine(req), accountId = String(req.params.id)
  const account = market.accountSummary(accountId)
  const history = monitor.history(market.state.round, accountId, String(req.query.type ?? 'all'), req.query.before === undefined ? undefined : Number(req.query.before))
  res.json({ round: market.state.round, time: market.state.time, account,
    pending: market.state.orders.filter(o => o.accountId === accountId && ['open', 'partial'].includes(o.status)),
    ...history, fundingAdjustments: market.account(accountId).fundingAdjustments,
  })
})
if (existsSync(resolve(root, 'dist/index.html'))) {
  app.use(express.static(resolve(root, 'dist')))
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(root, 'dist/index.html')))
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (!(error instanceof MarketError)) console.error(error)
  res.status(error instanceof MarketError ? error.status : 500).json({ error: error instanceof MarketError ? error.message : '服务暂时异常，请稍后重试' })
})
const server = createServer(app)
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 })
const clients = new Map<WebSocket, { token: string; symbol: string }>()
wss.on('connection', ws => {
  const timeout = setTimeout(() => { if (!clients.has(ws)) ws.close(4001, 'Authentication required') }, 5000)
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString())
      authenticate(message.token)
      const symbol = message.symbol ?? DEFAULT_SYMBOL
      engine.stock(symbol)
      clients.set(ws, { token: message.token, symbol })
      clearTimeout(timeout)
      ws.send(JSON.stringify(engine.view(authenticate(message.token).id, symbol)))
    } catch { ws.close(4001, 'Invalid session') }
  })
  ws.on('close', () => { clients.delete(ws); clearTimeout(timeout) })
  ws.on('error', () => { clients.delete(ws); clearTimeout(timeout) })
})
function broadcast() {
  for (const [ws, client] of clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_000_000) continue
    try { ws.send(JSON.stringify(engine.view(authenticate(client.token).id, client.symbol))) }
    catch { ws.close(4001, 'Invalid session'); clients.delete(ws) }
  }
}
const tick = setInterval(() => {
  if (!clients.size && !hasPendingAdminAccess(db)) return
  try { if (clients.size) engine.advance(engine.state.config.speed); save(); broadcast() }
  catch (error) { console.error('Market tick failed:', error); engine.state.config.paused = true; broadcast() }
}, 1000)
const cleanup = setInterval(() => {
  for (const [key, value] of attempts) if (Date.now() - value.time > 60_000) attempts.delete(key)
  for (const [key, value] of Object.entries(engine.state.sessions)) if (value.expires < Date.now()) delete engine.state.sessions[key]
}, 60_000)
const port = Number(process.env.PORT ?? 3001)
server.listen(port, '127.0.0.1', () => console.log(`MarketLab server ready at http://127.0.0.1:${port}`))
const shutdown = () => { clearInterval(tick); clearInterval(cleanup); save(); for (const client of wss.clients) client.close(); server.close(() => { db.close(); process.exit(0) }) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
