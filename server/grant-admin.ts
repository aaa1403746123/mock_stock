import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { initAdminAccess, requestAdminAccess } from './admin-access.ts'

const identity = process.argv[2]
if (!identity || process.argv.length !== 3) throw new Error('用法：npm run admin:grant -- "账户名称或编号"')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = resolve(process.env.MARKET_DATA_DIR ?? resolve(root, 'data'), 'market.sqlite')
if (!existsSync(path)) throw new Error('未找到市场数据库，请先启动服务')
const db = new DatabaseSync(path)
try {
  db.exec('PRAGMA busy_timeout=5000')
  initAdminAccess(db)
  const account = requestAdminAccess(db, identity)
  console.log(account.alreadyAdmin ? `${account.name} 已是管理员` : `已提交 ${account.name} 的管理员授权，运行中的服务将自动应用；未启动时在下次启动生效。`)
} finally { db.close() }
