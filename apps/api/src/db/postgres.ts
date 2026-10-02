import { Pool, types } from 'pg'
import type { PoolClient } from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Db, Param } from './index.ts'
import { NestedTransactionError } from './errors.ts'
import { toPlaceholders } from './placeholders.ts'
import { migrate } from './migrate.ts'
import { pgMigrations } from './migrations/pg/index.ts'
import { DATABASE_URL, PG_POOL_MAX } from '../config.ts'

/**
 * PostgreSQL 的实现。
 *
 * 全项目只有这个文件知道底层是什么。别的文件只见 `Db` 接口。
 *
 * ## 和上一章比，少了一整层
 *
 * 事务那一章为了「一个进程只有一条连接」加了一道排队门 `withConnection`，
 * 外加一个 `AsyncLocalStorage` 用来判断「这次读写是不是事务自己的」。
 * 现在排队那一半没有了：池把连接发出去，事务天然独占它拿到的那一条。
 *
 * **但归属标记还得留。** 它解决的是另一个问题——
 * 「这次 query 该用哪条连接」。判断这件事代码不在栈上，
 * 中间隔着一个已经 await 出去的 Promise，调用栈那套判断在这里失效。
 *
 * 删的是**排队**，留的是**认领**。两件事，别混。
 *
 * ## 还多了一样东西
 *
 * `?` → `$n` 的改写。业务代码写的是 `?`，`pg` 只认 `$1`，
 * 改写放在 `placeholders.ts`（纯函数，可以单独测），
 * 由这个文件的 `query` / `one` 调用。
 */

/* ------------------------------------------------------------------ *
 * 取值归一化
 * ------------------------------------------------------------------ */

/**
 * 1184 是 timestamptz 的类型 OID。
 *
 * 默认解析出来是 JS 的 `Date`，而 `Order.createdAt` 的类型是 `z.string()`，
 * 测试和调用方都按字符串拿。**在驱动里归一，不在路由里归一**——
 * 归一化属于「让底层适配上层契约」，那是这一层的职责。
 * 放到路由里的话每条查询都得自己记得转一遍，漏一处就悄悄变了形状，
 * 而 `JSON.stringify` 会把 Date 变成和别处不一样的格式。
 */
types.setTypeParser(1184, (value: string) => new Date(value).toISOString())

/**
 * int8（OID 20）**故意不改**。
 *
 * `pg` 默认把 bigint 解析成**字符串**，因为 JS 的 number 撑不住 64 位整数，
 * 悄悄转成 number 会在 2^53 之后开始丢精度。
 *
 * 本项目全表用 INTEGER（int4），取回来是 number，所以不受影响。
 * 但要记住这条：哪天给金额换成 BIGINT，`COUNT(*)`、`SUM()`、
 * `bigserial` 主键会一起变成字符串，症状是接口返回的 id 变成 `"1"`。
 * 两条出路：继续用 int4，或者 `types.setTypeParser(20, Number)`。
 */

/* ------------------------------------------------------------------ *
 * 池
 * ------------------------------------------------------------------ */

export const pool = new Pool({
  connectionString: DATABASE_URL,
  // 池大小按「同时最多有几个请求在跑」定，不是按机器核数定。
  // 每一个连接都是一条到数据库的网络往返，机器有多少核跟它没关系。
  max: PG_POOL_MAX,
  // 空闲连接不白占着。设 0 等于用完立刻关，那等于没有池。
  idleTimeoutMillis: 30_000,
})

/**
 * 事务期间认领到的那条连接。没有标记就是不在事务里。
 *
 * 换库之后**只剩这一个用途**：认领。上一章它还兼着「排队」，
 * 那一半已经删掉了。
 */
const claimed = new AsyncLocalStorage<PoolClient>()

/**
 * 拿一条连接跑 fn。
 *
 * 在事务里就用事务那条；不在事务里就从池里借一条，用完还回去。
 * **这里没有排队**——池自己管并发，等连接是池内部的事。
 */
async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const mine = claimed.getStore()
  if (mine !== undefined) return fn(mine)

  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

/* ------------------------------------------------------------------ *
 * 三个方法
 * ------------------------------------------------------------------ */

export const db: Db = {
  async query<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    const res = await withClient((c) => c.query(toPlaceholders(sql), [...params]))
    // pg 的 query() 失败时抛错，成功时不看 rowCount。
    // 写语句靠 RETURNING 拿新行；没有 RETURNING 的写语句返回空数组，
    // 和 node:sqlite 的 all() 行为一致，业务代码不用改判断。
    return res.rows as T[]
  },

  async one<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
    const res = await withClient((c) => c.query(toPlaceholders(sql), [...params]))
    return res.rows[0] as T | undefined
  },

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // 嵌套判据是「我自己是不是已经在事务体里」，不是「池里还有没有空连接」。
    if (claimed.getStore() !== undefined) throw new NestedTransactionError()

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await claimed.run(client, () => fn(db))
      await client.query('COMMIT')
      return result
    } catch (err) {
      // 回滚失败**不能顶替**原始错误——和事务那一章同一条教训。
      // 没有活动事务时 ROLLBACK 自己会抛，让那句话说出去的话，
      // 调用方原本的 409 OUT_OF_STOCK 就变成了 500 INTERNAL_ERROR。
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        console.error('[db] 回滚失败，事务状态可能已经不对了：', rollbackErr)
      }
      throw err
    } finally {
      // 必须放 finally。放错位置的话回滚路径下连接不还回去，
      // 池会被耗光，之后所有请求排队等到超时。
      client.release()
    }
  },
}

export async function closeDb(): Promise<void> {
  await pool.end()
}

/**
 * 启动时把库推到最新版本。
 *
 * 用模块顶层的 await 是有意的：模块没加载完，import 它的人就拿不到 db，
 * 于是「迁移还没跑完就开始收请求」这件事在结构上就不可能发生。
 * 迁移失败（checksum 对不上、SQL 写错）会让这里直接抛，
 * 进程带着非 0 退出，不会带着一个半成品库对外服务。
 */
await migrate(db, pgMigrations)
