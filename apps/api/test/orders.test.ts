import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createProduct, call, createUser } from './harness.ts'
import type { Harness, ErrorBody } from './harness.ts'

/**
 * 订单接口。
 *
 * 这个文件守三件事：
 *   1. 建订单会同时改三张表，而且改对
 *   2. 中途失败时三张表都不变（事务的回滚）
 *   3. 状态机的合法与非法转移
 *
 * 状态机规则本身在 `src/order-state.ts`，那部分是纯逻辑，
 * 直接断言就行，不需要起服务——见本文件末尾。
 */

let h: Harness
let userId: number

before(async () => {
  h = await startHarness()
  userId = await createUser(h.db)
})

after(async () => {
  await h.close()
})

type OrderBody = {
  id: number
  userId: number
  status: string
  totalCents: number
  createdAt: string
  items: Array<{ productId: number; quantity: number; unitPriceCents: number; productTitle: string }>
}

function postOrder(body: unknown): Promise<Response> {
  return fetch(`${h.baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function transition(id: number, to: string): Promise<Response> {
  return fetch(`${h.baseUrl}/api/orders/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  })
}

/** 查某个商品的库存 */
async function stockOf(productId: number): Promise<number> {
  const row = await h.db.one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', [productId])
  assert.ok(row !== undefined, `商品 ${productId} 不存在`)
  return row.stock
}

/** 某张表有几行。COUNT(*) 是 bigint，pg 默认读成字符串，所以 ::int 转一下。 */
async function countOf(sql: string, ...params: unknown[]): Promise<number> {
  const row = await h.db.one<{ n: number }>(sql, params as never[])
  assert.ok(row !== undefined, `查不到行：${sql}`)
  return row.n
}

test('建订单：一次请求改三张表，金额是整数分', async () => {
  const a = await createProduct(h.baseUrl, { priceCents: 1999, stock: 10 })
  const b = await createProduct(h.baseUrl, { priceCents: 2500, stock: 10 })

  const res = await postOrder({
    userId,
    items: [
      { productId: a.id, quantity: 2 },
      { productId: b.id, quantity: 3 },
    ],
  })
  assert.equal(res.status, 201)
  const order = (await res.json()) as OrderBody

  assert.equal(order.userId, userId)
  assert.equal(order.status, 'pending')
  // 1999*2 + 2500*3 = 3998 + 7500 = 11498
  assert.equal(order.totalCents, 11498)
  assert.equal(typeof order.totalCents, 'number')
  assert.equal(order.items.length, 2)

  // 三张表都要真的变了
  assert.equal(await stockOf(a.id), 8, 'a 的库存应该被扣掉 2')
  assert.equal(await stockOf(b.id), 7, 'b 的库存应该被扣掉 3')
  const itemCount = await countOf(
    'SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = ?',
    order.id,
  )
  assert.equal(itemCount, 2, '明细表要有两行')
})

test('明细里的价格是快照，商品改价不影响已有订单', async () => {
  const p = await createProduct(h.baseUrl, { priceCents: 1000, stock: 5 })
  const res = await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })
  assert.equal(res.status, 201)
  const order = (await res.json()) as OrderBody
  assert.equal(order.totalCents, 1000)

  // 把商品价格翻三倍
  await h.db.query('UPDATE products SET price_cents = 3000 WHERE id = ?', [p.id])

  const again = await fetch(`${h.baseUrl}/api/orders/${order.id}`)
  const reread = (await again.json()) as OrderBody
  assert.equal(reread.totalCents, 1000, '历史订单金额不能跟着改价变')
  const firstItem = reread.items[0]
  assert.ok(firstItem, '订单必须至少有一项明细')
  assert.equal(firstItem.unitPriceCents, 1000, '单价快照也不能变')
  assert.equal(firstItem.productTitle, p.title, '商品名也是快照')

  // 但新订单用的是新价格
  const next = await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })
  const nextOrder = (await next.json()) as OrderBody
  assert.equal(nextOrder.totalCents, 3000, '新订单要用改价后的价格')
})

test('库存不足返回 409 OUT_OF_STOCK', async () => {
  const p = await createProduct(h.baseUrl, { priceCents: 500, stock: 2 })
  const res = await postOrder({ userId, items: [{ productId: p.id, quantity: 5 }] })
  assert.equal(res.status, 409)
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'OUT_OF_STOCK')
})

test('库存不足时三张表都不变：没有订单、没有明细、库存没扣', async () => {
  const p = await createProduct(h.baseUrl, { priceCents: 500, stock: 2 })
  const before = {
    orders: await countOf('SELECT COUNT(*)::int AS n FROM orders'),
    items: await countOf('SELECT COUNT(*)::int AS n FROM order_items'),
    stock: await stockOf(p.id),
  }

  const res = await postOrder({ userId, items: [{ productId: p.id, quantity: 99 }] })
  assert.equal(res.status, 409)

  const after = {
    orders: await countOf('SELECT COUNT(*)::int AS n FROM orders'),
    items: await countOf('SELECT COUNT(*)::int AS n FROM order_items'),
    stock: await stockOf(p.id),
  }
  assert.deepEqual(after, before, '回滚之后三张表必须和调用前完全一样')
})

test('第二个商品库存不足时，第一个商品的扣减也要退回去', async () => {
  const a = await createProduct(h.baseUrl, { priceCents: 100, stock: 10 })
  const b = await createProduct(h.baseUrl, { priceCents: 100, stock: 1 })
  const stockBefore = await stockOf(a.id)

  const res = await postOrder({
    userId,
    items: [
      { productId: a.id, quantity: 3 },
      { productId: b.id, quantity: 50 },
    ],
  })
  assert.equal(res.status, 409)

  // 关键：a 的扣减必须已经退回去。这是「整体回滚」和「只回滚失败那一步」的分界线。
  assert.equal(await stockOf(a.id), stockBefore, '第一个商品的库存扣减必须被回滚')
})

test('商品不存在返回 404 PRODUCT_NOT_FOUND', async () => {
  const res = await postOrder({ userId, items: [{ productId: 999999, quantity: 1 }] })
  assert.equal(res.status, 404)
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'PRODUCT_NOT_FOUND')
})

test('用户不存在返回 404 USER_NOT_FOUND', async () => {
  const p = await createProduct(h.baseUrl)
  const res = await postOrder({ userId: 999999, items: [{ productId: p.id, quantity: 1 }] })
  assert.equal(res.status, 404)
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'USER_NOT_FOUND')
})

test('空订单返回 400 VALIDATION_FAILED', async () => {
  const res = await postOrder({ userId, items: [] })
  assert.equal(res.status, 400)
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'VALIDATION_FAILED')
  assert.ok(body.error.fields, '校验失败要带 fields')
})

test('GET /api/orders/:id 返回 200，非法 id 返回 400，缺失返回 404', async () => {
  const p = await createProduct(h.baseUrl)
  const created = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody

  const ok = await fetch(`${h.baseUrl}/api/orders/${created.id}`)
  assert.equal(ok.status, 200)
  assert.equal(((await ok.json()) as OrderBody).id, created.id)

  const bad = await call(h.baseUrl, '/api/orders/1.5')
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'INVALID_PARAM')

  const missing = await call(h.baseUrl, '/api/orders/999999')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'ORDER_NOT_FOUND')
})

test('状态机：pending -> paid -> shipped -> completed 走通', async () => {
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody

  for (const to of ['paid', 'shipped', 'completed']) {
    const res = await transition(order.id, to)
    assert.equal(res.status, 200, `${order.status} -> ${to} 应该成功`)
    const moved = (await res.json()) as OrderBody
    assert.equal(moved.status, to)
  }
})

test('状态机：completed 是终态，再改返回 409', async () => {
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody
  await transition(order.id, 'paid')
  await transition(order.id, 'shipped')
  await transition(order.id, 'completed')

  const res = await transition(order.id, 'pending')
  assert.equal(res.status, 409)
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'ORDER_STATE_INVALID')
  assert.match(body.error.message, /completed/, '错误信息要说清现在是什么状态')
})

test('状态机：completed 之后连 paid 都不能回到（终态没有任何出边）', async () => {
  // 这条和上面那条「再改返回 409」不是同一件事：
  // 上面测的是 completed -> pending，这里测的是 completed -> paid。
  // 两个方向都要单独守住，否则改转移表时只挡住一个方向。
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody
  await transition(order.id, 'paid')
  await transition(order.id, 'shipped')
  await transition(order.id, 'completed')

  const res = await transition(order.id, 'paid')
  assert.equal(res.status, 409, 'completed -> paid 必须被拒绝')
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'ORDER_STATE_INVALID')

  // 状态不能被这次被拒绝的转移改掉
  const reread = (await (await fetch(`${h.baseUrl}/api/orders/${order.id}`)).json()) as OrderBody
  assert.equal(reread.status, 'completed')
})

test('状态机：cancelled 之后不能再 paid', async () => {
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody
  assert.equal((await transition(order.id, 'cancelled')).status, 200)

  const res = await transition(order.id, 'paid')
  assert.equal(res.status, 409)
  const body = (await res.json()) as ErrorBody
  assert.equal(body.error.code, 'ORDER_STATE_INVALID')
})

test('状态机：shipped 之后不能直接 completed 之外的任何状态', async () => {
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody
  await transition(order.id, 'paid')
  await transition(order.id, 'shipped')

  // shipped 只能去 completed，回 pending 是非法的
  const back = await transition(order.id, 'pending')
  assert.equal(back.status, 409)
  assert.equal(((await back.json()) as { error: { code: string } }).error.code, 'ORDER_STATE_INVALID')
})

test('非法转移不写库，状态保持原样', async () => {
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody

  const res = await transition(order.id, 'completed') // pending 不能直接 completed
  assert.equal(res.status, 409)

  const reread = (await (await fetch(`${h.baseUrl}/api/orders/${order.id}`)).json()) as OrderBody
  assert.equal(reread.status, 'pending', '被拒绝的转移不能留下痕迹')
})

test('to 不是合法状态值返回 400', async () => {
  const p = await createProduct(h.baseUrl)
  const order = (await (await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] })).json()) as OrderBody
  const res = await transition(order.id, 'refunded')
  assert.equal(res.status, 400)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'VALIDATION_FAILED')
})

test('对不存在的订单做转移返回 404', async () => {
  const res = await transition(999999, 'paid')
  assert.equal(res.status, 404)
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'ORDER_NOT_FOUND')
})

/* ------------------------------------------------------------------ *
 * 状态机规则本身：纯逻辑，不经过 HTTP
 * ------------------------------------------------------------------ */

test('状态机：转移表和接口表现一致', async () => {
  const { ALL_STATUSES, allowedFrom, canTransition, isTerminal } = await import('../src/order-state.ts')

  // 转移表里没有的两两组合，全部应该被接口拒绝
  const legal: Array<[string, string]> = [
    ['pending', 'paid'],
    ['pending', 'cancelled'],
    ['paid', 'shipped'],
    ['paid', 'cancelled'],
    ['shipped', 'completed'],
  ]
  for (const [from, to] of legal) {
    assert.equal(canTransition(from as never, to as never), true, `${from} -> ${to} 应该合法`)
  }
  assert.deepEqual([...ALL_STATUSES].sort(), ['cancelled', 'completed', 'paid', 'pending', 'shipped'])
  assert.equal(isTerminal('completed'), true)
  assert.equal(isTerminal('cancelled'), true)
  assert.equal(isTerminal('pending'), false)
  assert.deepEqual([...allowedFrom('paid')], ['shipped', 'cancelled'])

  // 终态没有出边
  for (const terminal of ['completed', 'cancelled'] as const) {
    for (const to of ALL_STATUSES) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to} 不该合法`)
    }
  }
})
