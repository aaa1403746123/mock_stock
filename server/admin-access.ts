import type { DatabaseSync } from 'node:sqlite'
import type { EngineState } from '../src/shared/types.ts'

// Local maintenance only: no HTTP endpoint can request a role grant.
export function initAdminAccess(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_admin_grants (
    id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, account_name TEXT NOT NULL,
    requested_at TEXT NOT NULL, applied_at TEXT, result TEXT
  )`)
}
export function requestAdminAccess(db: DatabaseSync, identity: string) {
  const row = db.prepare('SELECT json FROM state WHERE id=1').get() as { json: string } | undefined
  if (!row) throw new Error('市场尚未创建，请先启动服务')
  const state = JSON.parse(row.json) as EngineState
  const matches = state.accounts.filter(a => a.id === identity || a.name === identity || a.username === identity)
  if (matches.length !== 1) throw new Error('未找到唯一账户，请使用完整账户编号')
  const account = matches[0]!
  if (account.role === 'bot') throw new Error('机器人不能成为管理员')
  if (account.role !== 'admin') {
    db.prepare('INSERT INTO local_admin_grants(account_id,account_name,requested_at) VALUES(?,?,?)')
      .run(account.id, account.name, new Date().toISOString())
  }
  return { id: account.id, name: account.name, alreadyAdmin: account.role === 'admin' }
}
export function hasPendingAdminAccess(db: DatabaseSync) {
  return !!db.prepare('SELECT 1 FROM local_admin_grants WHERE applied_at IS NULL LIMIT 1').get()
}
export function applyAdminAccess(db: DatabaseSync, state: EngineState) {
  const grants = db.prepare('SELECT id,account_id FROM local_admin_grants WHERE applied_at IS NULL ORDER BY id').all() as { id: number; account_id: string }[]
  const previous = new Map<string, 'admin' | 'trader'>()
  for (const grant of grants) {
    const account = state.accounts.find(a => a.id === grant.account_id && a.role !== 'bot')
    if (account) {
      if (!previous.has(account.id)) previous.set(account.id, account.role as 'admin' | 'trader')
      account.role = 'admin'
    }
    db.prepare('UPDATE local_admin_grants SET applied_at=?,result=? WHERE id=?')
      .run(new Date().toISOString(), account ? 'granted' : 'account_unavailable', grant.id)
  }
  return () => { for (const [id, role] of previous) { const account = state.accounts.find(a => a.id === id); if (account) account.role = role } }
}
