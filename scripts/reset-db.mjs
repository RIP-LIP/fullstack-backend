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

/**
 * 碰都不能碰的三个库。
 *
 * `postgres` 是官方镜像自带的、连上去执行 DROP 的那个；
 * `template0` / `template1` 是建新库的模板。
 * 这三个删掉之后，PostgreSQL 实例就废了——不是「数据没了」，
 * 是「连不上了」，恢复要走官方文档重来。
 *
 * **为什么这里需要一道名字闸，而 `drop-test-dbs.mjs` 用的是白名单：**
 * 那两个脚本的破坏力是对称的——`db:reset` 删的是**你自己的开发库**，
 * 这是它的用途；`drop-test-dbs` 删的是**测试库**，也是它的用途。
 * 但 `db:reset` 认的是 `DATABASE_URL`，那个环境变量可能指向任何地方：
 * 同事的库、CI 的库、某个生产只读副本的连接串。
 * 一旦指错，`--yes` 一次就不可恢复。
 *
 * 所以它需要的是**拒绝指定的几个**，不是「只允许某个模式」——
 * 开发库的库名是项目定的，不该由这个脚本规定。
 */
const FORBIDDEN = new Set(['postgres', 'template0', 'template1'])

if (FORBIDDEN.has(dbName)) {
  console.error(`拒绝执行：${dbName} 不能删。`)
  console.error('  postgres     是执行 DROP 时连的那个库本身')
  console.error('  template0/1  是建新库的模板，删掉整个实例就废了')
  console.error('如果 DATABASE_URL 指错了，改对之后再跑。')
  process.exit(1)
}

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
