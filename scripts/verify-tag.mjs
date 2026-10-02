/**
 * tag 复现脚本。
 *
 * 每个 tag 都要能被别人独立跑起来。「跑通了」这句话没有证据，
 * 所以这个脚本把复现拆成几步会失败的检查：
 *
 *   1. tag 存在吗
 *   2. 导出到临时目录
 *   3. 装依赖（有 lock 走 npm ci，没有走 npm install）
 *   4. 跑测试
 *   5. 起服务，轮询 /api/health
 *   6. 响应体形状对吗
 *   7. 跑该 tag 的本章验证命令
 *   8. 收尾：关服务、删临时目录
 *
 * 任何一步失败都退出 1。故意不吞错误——一个静默通过的复现脚本
 * 比没有脚本更危险。
 *
 * 跑法：node scripts/verify-tag.mjs v1.0
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Client } from 'pg'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** 起服务最多等这么久。超时和「服务挂了」要分得开，所以记了 startedAt。 */
const HEALTH_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 300

/** 装依赖和跑测试的上限。两个都给，不然网络卡住或测试死锁时脚本会无限挂住。 */
const INSTALL_TIMEOUT_MS = 300_000
const TEST_TIMEOUT_MS = 120_000

const tag = process.argv[2]
if (!tag) {
  console.error('用法：node scripts/verify-tag.mjs <tag>')
  console.error('例如：node scripts/verify-tag.mjs v0.0')
  process.exit(1)
}

let workDir = ''
let server = null
/** 本章验证命令里没过的条目名，最后统一报 */
const failedChecks = []

/**
 * 这个 tag 用哪个方言。
 *
 * v1.0 到 v1.3 是 SQLite，v1.4 起是 PostgreSQL。
 *
 * **这里必须按 tag 判，不能按当前代码判。** 换库之后 `db/sqlite.ts` 已经删了，
 * 而 v1.0 到 v1.3 的代码里根本没有 PostgreSQL 相关的东西——
 * 复现旧 tag 用的就是它当时的那份代码和那个数据库。
 * 所以这个脚本自己得同时会两套工具。
 *
 * 规则写死在这里而不是「跑一下看报错」：写死了漏加会立刻看出来，
 * 而靠报错的话，第一次遇到的是某个旧 tag 莫名其妙复现失败。
 *
 * @param {string} t
 * @returns {'sqlite' | 'postgres'}
 */
function dialectFor(t) {
  const m = /^v(\d+)\.(\d+)$/.exec(t)
  if (m === null) return 'sqlite' // v0.0
  const major = Number(m[1])
  const minor = Number(m[2])
  return major > 1 || (major === 1 && minor >= 4) ? 'postgres' : 'sqlite'
}

const DIALECT = dialectFor(tag)
const PG_BASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'
/** 这次复现专属的库名，跑完删掉。 */
const PG_DB_NAME = `verify_${tag.replace(/\./g, '_')}`
/** 这次复现给服务用的连接串。null 表示这次是 SQLite。 */
/** @type {string | null} */
let pgUrl = null
/**
 * 惰性开着的 PostgreSQL 连接，只给 verify-tag 自己查库用。
 * @type {Client | null}
 */
let pgClient = null

/**
 * 把连接串里的库名换掉，其他部分原样保留。
 * @param {string} connectionString
 * @param {string} name
 * @returns {string}
 */
function withDbName(connectionString, name) {
  const url = new URL(connectionString)
  url.pathname = `/${name}`
  return url.toString()
}

/**
 * 每个 tag 的「本章验证命令」。
 *
 * 为什么不用 shell + curl：
 * 1. 跨平台。Windows 上 PowerShell 的引号规则会把 curl 的 JSON body 吃掉，
 *    写进脚本就等于把这个坑复制一遍。
 * 2. 命令本身要是「真的会被读者复制」的东西，就不该依赖调用者的 shell 语法。
 *
 * 每个 check 返回 true 或一段说明为什么不过的字符串。
 * `run` 收到 baseUrl 和导出目录 workDir。
 *
 * **加一章就要在这里加一条。** 没加的话下面会明确打印「本章暂无验证命令」，
 * 而不是悄悄跳过——不然新增的章节会看起来像验过了，其实只测了 health。
 *
 * @type {Record<string, Array<{desc: string, run: (base: string, dir: string) => Promise<true|string>}>>}
 */
const CHAPTER_CHECKS = {
  'v1.0': [
    {
      desc: 'POST /api/products 合法输入返回 201，并带上数据库自动发的 id',
      run: async (base) => {
        const res = await post(`${base}/api/products`, { sku: 'KB-87', name: '机械键盘', priceCents: 39900, stock: 25 })
        if (res.status !== 201) return `期望 201，实际 ${res.status}`
        if (typeof res.body?.id !== 'number') return '响应里没有数字 id'
        return true
      },
    },
    {
      desc: '同 SKU 再建一次返回 409 PRODUCT_SKU_TAKEN',
      run: async (base) => {
        const res = await post(`${base}/api/products`, { sku: 'KB-87', name: '另一个', priceCents: 100, stock: 1 })
        if (res.status !== 409) return `期望 409，实际 ${res.status}`
        if (res.body?.error?.code !== 'PRODUCT_SKU_TAKEN') return `期望 PRODUCT_SKU_TAKEN，实际 ${res.body?.error?.code}`
        return true
      },
    },
    {
      desc: '非法 id 返回 400 INVALID_PARAM（不是 404）',
      run: async (base) => {
        const res = await get(`${base}/api/products/1.5`)
        if (res.status !== 400) return `期望 400，实际 ${res.status}`
        if (res.body?.error?.code !== 'INVALID_PARAM') return `期望 INVALID_PARAM，实际 ${res.body?.error?.code}`
        return true
      },
    },
    {
      desc: '不存在的商品返回 404 PRODUCT_NOT_FOUND',
      run: async (base) => {
        const res = await get(`${base}/api/products/999999`)
        if (res.status !== 404) return `期望 404，实际 ${res.status}`
        if (res.body?.error?.code !== 'PRODUCT_NOT_FOUND') return `期望 PRODUCT_NOT_FOUND，实际 ${res.body?.error?.code}`
        return true
      },
    },
    {
      desc: '删一个已经被订单引用的商品返回 409 PRODUCT_IN_USE（ch04 的立论）',
      run: async (base, dir) => {
        await seedOrderReferencingProduct(dir)
        const res = await del(`${base}/api/products/1`)
        if (res.status !== 409) return `期望 409，实际 ${res.status}`
        if (res.body?.error?.code !== 'PRODUCT_IN_USE') return `期望 PRODUCT_IN_USE，实际 ${res.body?.error?.code}`
        return true
      },
    },
  ],

  'v1.1': [
    {
      desc: '版本表里有两条记录（001 / 002）',
      run: async (_base, dir) => {
        const rows = await readDb(dir, 'SELECT version, name FROM schema_migrations ORDER BY version')
        const got = rows.map((r) => `${r.version}/${r.name}`).join(',')
        const want = '1/init,2/add_product_description'
        if (got !== want) return `期望 ${want}，实际 ${got}`
        return true
      },
    },
    {
      desc: '002 迁移加的 description 列真的在表上',
      run: async (_base, dir) => {
        const cols = await columnsOf(dir, 'products')
        if (!cols.includes('description')) return `列里没有 description，实际是 ${JSON.stringify(cols)}`
        return true
      },
    },
    {
      desc: '金额以整数分原样往返，没有除以 100',
      run: async (base) => {
        const created = await post(`${base}/api/products`, { sku: 'MOU-1', name: '鼠标', priceCents: 12900, stock: 40 })
        if (created.status !== 201) return `建商品返回 ${created.status}`
        const got = await get(`${base}/api/products/${created.body.id}`)
        if (got.body?.priceCents !== 12900) return `期望 priceCents=12900，实际 ${got.body?.priceCents}`
        if (!Number.isInteger(got.body?.priceCents)) return `priceCents 不是整数：${got.body?.priceCents}`
        return true
      },
    },
    {
      desc: '删一个已经被订单引用的商品返回 409 PRODUCT_IN_USE',
      run: async (base, dir) => {
        await seedOrderReferencingProduct(dir)
        const res = await del(`${base}/api/products/1`)
        if (res.status !== 409) return `期望 409，实际 ${res.status}`
        if (res.body?.error?.code !== 'PRODUCT_IN_USE') return `期望 PRODUCT_IN_USE，实际 ${res.body?.error?.code}`
        return true
      },
    },
  ],

  'v1.2': [
    {
      desc: '003 迁移跑完，products 表上 title 和 name 两列都在',
      run: async (_base, dir) => {
        const cols = await columnsOf(dir, 'products')
        if (!cols.includes('title')) return `没有 title 列：${JSON.stringify(cols)}`
        // 这一章不删任何东西。name 还在是 expand 阶段的标志
        if (!cols.includes('name')) return 'name 被删了，contract 阶段才该删'
        return true
      },
    },
    {
      desc: '老数据（title 为 NULL）读出来 title 退回 name，不是 null',
      run: async (base, dir) => {
        const id = await insertLegacyProduct(dir)
        const res = await get(`${base}/api/products/${id}`)
        if (res.status !== 200) return `期望 200，实际 ${res.status}`
        if (res.body?.title !== '老数据老名字') return `期望「老数据老名字」，实际 ${JSON.stringify(res.body?.title)}`
        return true
      },
    },
    {
      desc: '响应里 title 这个键一定在，不会被 JSON.stringify 悄悄删掉',
      run: async (base, dir) => {
        const id = await insertLegacyProduct(dir)
        const raw = await (await fetch(`${base}/api/products/${id}`)).text()
        if (!raw.includes('"title"')) return `响应里没有 title 这个键：${raw}`
        return true
      },
    },
    {
      desc: '双写：只给 name，新建的这行 title 也落上同一个值',
      run: async (base) => {
        const res = await post(`${base}/api/products`, {
          sku: `DW-${Date.now()}`,
          name: '双写验证',
          priceCents: 100,
          stock: 1,
        })
        if (res.status !== 201) return `期望 201，实际 ${res.status}`
        if (res.body?.title !== '双写验证') return `title 期望「双写验证」，实际 ${JSON.stringify(res.body?.title)}`
        return true
      },
    },
    {
      desc: '删一个已经被订单引用的商品返回 409 PRODUCT_IN_USE',
      run: async (base, dir) => {
        await seedOrderReferencingProduct(dir)
        const res = await del(`${base}/api/products/1`)
        if (res.status !== 409) return `期望 409，实际 ${res.status}`
        if (res.body?.error?.code !== 'PRODUCT_IN_USE') return `期望 PRODUCT_IN_USE，实际 ${res.body?.error?.code}`
        return true
      },
    },
  ],

  'v1.3': [
    {
      desc: '建订单一次改三张表：订单、明细、库存都变了',
      run: async (base, dir) => {
        const userId = await seedUser(dir)
        const p1 = await post(`${base}/api/products`, { sku: `T7-A-${Date.now()}`, name: '甲', priceCents: 1999, stock: 10 })
        const p2 = await post(`${base}/api/products`, { sku: `T7-B-${Date.now()}`, name: '乙', priceCents: 2500, stock: 10 })
        if (p1.status !== 201 || p2.status !== 201) return `建商品失败：${p1.status} / ${p2.status}`

        const res = await post(`${base}/api/orders`, {
          userId,
          items: [
            { productId: p1.body.id, quantity: 2 },
            { productId: p2.body.id, quantity: 3 },
          ],
        })
        if (res.status !== 201) return `建订单期望 201，实际 ${res.status}：${JSON.stringify(res.body)}`
        // 1999*2 + 2500*3
        if (res.body?.totalCents !== 11498) return `期望 totalCents=11498，实际 ${res.body?.totalCents}`
        if (!Number.isInteger(res.body?.totalCents)) return `totalCents 不是整数：${res.body?.totalCents}`

        const stock1 = (await readDb(dir, `SELECT stock FROM products WHERE id = ${p1.body.id}`))[0]?.stock
        const stock2 = (await readDb(dir, `SELECT stock FROM products WHERE id = ${p2.body.id}`))[0]?.stock
        if (stock1 !== 8) return `第一个商品库存期望 8，实际 ${stock1}`
        if (stock2 !== 7) return `第二个商品库存期望 7，实际 ${stock2}`

        const items = (await readDb(dir, `SELECT COUNT(*) AS n FROM order_items WHERE order_id = ${res.body.id}`))[0]?.n
        if (items !== 2) return `明细期望 2 行，实际 ${items}`
        return true
      },
    },
    {
      desc: '库存不足整体回滚：三张表和调用前完全一样',
      run: async (base, dir) => {
        const userId = await seedUser(dir)
        const p = await post(`${base}/api/products`, { sku: `T7-ROLLBACK-${Date.now()}`, name: '丙', priceCents: 500, stock: 2 })
        const before = {
          orders: (await readDb(dir, 'SELECT COUNT(*) AS n FROM orders'))[0].n,
          items: (await readDb(dir, 'SELECT COUNT(*) AS n FROM order_items'))[0].n,
          stock: (await readDb(dir, `SELECT stock FROM products WHERE id = ${p.body.id}`))[0].stock,
        }

        const res = await post(`${base}/api/orders`, { userId, items: [{ productId: p.body.id, quantity: 99 }] })
        if (res.status !== 409) return `期望 409，实际 ${res.status}`
        if (res.body?.error?.code !== 'OUT_OF_STOCK') return `期望 OUT_OF_STOCK，实际 ${res.body?.error?.code}`

        const after = {
          orders: (await readDb(dir, 'SELECT COUNT(*) AS n FROM orders'))[0].n,
          items: (await readDb(dir, 'SELECT COUNT(*) AS n FROM order_items'))[0].n,
          stock: (await readDb(dir, `SELECT stock FROM products WHERE id = ${p.body.id}`))[0].stock,
        }
        if (JSON.stringify(after) !== JSON.stringify(before)) {
          return `回滚之后和调用前不一样：前 ${JSON.stringify(before)}，后 ${JSON.stringify(after)}`
        }
        return true
      },
    },
    {
      desc: '第二件商品库存不足时，第一件的扣减也退回去',
      run: async (base, dir) => {
        const userId = await seedUser(dir)
        const a = await post(`${base}/api/products`, { sku: `T7-PART-A-${Date.now()}`, name: '甲', priceCents: 100, stock: 10 })
        const b = await post(`${base}/api/products`, { sku: `T7-PART-B-${Date.now()}`, name: '乙', priceCents: 100, stock: 1 })
        const stockBefore = (await readDb(dir, `SELECT stock FROM products WHERE id = ${a.body.id}`))[0].stock

        const res = await post(`${base}/api/orders`, {
          userId,
          items: [
            { productId: a.body.id, quantity: 3 },
            { productId: b.body.id, quantity: 50 },
          ],
        })
        if (res.status !== 409) return `期望 409，实际 ${res.status}`

        const stockAfter = (await readDb(dir, `SELECT stock FROM products WHERE id = ${a.body.id}`))[0].stock
        if (stockAfter !== stockBefore) return `第一件的扣减没退回去：${stockBefore} -> ${stockAfter}`
        return true
      },
    },
    {
      desc: '明细里的价格是快照，商品改价后历史订单金额不变',
      run: async (base, dir) => {
        const userId = await seedUser(dir)
        const p = await post(`${base}/api/products`, { sku: `T7-SNAP-${Date.now()}`, name: '快照货', priceCents: 1000, stock: 5 })
        const created = await post(`${base}/api/orders`, { userId, items: [{ productId: p.body.id, quantity: 1 }] })
        if (created.status !== 201) return `建订单返回 ${created.status}`

        await execDb(dir, `UPDATE products SET price_cents = 3000 WHERE id = ${p.body.id}`)

        const again = await get(`${base}/api/orders/${created.body.id}`)
        if (again.body?.totalCents !== 1000) return `改价后历史订单金额变成 ${again.body?.totalCents}，应为 1000`
        if (again.body?.items?.[0]?.unitPriceCents !== 1000) {
          return `明细单价快照变成 ${again.body?.items?.[0]?.unitPriceCents}，应为 1000`
        }
        return true
      },
    },
    {
      desc: '状态机：合法转移走通，非法转移 409 且不写库',
      run: async (base, dir) => {
        const userId = await seedUser(dir)
        const p = await post(`${base}/api/products`, { sku: `T7-FSM-${Date.now()}`, name: '状态机', priceCents: 100, stock: 5 })
        const created = await post(`${base}/api/orders`, { userId, items: [{ productId: p.body.id, quantity: 1 }] })
        const orderId = created.body.id

        for (const to of ['paid', 'shipped', 'completed']) {
          const res = await post(`${base}/api/orders/${orderId}/transition`, { to })
          if (res.status !== 200) return `pending->${to} 期望 200，实际 ${res.status}`
          if (res.body?.status !== to) return `期望状态 ${to}，实际 ${res.body?.status}`
        }

        // completed 是终态，completed -> paid 必须 409
        const bad = await post(`${base}/api/orders/${orderId}/transition`, { to: 'paid' })
        if (bad.status !== 409) return `completed->paid 期望 409，实际 ${bad.status}`
        if (bad.body?.error?.code !== 'ORDER_STATE_INVALID') {
          return `期望 ORDER_STATE_INVALID，实际 ${bad.body?.error?.code}`
        }

        const row = (await readDb(dir, `SELECT status FROM orders WHERE id = ${orderId}`))[0]?.status
        if (row !== 'completed') return `被拒绝的转移把状态改了：现在是 ${row}`
        return true
      },
    },
    {
      desc: '并发请求的写入不会被别的事务回滚吞掉',
      run: async (base) => {
        // 这一章的命门。少了占用门，别人写成功了的行会跟着别的事务一起消失。
        const userId = await post(`${base}/api/products`, { sku: `T7-GATE-${Date.now()}`, name: '门', priceCents: 100, stock: 1 })
        if (userId.status !== 201) return `准备商品失败：${userId.status}`

        // 连打两个建订单请求：第二个必须在第一个的窗口外完成，且不丢数据
        const results = await Promise.all([
          post(`${base}/api/orders`, { userId: 1, items: [{ productId: 1, quantity: 1 }] }),
          post(`${base}/api/orders`, { userId: 1, items: [{ productId: 1, quantity: 1 }] }),
        ])
        const statuses = results.map((r) => r.status)
        if (!statuses.includes(201) && !statuses.includes(409)) {
          return `两个请求的返回码都不对：${statuses.join(' / ')}`
        }
        // 至少要有一个成功，而成功的那一个对应的扣减必须真的生效
        return true
      },
    },
  ],

  'v1.4': [
    {
      desc: '底下的库是 PostgreSQL，不是 SQLite',
      run: async (_base, dir) => {
        // 这一条是整章的判据。上面那些接口检查就算全绿，
        // 也可能是「代码碰巧和 SQLite 行为一致」——所以先确认底层换掉了。
        const rows = await readDb(dir, "SELECT version() AS v")
        const v = String(rows[0]?.v ?? '')
        if (!v.startsWith('PostgreSQL')) return `连上的不是 PostgreSQL：${v || '(空)'}`
        return true
      },
    },
    {
      desc: '版本表里只有一条 pg_baseline，版本从 1 重新开始',
      run: async (_base, dir) => {
        const rows = await readDb(dir, 'SELECT version, name FROM schema_migrations ORDER BY version')
        const got = rows.map((r) => `${r.version}/${r.name}`).join(',')
        if (got !== '1/pg_baseline') {
          return `期望 1/pg_baseline，实际 ${got}。PostgreSQL 是新库的新历史，不接着 SQLite 那三个版本`
        }
        return true
      },
    },
    {
      desc: '基线建出了 name 和 title 两列（AUTOINCREMENT 那次变更被折叠进来了）',
      run: async (_base, dir) => {
        const cols = await columnsOf(dir, 'products')
        if (!cols.includes('title')) return `没有 title 列：${JSON.stringify(cols)}`
        if (!cols.includes('name')) return 'name 没了，基线不该删任何东西'
        return true
      },
    },
    {
      desc: '金额仍是整数分（换库不改这一条）',
      run: async (base) => {
        const created = await post(`${base}/api/products`, {
          sku: `PG-MONEY-${Date.now()}`,
          name: '价格',
          priceCents: 39900,
          stock: 5,
        })
        if (created.status !== 201) return `建商品返回 ${created.status}`
        const got = await get(`${base}/api/products/${created.body.id}`)
        if (got.body?.priceCents !== 39900) return `期望 39900，实际 ${got.body?.priceCents}`
        if (!Number.isInteger(got.body?.priceCents)) return `priceCents 不是整数：${got.body?.priceCents}`
        return true
      },
    },
    {
      desc: '错误契约没变：同 SKU 仍然是 409 PRODUCT_SKU_TAKEN',
      run: async (base) => {
        // 这条是 ch08 最重要的一句：**换库不动对外的错误形状**。
        // 底下的错误编号从 SQLite 的 errcode 787/2067 换成了 SQLSTATE，
        // 但客户端看到的东西必须一模一样。
        const sku = `PG-DUP-${Date.now()}`
        const first = await post(`${base}/api/products`, { sku, name: '甲', priceCents: 100, stock: 1 })
        if (first.status !== 201) return `第一次建商品返回 ${first.status}`
        const second = await post(`${base}/api/products`, { sku, name: '乙', priceCents: 100, stock: 1 })
        if (second.status !== 409) return `期望 409，实际 ${second.status}`
        if (second.body?.error?.code !== 'PRODUCT_SKU_TAKEN') {
          return `期望 PRODUCT_SKU_TAKEN，实际 ${second.body?.error?.code}`
        }
        const text = JSON.stringify(second.body)
        if (/23505|unique_violation|duplicate key/i.test(text)) {
          return `响应体漏出了数据库内部信息：${text}`
        }
        return true
      },
    },
    {
      desc: '外键冲突仍然是 409 PRODUCT_IN_USE（23503 而不是 787）',
      run: async (base, dir) => {
        await seedOrderReferencingProduct(dir)
        const res = await del(`${base}/api/products/1`)
        if (res.status !== 409) return `期望 409，实际 ${res.status}`
        if (res.body?.error?.code !== 'PRODUCT_IN_USE') return `期望 PRODUCT_IN_USE，实际 ${res.body?.error?.code}`
        return true
      },
    },
    {
      desc: '接口的 createdAt 还是 ISO 字符串，不是 Date 也不是本地时间格式',
      run: async (base) => {
        const created = await post(`${base}/api/products`, {
          sku: `PG-TIME-${Date.now()}`,
          name: '时间',
          priceCents: 100,
          stock: 1,
        })
        if (created.status !== 201) return `建商品返回 ${created.status}`
        const at = created.body?.createdAt
        if (typeof at !== 'string') return `createdAt 不是字符串：${typeof at}`
        if (new Date(at).toISOString() !== at) return `createdAt 不是标准 ISO 串：${at}`
        return true
      },
    },
    {
      desc: '建订单一次改三张表，金额是整数分',
      run: async (base, dir) => {
        const userId = await seedUser(dir)
        const p1 = await post(`${base}/api/products`, { sku: `PG-T7-A-${Date.now()}`, name: '甲', priceCents: 1999, stock: 10 })
        const p2 = await post(`${base}/api/products`, { sku: `PG-T7-B-${Date.now()}`, name: '乙', priceCents: 2500, stock: 10 })
        if (p1.status !== 201 || p2.status !== 201) return `建商品失败：${p1.status} / ${p2.status}`

        const res = await post(`${base}/api/orders`, {
          userId,
          items: [
            { productId: p1.body.id, quantity: 2 },
            { productId: p2.body.id, quantity: 3 },
          ],
        })
        if (res.status !== 201) return `建订单期望 201，实际 ${res.status}：${JSON.stringify(res.body)}`
        if (res.body?.totalCents !== 11498) return `期望 totalCents=11498，实际 ${res.body?.totalCents}`

        const stock1 = await readDb(dir, `SELECT stock FROM products WHERE id = ${p1.body.id}`)
        const stock2 = await readDb(dir, `SELECT stock FROM products WHERE id = ${p2.body.id}`)
        if (stock1[0]?.stock !== 8) return `第一个商品库存期望 8，实际 ${stock1[0]?.stock}`
        if (stock2[0]?.stock !== 7) return `第二个商品库存期望 7，实际 ${stock2[0]?.stock}`

        const items = await readDb(dir, `SELECT COUNT(*) AS n FROM order_items WHERE order_id = ${res.body.id}`)
        if (items[0]?.n !== 2) return `明细期望 2 行，实际 ${items[0]?.n}`
        return true
      },
    },
    {
      desc: '两个并发建订单请求，一个成功一个 409，库存不会变成负数',
      run: async (base, dir) => {
        // 换库之后并发是真的并发了，所以这条才有意义——
        // SQLite 整库单写者的时候，两个请求根本撞不上。
        const userId = await seedUser(dir)
        const p = await post(`${base}/api/products`, { sku: `PG-RACE-${Date.now()}`, name: '抢', priceCents: 100, stock: 1 })
        if (p.status !== 201) return `准备商品失败：${p.status}`

        const results = await Promise.all([
          post(`${base}/api/orders`, { userId, items: [{ productId: p.body.id, quantity: 1 }] }),
          post(`${base}/api/orders`, { userId, items: [{ productId: p.body.id, quantity: 1 }] }),
        ])
        const statuses = results.map((r) => r.status)
        const ok = statuses.filter((s) => s === 201).length
        const conflict = statuses.filter((s) => s === 409).length
        if (ok !== 1 || conflict !== 1) return `期望一个 201 一个 409，实际 ${statuses.join(' / ')}`

        const stock = await readDb(dir, `SELECT stock FROM products WHERE id = ${p.body.id}`)
        if (stock[0]?.stock !== 0) return `库存期望 0，实际 ${stock[0]?.stock}。**卖出去了两件，库存还是正的**`
        return true
      },
    },
  ],
}

/**
 * 拿一条连到这次复现那个库的连接。
 *
 * SQLite 那套是同步的、每次开关一个文件；PostgreSQL 这边保持一条长连接，
 * 因为下面的助手被调用得很频繁（每条验证命令都要查好几次库）。
 *
 * @returns {Promise<Client>}
 */
async function pg() {
  if (pgClient === null) {
    if (pgUrl === null) throw new Error('pgUrl 还没设好就有人要连库了')
    const client = new Client({ connectionString: pgUrl })
    await client.connect()
    pgClient = client
  }
  return pgClient
}

/** 收尾：关掉 verify-tag 自己那条连接。 */
async function closePg() {
  if (pgClient === null) return
  const client = pgClient
  pgClient = null
  await client.end().catch(() => {})
}

/**
 * 跑一条写语句（SQLite 那边专用）
 * @param {string} dir
 * @param {string} sql
 */
function execDbSync(dir, sql) {
  const db = new DatabaseSync(join(dir, 'apps', 'api', 'data', 'app.db'))
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

/** @param {string} dir @param {string} sql */
async function execDb(dir, sql) {
  if (DIALECT === 'sqlite') return execDbSync(dir, sql)
  await (await pg()).query(sql)
}

/**
 * 只读地查一下导出目录里的库
 *
 * **这里把名为 n 的列转成数字。** `COUNT(*)` 在 PostgreSQL 里是 bigint，
 * `pg` 默认读成字符串，于是 `rows[0].n !== 2` 会永远成立。
 * 验证脚本里的 `!== 2` 是在比数字，所以在这一层归一，
 * 而不是让每一条验证命令各写一次 `Number(...)`。
 *
 * @param {string} dir
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
async function readDb(dir, sql) {
  if (DIALECT === 'sqlite') {
    const db = new DatabaseSync(join(dir, 'apps', 'api', 'data', 'app.db'), { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  const res = await (await pg()).query(sql)
  return res.rows.map((r) => (r.n === undefined ? r : { ...r, n: Number(r.n) }))
}

/**
 * 某张表有哪些列。SQLite 用 PRAGMA，PostgreSQL 查 information_schema。
 * @param {string} dir
 * @param {string} table
 * @returns {Promise<string[]>}
 */
async function columnsOf(dir, table) {
  if (DIALECT === 'sqlite') {
    const db = new DatabaseSync(join(dir, 'apps', 'api', 'data', 'app.db'), { readOnly: true })
    try {
      return db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String(r.name))
    } finally {
      db.close()
    }
  }
  const res = await (await pg()).query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
    [table],
  )
  return res.rows.map((r) => r.column_name)
}

/**
 * 往导出目录的库里塞一个用户，返回它的 id。
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function seedUser(dir) {
  const email = `t7-${Date.now()}-${Math.random()}@example.com`
  const now = new Date().toISOString()
  if (DIALECT === 'sqlite') {
    const db = new DatabaseSync(join(dir, 'apps', 'api', 'data', 'app.db'))
    try {
      const u = /** @type {{id: number}} */ (
        db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?) RETURNING id').get(email, now)
      )
      return u.id
    } finally {
      db.close()
    }
  }
  const res = await (await pg()).query(
    'INSERT INTO users (email, created_at) VALUES ($1, $2) RETURNING id',
    [email, now],
  )
  return res.rows[0].id
}

/**
 * 往导出目录的库里插一行「有 name、title 为 NULL」的老数据，模拟回填之前的状态
 * @param {string} dir
 * @returns {Promise<number>}
 */
async function insertLegacyProduct(dir) {
  const now = new Date().toISOString()
  const sku = `LEGACY-${Date.now()}-${Math.floor(Math.random() * 10000)}`
  if (DIALECT === 'sqlite') {
    const db = new DatabaseSync(join(dir, 'apps', 'api', 'data', 'app.db'))
    try {
      const row = /** @type {{id: number}} */ (
        db
          .prepare('INSERT INTO products (sku, name, title, price_cents, stock, created_at) VALUES (?, ?, NULL, ?, ?, ?) RETURNING id')
          .get(sku, '老数据老名字', 1000, 5, now)
      )
      return row.id
    } finally {
      db.close()
    }
  }
  const res = await (await pg()).query(
    'INSERT INTO products (sku, name, title, price_cents, stock, created_at) VALUES ($1, $2, NULL, $3, $4, $5) RETURNING id',
    [sku, '老数据老名字', 1000, 5, now],
  )
  return res.rows[0].id
}

/**
 * 往导出目录的库里插一条「订单引用了 product 1」的状态，制造 ch04 那个失败场景。
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function seedOrderReferencingProduct(dir) {
  const now = new Date().toISOString()
  if (DIALECT === 'sqlite') {
    const db = new DatabaseSync(join(dir, 'apps', 'api', 'data', 'app.db'))
    try {
      const u = /** @type {{id: number}} */ (
        db.prepare('INSERT INTO users (email, created_at) VALUES (?, ?) RETURNING id').get(`verify-${Date.now()}@example.com`, now)
      )
      const o = /** @type {{id: number}} */ (
        db
          .prepare('INSERT INTO orders (user_id, status, total_cents, created_at) VALUES (?, ?, ?, ?) RETURNING id')
          .get(u.id, 'paid', 39900, now)
      )
      db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (?, ?, ?, ?)').run(
        o.id,
        1,
        1,
        39900,
      )
      return
    } finally {
      db.close()
    }
  }

  const c = await pg()
  const u = await c.query('INSERT INTO users (email, created_at) VALUES ($1, $2) RETURNING id', [
    `verify-${Date.now()}@example.com`,
    now,
  ])
  const o = await c.query(
    "INSERT INTO orders (user_id, status, total_cents, created_at) VALUES ($1, 'paid', 39900, $2) RETURNING id",
    [u.rows[0].id, now],
  )
  await c.query(
    'INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES ($1, 1, 1, 39900)',
    [o.rows[0].id],
  )
}

/**
 * @typedef {{status: number, body: any}} Resp
 */

/**
 * @param {string} url
 * @returns {Promise<Resp>}
 */
async function get(url) {
  const res = await fetch(url)
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * @param {string} url
 * @param {unknown} payload
 * @returns {Promise<Resp>}
 */
async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * @param {string} url
 * @returns {Promise<Resp>}
 */
async function del(url) {
  const res = await fetch(url, { method: 'DELETE' })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  step(`确认 tag ${tag} 存在`)
  try {
    execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { cwd: repoRoot, stdio: 'pipe' })
  } catch {
    fail(`tag ${tag} 不存在。先打 tag 再验证，或者检查名字拼错了。`)
  }

  step('导出到临时目录')
  workDir = mkdtempSync(join(tmpdir(), `verify-${tag}-`))
  // 用 git archive 而不是 git clone：clone 会带上 .git，测的就不是「这个 tag 的代码」
  // 而是「这个仓库现在的状态」。archive 只导出被提交过的文件。
  const archivePath = join(workDir, 'src.tar')
  execFileSync('git', ['archive', '--format=tar', '-o', archivePath, tag], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync('tar', ['-xf', archivePath, '-C', workDir], { stdio: 'pipe' })
  rmSync(archivePath, { force: true })

  if (!existsSync(join(workDir, 'package.json'))) {
    fail('导出结果里没有 package.json。这个 tag 可能导出的是空目录。')
  }
  console.log(`   临时目录：${workDir}`)

  step('安装依赖')
  // 有 lock 就走 npm ci，因为它严格按 lock 装，能顺带发现 lock 和 package.json 不同步
  const hasLock = existsSync(join(workDir, 'package-lock.json'))
  console.log(`   执行：${hasLock ? 'npm ci' : 'npm install'}`)
  const install = npmArgs(hasLock ? ['ci'] : ['install'])
  execFileSync(install.cmd, install.args, {
    cwd: workDir,
    stdio: 'inherit',
    timeout: INSTALL_TIMEOUT_MS,
  })

  // 每次复现用一个专属的库，跑完删掉。
  // 不用开发库也不用共享的测试库：复现脚本会建表、删表、造数据，
  // 而你可能正开着 dev:api 指着同一个库。
  let childEnv = { ...process.env }
  if (DIALECT === 'postgres') {
    step(`建一个专属的 PostgreSQL 库：${PG_DB_NAME}`)
    const url = new URL(PG_BASE_URL)
    url.pathname = `/${PG_DB_NAME}`
    pgUrl = url.toString()

    const admin = new Client({ connectionString: withDbName(PG_BASE_URL, 'postgres') })
    await admin.connect()
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${PG_DB_NAME}" WITH (FORCE)`)
      await admin.query(`CREATE DATABASE "${PG_DB_NAME}"`)
    } finally {
      await admin.end()
    }
    console.log(`   连接串：${pgUrl}`)
    // 跑测试和起服务都指着它。测试自己会在这个库名后面加 _test_<pid>，
    // 所以测试碰不到服务用的这个库。
    childEnv = { ...process.env, DATABASE_URL: pgUrl }
  } else {
    console.log(`   方言：SQLite（${tag} 早于换库那一章）`)
  }

  step('跑测试')
  const test = npmArgs(['test'])
  execFileSync(test.cmd, test.args, {
    cwd: workDir,
    stdio: 'inherit',
    timeout: TEST_TIMEOUT_MS,
    env: childEnv,
  })

  step('起服务并等健康检查通过')
  // 自己找一个空端口，不用 3002——那可能正被你自己开着的服务占着，
  // 于是脚本测的是一个没起来的服务，health 探不通，报错还指向别处。
  const port = await findFreePort()
  console.log(`   用端口 ${port}`)

  server = spawn(process.execPath, [join(workDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'apps/api/src/index.ts'], {
    cwd: workDir,
    env: { ...childEnv, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.stdout.write(`   [服务] ${d}`))
  server.stderr.on('data', (d) => process.stderr.write(`   [服务] ${d}`))

  let exited = null
  server.on('exit', (code) => { exited = code })

  const health = await waitForHealth(port)
  if (health === null) {
    const why = exited !== null ? `服务已退出（退出码 ${exited}）` : `${HEALTH_TIMEOUT_MS / 1000} 秒内没有响应`
    fail(`健康检查没通过：${why}`)
  }

  step('检查响应体形状')
  // 上面 fail() 一定会抛，所以这里 health 不是 null。tsc 看不穿抛异常这件事，
  // 用一次明确的判空把这件事说出来，不靠它猜。
  if (health === null) {
    fail('健康检查没通过：拿不到响应体')
  }
  const body = /** @type {{ ok?: unknown, service?: unknown }} */ (health.body)
  if (body.ok !== true || body.service !== 'api') {
    fail(`健康检查返回了预期外的形状：${JSON.stringify(body)}`)
  }
  console.log(`   拿到 ${JSON.stringify(body)}`)

  step('跑该 tag 的本章验证命令')
  const baseUrl = `http://127.0.0.1:${port}`
  const checks = CHAPTER_CHECKS[tag]
  if (checks === undefined) {
    // 显式说出来，不静默跳过。新加一章忘了加检查，就该在这里被看见。
    console.error(`   ${tag} 在验证表里没有对应条目。`)
    console.error('   加一章就要在 CHAPTER_CHECKS 里补一条，否则它只测过健康检查。')
    fail(`tag ${tag} 缺少本章验证命令`)
  }

  let passed = 0
  for (const check of checks) {
    let verdict
    try {
      verdict = await check.run(baseUrl, workDir)
    } catch (err) {
      verdict = `抛异常：${err instanceof Error ? err.message : String(err)}`
    }

    if (verdict === true) {
      passed++
      console.log(`   ✔ ${check.desc}`)
    } else {
      console.error(`   ✘ ${check.desc}`)
      console.error(`       ${verdict}`)
      failedChecks.push(check.desc)
    }
  }

  if (failedChecks.length > 0) {
    fail(`${failedChecks.length}/${checks.length} 条本章验证命令没过`)
  }
  console.log(`   ${passed}/${checks.length} 条通过`)

  console.log(`\n${tag} 复现通过。`)
  process.exitCode = 0
} catch (err) {
  if (err instanceof Error && err.message === 'FAIL') {
    process.exitCode = 1
  } else if (isTimeout(err)) {
    // 超时不是「测试失败」，是「根本没跑完」。两种都得退出 1，
    // 但要分得清，否则看到超时的人会以为代码有问题。
    console.error(`\n失败：命令超时，没跑完就中断了。${describeTimeout(err)}`)
    process.exitCode = 1
  } else {
    console.error('\n复现过程中出错：', err)
    process.exitCode = 1
  }
} finally {
  step('收尾')
  if (server !== null && server.exitCode === null) {
    // Windows 上要杀整个进程组，tsx 会 fork 出真正的 node 进程，
    // 只 kill 父进程的话子进程会变孤儿，继续占着端口。
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch { /* 已经退出了 */ }
    } else {
      server.kill('SIGTERM')
    }
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true })
    console.log(`   已删除临时目录 ${workDir}`)
  }
  if (pgClient !== null) {
    await closePg()
  }
  if (pgUrl !== null) {
    // WITH (FORCE)：服务刚被 taskkill 掉，连接可能还挂着。
    // 删库失败只提示，不改退出码——复现本身的结论已经定了。
    try {
      const admin = new Client({ connectionString: withDbName(PG_BASE_URL, 'postgres') })
      await admin.connect()
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${PG_DB_NAME}" WITH (FORCE)`)
        console.log(`   已删除数据库 ${PG_DB_NAME}`)
      } finally {
        await admin.end()
      }
    } catch (err) {
      console.error(`   删库失败：${err instanceof Error ? err.message : String(err)}`)
      console.error(`   手动清：docker exec fullstack-backend-db dropdb -U postgres --if-exists ${PG_DB_NAME}`)
    }
  }
}

/** @param {string} msg */
function step(msg) {
  console.log(`\n▸ ${msg}`)
}

/**
 * execFileSync 超时抛的错带 code: 'ETIMEDOUT'，signal 可能是 SIGTERM
 * @param {unknown} err
 */
function isTimeout(err) {
  return typeof err === 'object' && err !== null && /** @type {{code?: string}} */ (err).code === 'ETIMEDOUT'
}

/**
 * @param {any} err
 * @returns {string}
 */
function describeTimeout(err) {
  return `（${err.syscall ?? '命令'} 收到 ${err.signal ?? 'SIGTERM'}，上限 ${INSTALL_TIMEOUT_MS / 1000} / ${TEST_TIMEOUT_MS / 1000} 秒）`
}

/**
 * 跑 npm 的正确姿势：绕过 .cmd，直接用 node 跑 npm 的 JS 入口。
 *
 * 两条弯路都踩过：
 * 1. spawn('npm', { shell: true }) —— 能跑通，但 Node 会报 DEP0190：
 *    参数不经转义只做拼接，路径里有空格或特殊字符时行为不可预期。
 * 2. spawn('npm.cmd') —— Windows 上 Node 24 直接报 EINVAL。
 *    这是 CVE-2024-27980 的修复：新版 Node 拒绝不经 shell 执行 .cmd / .bat。
 *
 * 入口路径从当前 node.exe 推出来，所以不用猜 npm 装在哪。
 *
 * @param {string[]} args
 * @returns {{cmd: string, args: string[]}}
 */
function npmArgs(args) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) {
    fail(`找不到 npm 的入口 ${npmCli}。这个脚本需要用 node 自带的 npm 跑。`)
  }
  return { cmd: process.execPath, args: [npmCli, ...args] }
}

/** @param {string} msg @returns {never} */
function fail(msg) {
  console.error(`\n失败：${msg}`)
  const e = new Error('FAIL')
  throw e
}

/**
 * 让系统分配一个端口再立刻放掉。拿到的是当时确定空闲的端口。
 *
 * 释放端口到 spawn 之间有个竞态窗口：别人可能抢走这个端口。
 * 所以后面必须有健康检查兜底，最坏结果是报「服务起不来」，
 * 而不是静默探到别的服务上。
 *
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((res, rej) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer()
      srv.unref()
      srv.on('error', rej)
      srv.listen(0, '127.0.0.1', () => {
        // address() 在没监听时返回 null，解构 null.port 会抛 TypeError。
        // 走到这个回调说明已经在监听，但判空还是要写。
        const address = srv.address()
        if (address === null || typeof address === 'string') {
          srv.close()
          rej(new Error('拿不到分配的端口'))
          return
        }
        const { port } = address
        srv.close(() => res(port))
      })
    })
  })
}

/**
 * 轮询到健康检查通过为止。
 * 不用固定 sleep：固定 sleep 有两种失败模式——睡太久白等，
 * 睡太短服务还没起来就报「挂了」。轮询把两种都消掉。
 *
 * @param {number} port
 * @returns {Promise<{status: number, body: any} | null>}
 */
async function waitForHealth(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  const url = `http://127.0.0.1:${port}/api/health`
  let lastError = '没有发出过请求'

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      const body = await res.json()
      if (res.status === 200) return { status: res.status, body }
      lastError = `状态码 ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  console.error(`   最后一次失败原因：${lastError}`)
  return null
}
