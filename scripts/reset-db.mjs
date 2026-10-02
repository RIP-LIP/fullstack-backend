/**
 * 把开发库清空。
 *
 * **不可恢复。** 库里的表、迁移记录、数据全没了。
 *
 * 用法：
 *   npm run db:reset
 *
 * ## 换库之后它变了个样子
 *
 * SQLite 时代它就是删一个文件。现在要 DROP 整个数据库，
 * 而 DROP DATABASE 不能在目标库里面执行——所以先连到 `postgres` 那个库，
 * 那是 PostgreSQL 官方镜像自带的，永远存在。
 *
 * 只碰 DATABASE_URL 指的那个库，不会动别的。名字在动手之前会打印出来。
 */

import { Client } from 'pg'

// 局部变量**不能叫 URL**：那会遮蔽全局的 URL 构造器，
// 于是下一行 `new URL(...)` 报「不是构造函数」，运行时也一样炸。
// 写这个文件的第一版就是这么错的，被 tsc 抓到的。
const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'
const dbName = new URL(DB_URL).pathname.replace(/^\//, '')

if (!process.argv.includes('--yes')) {
  console.error(`这会删掉整个数据库：${dbName}`)
  console.error('里面的表、迁移记录、数据全都没了，而且恢复不了。')
  console.error('确认了就加 --yes：')
  console.error(`  npm run db:reset -- --yes`)
  process.exit(1)
}

const adminUrl = new URL(DB_URL)
adminUrl.pathname = '/postgres'

const admin = new Client({ connectionString: adminUrl.toString() })
await admin.connect()
try {
  // WITH (FORCE)：你还开着 dev:api 的话，连接挂着 DROP 会失败。
  // FORCE 会把那些连接一起踢掉——也就是说服务会被打断，那正是「重置」的意思。
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
  await admin.query(`CREATE DATABASE "${dbName}"`)
  console.log(`数据库 ${dbName} 已清空。下次 npm run dev:api 会重建表并跑迁移。`)
} finally {
  await admin.end()
}
