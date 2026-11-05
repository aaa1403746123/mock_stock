import type { DatabaseSync } from 'node:sqlite'
import type { Account, EngineState } from '../src/shared/types.ts'
import type { MarketEngine } from './engine.ts'

export function initBasePositions(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_base_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, quantity INTEGER NOT NULL,
    requested_at TEXT NOT NULL, applied_at TEXT, result TEXT
  )`)
}
export function requestBasePositions(db: DatabaseSync, identity: string, quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw new Error('底仓数量须为 1–1,000,000 股')
  const row = db.prepare('SELECT json FROM state WHERE id=1').get() as { json: string } | undefined
  if (!row) throw new Error('市场尚未创建')
  const state = JSON.parse(row.json) as EngineState
  const matches = state.accounts.filter(a => a.id === identity || a.name === identity || a.username === identity)
  if (matches.length !== 1 || matches[0]!.role === 'bot') throw new Error('请提供唯一的真人账户名称或编号')
  const account = matches[0]!
  if (!db.prepare('SELECT 1 FROM local_base_positions WHERE account_id=? AND quantity=? AND applied_at IS NULL').get(account.id, quantity)) {
    db.prepare('INSERT INTO local_base_positions(account_id,quantity,requested_at) VALUES(?,?,?)').run(account.id, quantity, new Date().toISOString())
  }
  return { id: account.id, name: account.name, quantity }
}
export function hasPendingBasePositions(db: DatabaseSync) {
  return !!db.prepare('SELECT 1 FROM local_base_positions WHERE applied_at IS NULL LIMIT 1').get()
}
// Runs in the snapshot transaction; the caller invokes undo if committing fails.
export function applyBasePositions(db: DatabaseSync, engine: MarketEngine) {
  const requests = db.prepare('SELECT id,account_id,quantity FROM local_base_positions WHERE applied_at IS NULL ORDER BY id').all() as { id: number; account_id: string; quantity: number }[]
  const previous = new Map<string, Account>(), sequence = engine.state.seq
  const undo = () => {
    for (const [id, account] of previous) engine.state.accounts[engine.state.accounts.findIndex(a => a.id === id)] = account
    engine.state.seq = sequence
    if (previous.size) engine.rebuildIndexes()
  }
  try {
    for (const request of requests) {
      const account = engine.state.accounts.find(a => a.id === request.account_id && a.role !== 'bot')
      if (account) {
        if (!previous.has(account.id)) previous.set(account.id, structuredClone(account))
        engine.seedBasePositions(account.id, request.quantity)
      }
      db.prepare('UPDATE local_base_positions SET applied_at=?,result=? WHERE id=?').run(new Date().toISOString(), account ? 'applied' : 'account_unavailable', request.id)
    }
    return undo
  } catch (error) { undo(); throw error }
}
