import { Router } from 'express'
import { CreateOrderInput, TransitionInput } from '@fullstack/shared'
import type { Order, OrderItem, OrderStatus } from '@fullstack/shared'
import { db } from '../db/postgres.ts'
import { HttpError } from '../errors.ts'
import { asyncHandler } from './async-handler.ts'
import { allowedFrom, canTransition } from '../order-state.ts'

/**
 * 订单接口。
 *
 * 这一章的每个接口都要同时改几张表，所以每段业务逻辑都包在
 * `db.transaction` 里。**为什么必须这样、以及为什么原来那个事务
 * 其实是假的**，见 guide/deep/ch07。
 */

export const ordersRouter = Router()

type OrderRow = {
  id: number
  user_id: number
  status: OrderStatus
  total_cents: number
  created_at: string
}

type OrderItemRow = {
  order_id: number
  product_id: number
  quantity: number
  unit_price_cents: number
  product_title: string
}

/**
 * 把库里的行组装成对外的形状。
 *
 * 明细里的价格是**下单那一刻的快照**（`unit_price_cents`），
 * 不是去 `products` 查现价。商品改价之后这里不会变——
 * 历史订单的金额必须是当时那个。
 */
function rowToOrder(row: OrderRow, items: OrderItemRow[]): Order {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    totalCents: row.total_cents,
    createdAt: row.created_at,
    items: items.map<OrderItem>((i) => ({
      productId: i.product_id,
      quantity: i.quantity,
      unitPriceCents: i.unit_price_cents,
      productTitle: i.product_title,
    })),
  }
}

/** 把 zod 的错误列表压成 { 字段名: 第一条错误信息 } */
function flatten(error: { issues: { path: (string | number)[]; message: string }[] }): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_'
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

function parseId(raw: string | undefined): number {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, 'INVALID_PARAM', 'id 必须是正整数')
  }
  return Number(raw)
}

/** 读一张订单连同它的明细。查不到返回 undefined。 */
async function loadOrder(id: number): Promise<Order> {
  const row = await db.one<OrderRow>('SELECT * FROM orders WHERE id = ?', [id])
  if (row === undefined) throw new HttpError(404, 'ORDER_NOT_FOUND', `订单 ${id} 不存在`)
  const items = await db.query<OrderItemRow>(
    `SELECT oi.order_id, oi.product_id, oi.quantity, oi.unit_price_cents,
            COALESCE(p.title, p.name) AS product_title
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id`,
    [id],
  )
  return rowToOrder(row, items)
}

/**
 * POST /api/orders —— 建一笔订单
 *
 * 三张表，三步，任何一步失败都整体回滚：
 *   1. INSERT orders
 *   2. INSERT order_items（每件一行）
 *   3. UPDATE products 扣库存
 *
 * ## 为什么扣库存不先查后写
 *
 * 教科书写法是「先 SELECT 一下看够不够，够就 UPDATE stock = stock - n」。
 * 那是错的：SELECT 和 UPDATE 之间有时间差，另一个并发请求能插进来把库存买光，
 * 于是两个请求都看到「够」，都执行了扣减，库存变成负数。
 *
 * 正确做法是把判断放进 UPDATE 的 WHERE：
 *
 *   UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?
 *
 * `stock >= ?` 由数据库在**写的那一刻**判断并发不成立的情况，
 * 不成立时这行 0 行受影响（`changes === 0`），我们据此抛 409。
 * 数据库的行锁保证这一句的判断和写入之间不会有人插进来。
 */
ordersRouter.post(
  '/orders',
  asyncHandler(async (req, res) => {
    const parsed = CreateOrderInput.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_FAILED', '输入不符合要求', flatten(parsed.error))
    }

    /**
     * 用户和商品都在事务里显式查过，各自抛 404。
     *
     * 所以这里**没有**约束冲突需要翻译。真撞上外键，只能说明上面的查询和
     * 插入之间出了别的问题——那种情况应该落到 500，让日志说话，
     * 而不是伪装成一个 409 说「东西不存在」。
     */
    const order = await db.transaction(async (tx) => {
      const user = await tx.one<{ id: number }>('SELECT id FROM users WHERE id = ?', [parsed.data.userId])
      if (user === undefined) {
        throw new HttpError(404, 'USER_NOT_FOUND', `用户 ${parsed.data.userId} 不存在`)
      }

      /**
       * 先把每件商品的价格和标题读出来。
       *
       * 读到内存里之后再写明细，是为了保证「同一件商品在一个订单里
       * 只有一个价格快照」。如果每写一行明细就重新查一次价，
       * 而中间有人在改价，同一个订单里两行会拿到不同的价。
       */
      const lines: Array<{ productId: number; quantity: number; price: number; title: string }> = []

      for (const item of parsed.data.items) {
        const product = await tx.one<{ id: number; price_cents: number; title: string | null; name: string }>(
          'SELECT id, price_cents, title, name FROM products WHERE id = ?',
          [item.productId],
        )
        if (product === undefined) {
          throw new HttpError(404, 'PRODUCT_NOT_FOUND', `商品 ${item.productId} 不存在`)
        }

        // 扣库存。判断在 WHERE 里，靠 changes 判断有没有扣成功。
        const updated = await tx.query<{ id: number }>(
          'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ? RETURNING id',
          [item.quantity, item.productId, item.quantity],
        )
        if (updated.length === 0) {
          throw new HttpError(409, 'OUT_OF_STOCK', `商品 ${item.productId} 库存不足`)
        }

        lines.push({
          productId: item.productId,
          quantity: item.quantity,
          price: product.price_cents,
          // 和 products 接口一样，title 优先、退回 name。
          title: product.title ?? product.name,
        })
      }

      const totalCents = lines.reduce((sum, l) => sum + l.price * l.quantity, 0)
      const now = new Date().toISOString()

      const created = await tx.query<OrderRow>(
        `INSERT INTO orders (user_id, status, total_cents, created_at)
         VALUES (?, 'pending', ?, ?)
         RETURNING *`,
        [parsed.data.userId, totalCents, now],
      )
      const orderRow = created[0] as OrderRow

      for (const line of lines) {
        await tx.query(
          `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
           VALUES (?, ?, ?, ?)`,
          [orderRow.id, line.productId, line.quantity, line.price],
        )
      }

      return rowToOrder(
        orderRow,
        lines.map((l) => ({
          order_id: orderRow.id,
          product_id: l.productId,
          quantity: l.quantity,
          unit_price_cents: l.price,
          product_title: l.title,
        })),
      )
    })

    res.status(201).json(order)
  }),
)

/** GET /api/orders/:id —— 查一笔订单 */
ordersRouter.get(
  '/orders/:id',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    res.json(await loadOrder(id))
  }),
)

/**
 * POST /api/orders/:id/transition —— 状态转移
 *
 * 合法转移才写库。这里是整个状态机唯一被用到的地方，
 * 规则本身在 `order-state.ts` 里。
 */
ordersRouter.post(
  '/orders/:id/transition',
  asyncHandler(async (req, res) => {
    const id = parseId(req.params.id)
    const parsed = TransitionInput.safeParse(req.body)
    if (!parsed.success) {
      throw new HttpError(400, 'VALIDATION_FAILED', '输入不符合要求', flatten(parsed.error))
    }

    const updated = await db.transaction(async (tx) => {
      const row = await tx.one<OrderRow>('SELECT * FROM orders WHERE id = ?', [id])
      if (row === undefined) throw new HttpError(404, 'ORDER_NOT_FOUND', `订单 ${id} 不存在`)

      if (!canTransition(row.status, parsed.data.to)) {
        // 错误信息里带上「现在能去哪儿」，客户端不用回来问一次。
        const allowed = allowedFrom(row.status)
        const target = allowed.length === 0 ? '没有（终态）' : allowed.join(' / ')
        throw new HttpError(
          409,
          'ORDER_STATE_INVALID',
          `订单现在是 ${row.status}，不能变成 ${parsed.data.to}。现在可以变成：${target}`,
        )
      }

      const moved = await tx.query<OrderRow>('UPDATE orders SET status = ? WHERE id = ? RETURNING *', [
        parsed.data.to,
        id,
      ])
      return moved[0] as OrderRow
    })

    res.json(await loadOrder(updated.id))
  }),
)
