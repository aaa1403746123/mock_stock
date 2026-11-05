import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MarketEngine } from './engine.ts'
import { applyAdminAccess, hasPendingAdminAccess, initAdminAccess, requestAdminAccess } from './admin-access.ts'

test('local admin recovery changes only the requested human role and rolls back with its transaction', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const market = new MarketEngine(undefined, { botCount: 0, warmup: false })
    const owner = market.createAccount('owner', 'admin')
    const visitor = market.createAccount('visitor')
    const bot = market.createAccount('bot', 'bot')
    db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, json TEXT NOT NULL)')
    db.prepare('INSERT INTO state VALUES (1,?)').run(JSON.stringify(market.state))
    initAdminAccess(db)
    const before = structuredClone(market.state)
    assert.throws(() => requestAdminAccess(db, bot.id), /机器人/)
    assert.throws(() => requestAdminAccess(db, 'unknown'), /唯一账户/)
    requestAdminAccess(db, visitor.id)
    assert.equal(hasPendingAdminAccess(db), true)
    assert.equal(visitor.role, 'trader')
    db.exec('BEGIN')
    const undo = applyAdminAccess(db, market.state)
    assert.equal(visitor.role, 'admin')
    db.exec('ROLLBACK'); undo()
    assert.deepEqual(market.state, before)
    assert.equal(hasPendingAdminAccess(db), true)
    db.exec('BEGIN')
    applyAdminAccess(db, market.state)
    db.prepare('UPDATE state SET json=? WHERE id=1').run(JSON.stringify(market.state))
    db.exec('COMMIT')
    const expected = structuredClone(before)
    expected.accounts.find(a => a.id === visitor.id)!.role = 'admin'
    assert.deepEqual(market.state, expected)
    assert.equal(owner.role, 'admin'); assert.equal(bot.role, 'bot')
    assert.equal(hasPendingAdminAccess(db), false)
    assert.equal(requestAdminAccess(db, visitor.id).alreadyAdmin, true)
    assert.equal(hasPendingAdminAccess(db), false)
  } finally { db.close() }
})
