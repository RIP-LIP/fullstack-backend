import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import type { DatabaseSync } from 'node:sqlite'
import type { Db } from '../src/db/index.ts'

/**
 * 集成测试的公共启动逻辑。
 *
 * 四条约定，每条都对应一类「跑测试把开发环境搞坏」的方式：
 *
 * 1. 临时数据库。DB_PATH 指向 mkdtemp 出来的目录，所以测试碰不到
 *    apps/api/data/app.db 里的开发数据。
 * 2. 临时端口。listen(0) 让系统给一个空端口，可以一边跑测试一边跑
 *    npm run dev:api，不用抢 3002。
 * 3. 动态 import。ESM 的 import 会被提升到文件顶部，DB_PATH 就来不及设了。
 *    所以 createApp 必须在 start() 内部 await 进来。
 * 4. 先关库再删目录。db/sqlite.ts 的连接是模块级单例，不关的话
 *    Windows 上文件被锁住，rmSync 会报 EPERM。
 *
 * 之所以抽成文件而不是每个测试文件各写一遍：三组测试的启动代码完全一样，
 * 抄三份就意味着以后改启动方式要改三处，漏一处就是一组测试行为不一样。
 */

export type Harness = {
  baseUrl: string
  rawDb: DatabaseSync
  db: Db
  close: () => Promise<void>
}

export async function startHarness(): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'backend-test-'))
  process.env.DB_PATH = join(tempDir, 'test.db')

  const { createApp } = await import('../src/app.ts')
  const { closeDb, rawDb, db } = await import('../src/db/sqlite.ts')
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
    rawDb,
    db,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
      closeDb()
      rmSync(tempDir, { recursive: true, force: true })
      delete process.env.DB_PATH
    },
  }
}

export type ProductBody = {
  id: number
  sku: string
  name: string
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

/** 发一个请求，返回状态码和解析后的错误体。 */
export async function call(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: ErrorBody }> {
  const res = await fetch(`${baseUrl}${path}`, init)
  return { status: res.status, body: (await res.json()) as ErrorBody }
}
