import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createProduct, createUser } from './harness.ts'
import type { Harness } from './harness.ts'
import { canonicalize, requestHash } from '../src/idempotency.ts'

/**
 * 幂等。
 *
 * 这个文件挡的是一个**必然会发生**的故障：客户端网络卡住，用户点了两次，
 * 两个一模一样的请求到了服务端，各建一笔订单、各扣一次库存。
 *
 * ## 怎么证明这些测试不是空转
 *
 * 1. 删掉 `claim` 里的 `request_hash` 比对 -> 1 条挂：
 *    同一个键配不同内容时返回 409
 * 2. 把 `complete` 那句 UPDATE 删掉 -> 2 条挂：重放那两条
 * 3. 把 `release` 调用删掉 -> 1 条挂：失败之后同一个键还能重新用
 *
 * 挂掉的测试名见 commit message。
 *
 * ## 还有一个**试过但没抓住**的变异，值得记一笔
 *
 * 试过在 INSERT 之前加一句「先 SELECT 看这个键在不在」。
 * **12 条全绿，一条都没挂。**
 *
 * 原因是：那次预查询不参与判据。查到了不等于「归我」，
 * 不查也不影响——撞唯一键之后 catch 里还是会去查那一行。
 * 所以它只是一次**多余的查询**，不是错误。
 *
 * 真正的错误做法是**拿那次查询的结果当判据**，
 * 也就是「查不到就直接 INSERT 并当成自己的」——
 * 那样两个并发请求会同时查到「查不到」，然后同时当成自己的。
 * 本实现的判据始终是唯一约束，所以那个窗口不存在。
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
  status: string
  totalCents: number
}

let keySeq = 0
function freshKey(): string {
  keySeq += 1
  return `key-${Date.now()}-${keySeq}`
}

/** 建一次订单，带上幂等键 */
function postOrder(body: unknown, key?: string): Promise<Response> {
  return fetch(`${h.baseUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify(body),
  })
}

async function stockOf(id: number): Promise<number> {
  const row = await h.db.one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', [id])
  assert.ok(row !== undefined)
  return row.stock
}

async function orderCount(): Promise<number> {
  const row = await h.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM orders')
  assert.ok(row !== undefined)
  return row.n
}

/* ------------------------------------------------------------------ *
 * 指纹
 * ------------------------------------------------------------------ */

describe('请求指纹', () => {
  test('键顺序不同，内容相同，指纹相同', () => {
    assert.equal(
      requestHash({ userId: 1, items: [{ productId: 2, quantity: 1 }] }),
      requestHash({ items: [{ quantity: 1, productId: 2 }], userId: 1 }),
    )
  })

  test('内容不同，指纹不同', () => {
    assert.notEqual(requestHash({ userId: 1 }), requestHash({ userId: 2 }))
  })

  // 数组顺序**是**语义的一部分。排序会把它变成同一个请求，
  // 那时候「同一个键配不同内容」就再也报不出来了。
  test('数组顺序不同，指纹不同', () => {
    assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]))
  })

  test('undefined 不参与指纹（它在 JSON 里不存在）', () => {
    assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}')
  })
})

/* ------------------------------------------------------------------ *
 * 没带键
 * ------------------------------------------------------------------ */

describe('没带幂等键', () => {
  test('就是普通请求，两次建两笔订单', async () => {
    const p = await createProduct(h.baseUrl, { priceCents: 100, stock: 10 })
    const body = { userId, items: [{ productId: p.id, quantity: 1 }] }

    const before = await orderCount()
    const first = await postOrder(body)
    const second = await postOrder(body)

    assert.equal(first.status, 201)
    assert.equal(second.status, 201, '没带键就没有幂等，两次都要成功')
    assert.equal(await orderCount(), before + 2)
  })
})

/* ------------------------------------------------------------------ *
 * 重放
 * ------------------------------------------------------------------ */

describe('同一个键重放', () => {
  test('第二次返回第一次那笔订单，不新建', async () => {
    const p = await createProduct(h.baseUrl, { priceCents: 100, stock: 10 })
    const key = freshKey()
    const body = { userId, items: [{ productId: p.id, quantity: 1 }] }

    const before = await orderCount()
    const stockBefore = await stockOf(p.id)

    const first = await postOrder(body, key)
    assert.equal(first.status, 201)
    const firstOrder = (await first.json()) as OrderBody

    const second = await postOrder(body, key)
    // **200 不是 201**：第一次已经创建过，这一次没有创建。
    assert.equal(second.status, 200, '重放不该再返回 201')
    const secondOrder = (await second.json()) as OrderBody

    assert.equal(secondOrder.id, firstOrder.id, '必须是同一笔订单')
    assert.equal(await orderCount(), before + 1, '订单数只能多一条')
    assert.equal(await stockOf(p.id), stockBefore - 1, '库存只能扣一次')
  })

  test('重放返回的是订单**现在**的状态，不是当初那个快照', async () => {
    const p = await createProduct(h.baseUrl, { priceCents: 100, stock: 10 })
    const key = freshKey()
    const body = { userId, items: [{ productId: p.id, quantity: 1 }] }

    const first = await postOrder(body, key)
    const created = (await first.json()) as OrderBody
    assert.equal(created.status, 'pending')

    // 把订单推进到 paid
    const moved = await fetch(`${h.baseUrl}/api/orders/${created.id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'paid' }),
    })
    assert.equal(moved.status, 200)

    // 重放：应该看到 paid，而不是当初的 pending。
    // **这就是为什么不存整份响应体。**
    const replay = await postOrder(body, key)
    assert.equal(replay.status, 200)
    const replayed = (await replay.json()) as OrderBody
    assert.equal(replayed.status, 'paid', '重放返回的是当前状态，不是当初的快照')
  })
})

/* ------------------------------------------------------------------ *
 * 同一个键，不同内容
 * ------------------------------------------------------------------ */

describe('同一个键配不同内容', () => {
  test('返回 409 IDEMPOTENCY_KEY_REUSED，不返回上一次的结果', async () => {
    const a = await createProduct(h.baseUrl, { priceCents: 100, stock: 10 })
    const b = await createProduct(h.baseUrl, { priceCents: 200, stock: 10 })
    const key = freshKey()

    const first = await postOrder({ userId, items: [{ productId: a.id, quantity: 1 }] }, key)
    assert.equal(first.status, 201)

    // 同一个键，内容换了一个商品
    const second = await postOrder({ userId, items: [{ productId: b.id, quantity: 1 }] }, key)
    assert.equal(second.status, 409)
    const body = (await second.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'IDEMPOTENCY_KEY_REUSED')

    // 库存一个都没动：这次请求根本没被执行
    assert.equal(await stockOf(b.id), 10, '被拒绝的请求不能有任何副作用')
  })
})

/* ------------------------------------------------------------------ *
 * 失败不留半截
 * ------------------------------------------------------------------ */

describe('失败之后', () => {
  test('建单失败不会把幂等键废掉，同一个键还能重新用', async () => {
    const p = await createProduct(h.baseUrl, { priceCents: 100, stock: 1 })
    const key = freshKey()

    // 第一次：买超过库存 -> 409 OUT_OF_STOCK
    const failed = await postOrder({ userId, items: [{ productId: p.id, quantity: 99 }] }, key)
    assert.equal(failed.status, 409)
    assert.equal(((await failed.json()) as { error: { code: string } }).error.code, 'OUT_OF_STOCK')

    // 第二次：同一个键，换成买得起的量 -> 必须成功。
    // 键不还回去的话，这里会是 409 IDEMPOTENT_REQUEST_IN_PROGRESS。
    const retry = await postOrder({ userId, items: [{ productId: p.id, quantity: 1 }] }, key)
    assert.equal(retry.status, 201, '失败之后键必须被还回去，否则这次意图就废了')
    assert.equal(await stockOf(p.id), 0)
  })

  test('失败的请求没有留下任何订单', async () => {
    const p = await createProduct(h.baseUrl, { priceCents: 100, stock: 1 })
    const before = await orderCount()
    await postOrder({ userId, items: [{ productId: p.id, quantity: 99 }] }, freshKey())
    assert.equal(await orderCount(), before)
  })
})

/* ------------------------------------------------------------------ *
 * 并发
 * ------------------------------------------------------------------ */

describe('两个请求同时带同一个键', () => {
  test('只有一个建单成功，另一个拿到同一笔', async () => {
    const p = await createProduct(h.baseUrl, { priceCents: 100, stock: 10 })
    const key = freshKey()
    const body = { userId, items: [{ productId: p.id, quantity: 1 }] }

    const stockBefore = await stockOf(p.id)
    const before = await orderCount()

    const results = await Promise.all([postOrder(body, key), postOrder(body, key)])
    const statuses = results.map((r) => r.status).sort()

    // 可能是「一个 201 一个 200」（第一个先提交），
    // 也可能是「一个 201 一个 409」（第一个还在跑，第二个撞上 in_progress）。
    // **两种都是对的**，因为「第二个请求没有建第二笔单」才是要保证的事。
    assert.equal(statuses.filter((s) => s === 201).length, 1, `期望正好一个 201，实际 ${statuses.join(' / ')}`)
    assert.ok(statuses.every((s) => s === 201 || s === 200 || s === 409), `意外的返回码：${statuses.join(' / ')}`)

    assert.equal(await orderCount(), before + 1, '并发重发只能建一笔订单')
    assert.equal(await stockOf(p.id), stockBefore - 1, '库存只能扣一次')
  })
})

/* ------------------------------------------------------------------ *
 * 校验顺序
 * ------------------------------------------------------------------ */

describe('参数不合法时', () => {
  test('先校验再建，幂等键不会被占掉', async () => {
    const key = freshKey()
    const res = await postOrder({ userId, items: [] }, key)
    assert.equal(res.status, 400)

    // 键还在，说明 400 这条路没有占键
    const row = await h.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM idempotency_keys WHERE key = ?', [
      key,
    ])
    assert.equal(row?.n, 0, '参数不合法就不该占键')
  })
})
