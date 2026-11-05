import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { initBasePositions, requestBasePositions } from './base-positions.ts'

const identity = process.argv[2], quantity = Number(process.argv[3] ?? 200000)
if (!identity || process.argv.length > 4) throw new Error('用法：npm run portfolio:seed -- "账户名称或编号" [每只股票底仓股数]')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = resolve(process.env.MARKET_DATA_DIR ?? resolve(root, 'data'), 'market.sqlite')
if (!existsSync(path)) throw new Error('未找到市场数据库，请先启动服务')
const db = new DatabaseSync(path)
try {
  db.exec('PRAGMA busy_timeout=5000'); initBasePositions(db)
  const account = requestBasePositions(db, identity, quantity)
  console.log(`已为 ${account.name} 提交每只股票 ${quantity.toLocaleString()} 股底仓配置，服务将自动补足并保留原有更高仓位。`)
} finally { db.close() }
