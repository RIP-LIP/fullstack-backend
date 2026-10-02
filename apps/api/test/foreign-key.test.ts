import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createProduct, call } from './harness.ts'
import type { Harness } from './harness.ts'
import { constraintKind } from '../src/errors.ts'

/**
 * 外键的三个面：数据库真的会拦、接口会翻译、库里没有孤儿行。
 *
 * 跑法：在仓库根目录 npm test
 */

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

let emailSeq = 0

/** 建一个用户，返回 id。走数据层而不是接口——这里要的是能塞脏数据进去。 */
async function seedUser(): Promise<number> {
  emailSeq += 1
  const rows = await h.db.query<{ id: number }>(
    'INSERT INTO users (email, created_at) VALUES (?, ?) RETURNING id',
    [`u${emailSeq}@test.dev`, new Date().toISOString()],
  )
  return rows[0]!.id
}

/** 建一个订单，返回 id。 */
async function seedOrder(userId: number): Promise<number> {
  const rows = await h.db.query<{ id: number }>(
    `INSERT INTO orders (user_id, status, total_cents, created_at)
     VALUES (?, 'pending', 0, ?) RETURNING id`,
    [userId, new Date().toISOString()],
  )
  return rows[0]!.id
}

/** 建一条订单明细，指向某个商品。 */
async function seedOrderItem(orderId: number, productId: number): Promise<void> {
  await h.db.query(
    `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
     VALUES (?, ?, 1, 1000)`,
    [orderId, productId],
  )
}

describe('外键冲突翻译成接口语义', () => {
  test('删一个已经被订单引用的商品，返回 409 而不是 500', async () => {
    const product = await createProduct(h.baseUrl, { name: '卖出去过的键盘' })
    const userId = await seedUser()
    const orderId = await seedOrder(userId)
    await seedOrderItem(orderId, product.id)

    const { status, body } = await call(h.baseUrl, `/api/products/${product.id}`, { method: 'DELETE' })

    // 500 意味着「服务端坏了」，客户端会拿着这个去查服务端。
    // 但这里服务端好得很，是这条业务规则不让删。
    assert.equal(status, 409, `被引用的商品应当 409，实际 ${status}：${JSON.stringify(body)}`)
    assert.equal(body.error.code, 'PRODUCT_IN_USE')
  })

  test('409 的响应体里没有 SQLite 的内部错误文本', async () => {
    const product = await createProduct(h.baseUrl, { name: '有订单的商品' })
    const userId = await seedUser()
    const orderId = await seedOrder(userId)
    await seedOrderItem(orderId, product.id)

    const { body } = await call(h.baseUrl, `/api/products/${product.id}`, { method: 'DELETE' })
    const text = JSON.stringify(body)

    // 「FOREIGN KEY」「SQLITE」「constraint failed」这些东西是给服务端看的。
    // 漏出去等于把内部实现变成了接口契约，以后换库就得改前端。
    assert.ok(!/FOREIGN KEY/i.test(text), `响应体漏出了外键错误原文：${text}`)
    assert.ok(!/SQLITE/i.test(text), `响应体漏出了 SQLite 字样：${text}`)
    assert.ok(!/constraint failed/i.test(text), `响应体漏出了约束错误原文：${text}`)
  })

  test('商品还在，删除失败没有把数据改掉', async () => {
    const product = await createProduct(h.baseUrl, { name: '删不掉的商品' })
    const userId = await seedUser()
    const orderId = await seedOrder(userId)
    await seedOrderItem(orderId, product.id)

    await call(h.baseUrl, `/api/products/${product.id}`, { method: 'DELETE' })

    const res = await fetch(`${h.baseUrl}/api/products/${product.id}`)
    assert.equal(res.status, 200, '删除失败时商品必须还在')
  })
})

describe('外键约束真的在数据库里', () => {
  test('订单明细指向不存在的商品时，数据库拒绝写入', async () => {
    const userId = await seedUser()
    const orderId = await seedOrder(userId)

    await assert.rejects(
      () => seedOrderItem(orderId, 999999),
      (err: unknown) => {
        assert.equal(constraintKind(err), 'foreignkey', '应当被识别成外键冲突')
        return true
      },
    )
  })

  test('订单指向不存在的用户时，数据库拒绝写入', async () => {
    await assert.rejects(
      () => h.db.query(
        `INSERT INTO orders (user_id, status, total_cents, created_at)
         VALUES (999999, 'pending', 0, ?) RETURNING id`,
        [new Date().toISOString()],
      ),
      (err: unknown) => {
        assert.equal(constraintKind(err), 'foreignkey')
        return true
      },
    )
  })

  test('默认连接下库里没有孤儿行', async () => {
    // 这条是给「关掉外键」那套做法留的对照：node:sqlite 默认开着外键，
    // 所以孤儿行本该是 0。要是这里不是 0，说明有人把 pragma 关了。
    const rows = await h.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE p.id IS NULL`,
    )
    assert.equal(rows[0]!.n, 0, '订单明细不能指向不存在的商品')
  })
})
