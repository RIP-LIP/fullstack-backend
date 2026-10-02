import type { Server } from 'node:http'
import type { Db } from '../src/db/index.ts'
import { assertTestDatabase, disposeTestDatabase, prepareTestDatabase, TEST_DATABASE_URL } from './test-db.ts'

/**
 * 集成测试的公共启动逻辑。
 *
 * 三条约定，每条都对应一类「跑测试把开发环境搞坏」的方式：
 *
 * 1. **一人一个库。** Node 的 test runner 并行跑各个测试文件，
 *    所以每个进程建一个自己的库（名字带进程号），跑完删掉。
 *    共用一个库再清空是**不行的**——并行跑的时候它们会互相把对方的表删掉。
 *    库名必须含 `_test`，不满足直接抛错退出。
 * 2. 临时端口。listen(0) 让系统给一个空端口，可以一边跑测试一边跑
 *    npm run dev:api，不用抢 3002。
 * 3. 动态 import。ESM 的 import 会被提升到文件顶部，连接串就来不及设了。
 *    而驱动一被 import 就立刻连库跑迁移——所以 createApp 和驱动都必须在
 *    start() 内部 await 进来。
 *
 * ## 换库带来的两个变化
 *
 * - **不再有 `rawDb`。** 换库之前测试可以拿 `node:sqlite` 的原始连接
 *   直接写、直接 `PRAGMA table_info`。现在没有「原始连接」这种说法了——
 *   池里的连接谁在用不归你管，而且 PostgreSQL 里 `PRAGMA` 根本不存在。
 *   所有写库都走 `db`，这也顺带证明了数据层那三个方法够用。
 * - **先建库，再 import。** 顺序反了的话迁移会跑在一个还没建的库上。
 *
 * 之所以抽成文件而不是每个测试文件各写一遍：三组测试的启动代码完全一样，
 * 抄三份就意味着以后改启动方式要改三处，漏一处就是一组测试行为不一样。
 */

export type Harness = {
  baseUrl: string
  db: Db
  close: () => Promise<void>
}

export async function startHarness(): Promise<Harness> {
  // 先备库，再设连接串，最后才 import 驱动。顺序反了必错。
  assertTestDatabase(TEST_DATABASE_URL)
  const url = await prepareTestDatabase()
  process.env.DATABASE_URL = url

  const { createApp } = await import('../src/app.ts')
  const { db, closeDb } = await import('../src/db/postgres.ts')
  const app = createApp()

  const server: Server = app.listen(0)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('拿不到监听地址，测试无法继续')
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    db,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })

      // `pool.end()` 会等所有借出去的连接还回来。
      // **代码坏掉的时候可能永远等不到**——比如事务失败路径忘了 release，
      // 那条连接就一直挂着，end() 就不返回，整个测试进程会挂到超时。
      //
      // 测试结果那时候已经报出来了，挂着的只是收尾。
      // 所以这里给它一个上界：等不到就往下走，
      // 反正后面那个 DROP DATABASE ... WITH (FORCE) 会把连接全踢掉。
      await Promise.race([
        closeDb(),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])

      // 池关了才敢删库。顺序反了 DROP DATABASE 会因为有连接而失败。
      await disposeTestDatabase()
    },
  }
}

export type ProductBody = {
  id: number
  sku: string
  name: string
  /** ch06 之后 title 也在返回，name 是老键。 */
  title: string
  priceCents: number
  stock: number
  createdAt: string
}

/** 建一个商品，返回它。sku 用递增序号，避免各条用例互相撞唯一键。 */
let skuSeq = 0
export async function createProduct(
  baseUrl: string,
  overrides: Partial<{ sku: string; name: string; priceCents: number; stock: number }> = {},
): Promise<ProductBody> {
  skuSeq += 1
  const body = {
    sku: overrides.sku ?? `SKU-${skuSeq}`,
    name: overrides.name ?? `商品 ${skuSeq}`,
    priceCents: overrides.priceCents ?? 1000,
    stock: overrides.stock ?? 10,
  }
  const res = await fetch(`${baseUrl}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status !== 201) {
    throw new Error(`建商品应当返回 201，实际 ${res.status}：${await res.text()}`)
  }
  return (await res.json()) as ProductBody
}

export type ErrorBody = {
  error: { code: string; message: string; fields?: Record<string, string> }
}

/**
 * 建一个用户，返回它的 id。
 *
 * 没有用户接口——`users` 表建了但一直没有对外的接口。
 * 测试需要它是因为订单必须属于某个用户（外键约束），所以这里直接写库。
 * 走 db 而不是 fetch，因为没有接口可调。
 */
let userSeq = 0
export async function createUser(db: Db): Promise<number> {
  userSeq += 1
  const rows = await db.query<{ id: number }>(
    'INSERT INTO users (email, created_at) VALUES (?, ?) RETURNING id',
    [`user-${userSeq}@example.test`, new Date().toISOString()],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('建用户没有返回行')
  return row.id
}

/** 发一个请求，返回状态码和解析后的错误体。 */
export async function call(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: ErrorBody }> {
  const res = await fetch(`${baseUrl}${path}`, init)
  return { status: res.status, body: (await res.json()) as ErrorBody }
}
