import { Router } from 'express'
import { CreateProductInput } from '@fullstack/shared'
import type { Product } from '@fullstack/shared'
import { db } from '../db/sqlite.ts'
import { HttpError, isConstraint } from '../errors.ts'
import { asyncHandler } from './async-handler.ts'

/**
 * 商品接口。
 *
 * 每个处理器的顺序是固定的：
 *   1. 校验（zod，挡住不合规的请求，能指出是哪个字段）
 *   2. 查库
 *   3. 把数据库的约束冲突翻译成接口语义码
 *
 * 第 3 步是本章的重点。数据库只会说「外键约束失败」，
 * 它不知道你想表达的是「这个商品还有订单，删不掉」。
 * 翻译这一步必须有人做，不做的话错误就一路掉到 500，
 * 客户端看到「服务端出错了」，而真相躺在服务端日志里。
 */

export const productsRouter = Router()

/** 数据库里的一行。列名是 snake_case，对外是驼峰，两边不要混。 */
type ProductRow = {
  id: number
  sku: string
  /** 老列，contract 阶段才删 */
  name: string
  /** ch06 加的新列。回填完成前是 null。 */
  title: string | null
  price_cents: number
  stock: number
  created_at: string
}

/**
 * **双读**：title 有值用 title，没有就退回 name。
 *
 * 那个 `?? row.name` 就是整个 expand 阶段的核心。
 *
 * 少了它的后果不是报错，是**静默少一个字段**：
 * 回填没跑完的行 title 是 null，不兜底的话 title 变成 undefined，
 * 而 JSON.stringify 会把值为 undefined 的键**直接从响应里删掉**。
 * 调用方拿到一个 200，body 里没有 title，没有任何异常。
 *
 * 什么时候能去掉：contract 阶段，老代码确认下线之后。
 * 前提是回填已经确认跑完——判据是「还有多少行 title IS NULL」为 0。
 */
function rowToProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    title: row.title ?? row.name,
    priceCents: row.price_cents,
    stock: row.stock,
    createdAt: row.created_at,
  }
}

/**
 * 路径参数必须是正整数。
 *
 * 不用 Number() 直接转：Number('1.5') 是 1.5，Number(' 1 ') 是 1，
 * Number('1e3') 是 1000。这些都会被悄悄接受，然后用一个小数 id 去查库，
 * 查不到就回 404——404 在这里会误导人，真正的问题是参数本身就不合法。
 */
function parseId(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, 'INVALID_PARAM', 'id 必须是正整数')
  }
  return Number(raw)
}

/** GET /api/products —— 列表 */
productsRouter.get(
  '/products',
  asyncHandler(async (_req, res) => {
    const rows = await db.query<ProductRow>('SELECT * FROM products ORDER BY id DESC')
    res.json(rows.map(rowToProduct))
  }),
)

/** GET /api/products/:id —— 单条 */
productsRouter.get(
  '/products/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const row = await db.one<ProductRow>('SELECT * FROM products WHERE id = ?', [id])
    if (row === undefined) throw new HttpError(404, 'PRODUCT_NOT_FOUND', `商品 ${id} 不存在`)
    res.json(rowToProduct(row))
  }),
)

/**
 * POST /api/products —— 新建
 *
 * 插入用 RETURNING *，一次往返就拿到新行，不用再查一次。
 * RETURNING 需要 SQLite 3.35+，本机的 node:sqlite 满足
 * （同版本才有的 ALTER TABLE DROP COLUMN 也能用，可以互相印证）。
 */
productsRouter.post(
  '/products',
  asyncHandler(async (req, res) => {
    const parsed = CreateProductInput.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_FAILED', '输入不符合要求', flatten(parsed.error))
    }

    // **双写**：title 和 name 一起写，两个值相同。
    //
    // 只给一个值不是「省一次写入」，是给另一个版本埋雷：
    // 回填跑完之后有人删掉一个，第二个版本的数据就成了孤儿。
    // 两列同生共死，contract 阶段才能一次删干净。
    //
    // 允许只给 title 不给 name（反之不行，name 仍是必填），
    // 这样新调用方可以只用新键，旧调用方也不用改。
    const name = parsed.data.name
    const title = parsed.data.title ?? name

    const now = new Date().toISOString()
    try {
      const rows = await db.query<ProductRow>(
        `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [parsed.data.sku, name, title, parsed.data.priceCents, parsed.data.stock, now],
      )
      res.status(201).json(rowToProduct(rows[0] as ProductRow))
    } catch (err) {
      // 同一个 sku 只能有一个。这是业务上「这个货号已经登记过了」，
      // 不是服务故障，客户端换个 sku 就能继续，所以是 409 不是 400 也不是 500。
      if (isConstraint(err, 'unique')) {
        throw new HttpError(409, 'PRODUCT_SKU_TAKEN', `SKU ${parsed.data.sku} 已经存在`)
      }
      throw err
    }
  }),
)

/**
 * DELETE /api/products/:id —— 删掉，不可恢复
 *
 * 这一条是本章的立论所在：商品有订单明细时删不掉。
 * 数据库抛的是外键约束错误，翻译成「这个商品还被订单引用着」。
 */
productsRouter.delete(
  '/products/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    try {
      // RETURNING 顺带解决了「删没删掉」的问题：返回 0 行就是没删到。
      const rows = await db.query<{ id: number }>('DELETE FROM products WHERE id = ? RETURNING id', [id])
      if (rows.length === 0) throw new HttpError(404, 'PRODUCT_NOT_FOUND', `商品 ${id} 不存在`)
      res.status(204).end()
    } catch (err) {
      // 注意这里的顺序：HttpError 是我们自己抛的，不该被当成数据库错误再翻译一次。
      if (err instanceof HttpError) throw err
      if (isConstraint(err, 'foreignkey')) {
        throw new HttpError(409, 'PRODUCT_IN_USE', `商品 ${id} 已经被订单引用，删不掉`)
      }
      throw err
    }
  }),
)

/** 把 zod 的错误列表压成 { 字段名: 第一条错误信息 } */
function flatten(error: { issues: { path: (string | number)[]; message: string }[] }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    if (!(key in out)) out[key] = issue.message
  }
  return out
}
