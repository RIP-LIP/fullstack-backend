/**
 * 测试库：一人一个库，用完就删。
 *
 * ## 为什么不是一个库 + 清空
 *
 * 试过。Node 的 test runner **并行跑各个测试文件**（默认并发度是 CPU 核数），
 * 十一个文件同时 `DROP SCHEMA public CASCADE`，结果是它们互相把对方的表删了，
 * 于是到处报 `relation "products" does not exist`。
 *
 * 清空不是隔离。**每个进程一个库才是。**
 * 顺带一提：SQLite 时代之所以没这个问题，是因为那时候每个文件
 * `mkdtemp` 出一个自己的 .db 文件，隔离是白拿的。换库把这个性质弄丢了，
 * 得显式补回来。
 *
 * ## 库名怎么来的
 *
 * 从 `DATABASE_URL` 的库名推出来：`orders` → `orders_test` → `orders_test_<pid>`。
 * 所以开发库叫别的名字也照样能用，而且**永远不会碰到开发库**——
 * 实际用的库名一定带 `_test`，`assertTestDatabase` 会检查这一条。
 *
 * ## 它不负责建这个库之外的任何东西
 *
 * CREATE DATABASE 要在 `postgres` 那个库里执行（建库语句不能在目标库里跑）。
 * 那个库是 PostgreSQL 官方镜像自带的，不需要你事先建任何东西。
 *
 * ## 有一个已知的漏
 *
 * 测试进程被强杀（Ctrl+C、任务管理器）时 dispose 不会跑，
 * 会留下一个 `orders_test_<pid>` 库。清一次：
 *
 *   node scripts/drop-test-dbs.mjs
 */

import { Client } from 'pg'
import type { Db } from '../src/db/index.ts'

const DEV_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'

/** 库名必须含有这一段，否则一律拒绝。 */
const TEST_MARK = '_test'

/** 控制连接用的库。PostgreSQL 官方镜像自带，永远存在。 */
const MAINTENANCE_DB = 'postgres'

/**
 * 库名基准：`orders` -> `orders_test`。
 *
 * 显式的 `TEST_DATABASE_URL` 优先，取它的库名。
 */
function baseName(): string {
  const raw = process.env.TEST_DATABASE_URL ?? DEV_URL
  const fromUrl = new URL(raw).pathname.replace(/^\//, '')
  const name = fromUrl === '' ? 'orders' : fromUrl
  return name.includes(TEST_MARK) ? name : `${name}${TEST_MARK}`
}

/** 这个进程专属的库名。pid 保证并行跑的各个文件互不冲突。 */
export const TEST_DB_NAME = `${baseName()}_${process.pid}`

/** 这个进程专属的连接串。 */
export const TEST_DATABASE_URL = withDatabase(DEV_URL, TEST_DB_NAME)

/**
 * 库名必须含有 `_test`。
 *
 * 测试里要做 `DROP DATABASE` 这种事，连错库是**数据没了**，
 * 不是目录脏了。「靠记得别连错」显然靠不住，所以在这里拦。
 */
export function assertTestDatabase(connectionString: string): void {
  const name = new URL(connectionString).pathname.replace(/^\//, '')
  if (name.includes(TEST_MARK)) return

  throw new Error(
    [
      `拒绝连接：${name} 的库名里没有 ${TEST_MARK}。`,
      '',
      '测试会 DROP 整个数据库，连错一次开发数据就没了。',
      `所以只允许连库名含有 ${TEST_MARK} 的库。`,
      '',
      '检查 DATABASE_URL 和 TEST_DATABASE_URL。',
    ].join('\n'),
  )
}

function withDatabase(connectionString: string, name: string): string {
  const url = new URL(connectionString)
  url.pathname = `/${name}`
  return url.toString()
}

/** 拿一条连到 postgres 库的短命连接。 */
async function withMaintenance<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: withDatabase(DEV_URL, MAINTENANCE_DB) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * 备好这个进程专属的测试库，重复跑也不怕残留。
 *
 * 必须在 import 驱动**之前**调用：驱动一被 import 就立刻连库跑迁移。
 */
export async function prepareTestDatabase(): Promise<string> {
  assertTestDatabase(TEST_DATABASE_URL)

  await withMaintenance(async (client) => {
    // 同一个 pid 的旧库可能还在（上次跑崩了），先清掉再建
    await client.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`)
    await client.query(`CREATE DATABASE "${TEST_DB_NAME}"`)
  })

  return TEST_DATABASE_URL
}

/**
 * 删掉这个进程专属的测试库。
 *
 * `WITH (FORCE)` 会把还连着的连接一起踢掉——驱动的池在 close() 之后
 * 理论上已经没有连接了，但驱动抛错退出时可能漏，所以这里不指望它。
 */
export async function disposeTestDatabase(): Promise<void> {
  await withMaintenance(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`)
  })
}

/**
 * 把 public schema 整个重建，等于「这个库现在是空的」。
 *
 * 只有一个用途：`migrate.test.ts` 里要造「一个只有 001 的老库」那种场景。
 * 那个文件自己独占一个库，所以这里清空是安全的。
 *
 * 用 schema 而不是建一个新库：快得多，而且不需要额外权限。
 * 代价是只清 public schema——本项目的表全在 public 里，成立。
 */
export async function resetSchema(connectionString: string): Promise<void> {
  assertTestDatabase(connectionString)
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query('DROP SCHEMA public CASCADE')
    await client.query('CREATE SCHEMA public')
  } finally {
    await client.end()
  }
}

/**
 * 某张表有哪些列，按声明顺序。
 *
 * SQLite 那边的 `PRAGMA table_info(products)` 在 PostgreSQL 里没有对应物，
 * 这里是标准做法：查 `information_schema`。
 *
 * **换库之后只有 PG 一个方言，所以这个函数不做双分支。**
 * 需要 SQLite 版本的话，`git checkout v1.3` 那边还留着。
 *
 * 表名是**参数**不是拼进 SQL 的。表名是开发者能控制的值，
 * 而拼字符串意味着测试自己给自己开了一条注入路径——
 * 那种代码一旦被复制到业务里就是真漏洞。
 */
export async function columnsOf(db: Db, table: string): Promise<string[]> {
  const rows = await db.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position',
    [table],
  )
  return rows.map((r) => r.column_name)
}
