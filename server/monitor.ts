import type { DatabaseSync } from 'node:sqlite'
import type { AccountOperation, EngineState, OperationType } from '../src/shared/types.ts'
import { MarketError } from './engine.ts'
import { DEFAULT_SYMBOL } from '../src/shared/rules.ts'

/** The trading snapshot can be compacted; the administrator's immutable ledger cannot. */
export class MonitorStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS account_operations (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      round INTEGER NOT NULL, account_id TEXT NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS operations_account_round ON account_operations(round, account_id, cursor DESC);
    CREATE INDEX IF NOT EXISTS operations_account_type ON account_operations(round, account_id, type, cursor DESC);
    CREATE TABLE IF NOT EXISTS monitor_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }
  append(operations: AccountOperation[]) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO account_operations(id, round, account_id, type, json) VALUES(?,?,?,?,?)')
    for (const operation of operations) insert.run(operation.id, operation.round, operation.accountId, operation.type, JSON.stringify(operation))
  }
  needsBackfill() { return !this.db.prepare("SELECT 1 FROM monitor_meta WHERE key='legacy-backfill-v1'").get() }
  backfill(states: EngineState[]) {
    if (!this.needsBackfill()) return
    this.db.exec('BEGIN')
    try {
      for (const state of states) {
        const operations: AccountOperation[] = state.orders.map(order => ({
          id: `${state.round}:snapshot:${order.id}`, symbol: order.symbol ?? DEFAULT_SYMBOL, round: state.round, accountId: order.accountId, time: order.createdAt,
          type: 'snapshot', orderId: order.id, side: order.side, kind: order.kind, price: order.price,
          quantity: order.quantity, remaining: order.remaining, status: order.status, fee: order.fee,
          reason: '升级前的委托状态快照，时间为委托创建时间', cashAfter: null, sharesAfter: null, realizedAfter: null,
        }))
        const orders = new Map(state.orders.map(o => [o.id, o]))
        for (const trade of state.trades) {
          for (const side of ['buy', 'sell'] as const) {
            const accountId = side === 'buy' ? trade.buyAccountId : trade.sellAccountId
            const orderId = side === 'buy' ? trade.buyOrderId : trade.sellOrderId
            operations.push({
              id: `${state.round}:fill:${trade.id}:${accountId}`, symbol: trade.symbol ?? DEFAULT_SYMBOL, round: state.round, accountId, time: trade.time,
              type: 'fill', orderId, side, kind: orders.get(orderId)?.kind ?? 'limit', price: trade.price,
              quantity: trade.quantity, remaining: 0, status: 'filled', fee: null,
              reason: '历史成交回填；当时余额及单笔费用未记录', cashAfter: null, sharesAfter: null, realizedAfter: null,
            })
          }
        }
        operations.sort((a, b) => a.time - b.time || (a.type === 'snapshot' ? -1 : 1))
        this.append(operations)
        this.db.prepare('INSERT OR REPLACE INTO monitor_meta(key,value) VALUES(?,?)').run(`legacy-round-${state.round}`, '1')
      }
      this.db.prepare("INSERT INTO monitor_meta(key,value) VALUES('legacy-backfill-v1','1')").run()
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  history(round: number, accountId: string, type: string, before?: number) {
    if (!['all', 'submit', 'fill', 'cancel', 'snapshot'].includes(type)) throw new MarketError('操作类型无效')
    if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) throw new MarketError('分页位置无效')
    const params: (number | string)[] = [round, accountId]
    let where = 'round=? AND account_id=?'
    if (type !== 'all') { where += ' AND type=?'; params.push(type as OperationType) }
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM account_operations WHERE ${where}`).get(...params) as { count: number }).count
    if (before !== undefined) { where += ' AND cursor<?'; params.push(before) }
    const rows = this.db.prepare(`SELECT cursor,json FROM account_operations WHERE ${where} ORDER BY cursor DESC LIMIT 51`).all(...params) as { cursor: number; json: string }[]
    const operations = rows.slice(0, 50).map(row => { const operation = JSON.parse(row.json) as AccountOperation; return { ...operation, symbol: operation.symbol ?? DEFAULT_SYMBOL, cursor: row.cursor } })
    return {
      operations, total, nextCursor: rows.length > 50 ? operations.at(-1)!.cursor : null,
      legacy: !!this.db.prepare('SELECT 1 FROM monitor_meta WHERE key=?').get(`legacy-round-${round}`),
    }
  }
}
