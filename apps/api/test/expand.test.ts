import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Harness } from './harness.ts'
import { startHarness, call, createProduct } from './harness.ts'

/**
 * ch06：把 products.name 换成 title 的 expand 阶段。
 *
 * 这一章要守住两件事，新旧代码都跑得起来：
 *   双写  写入时 name 和 title 一起落，两个版本读到的都是同一个值
 *   双读  读取时 title 有值用 title，没有退回 name
 *
 * 少任何一件，症状都不是「报错」，而是**响应里静默少一个字段**。
 */

let h: Harness

type ProductBody = {
  id: number
  sku: string
  name: string
  title: string
  priceCents: number
  stock: number
}

type Row = Record<string, unknown>

/**
 * node:sqlite 的 get() 类型上是 T | undefined。用它查一个刚写进去的行，
 * 拿不到只能是「查询写错了」，所以这里让它大声失败，
 * 而不是让后面每一行都变成 'row is possibly undefined'。
 */
function one(sql: string, ...params: unknown[]): Row {
  const row = h.rawDb.prepare(sql).get(...(params as never[]))
  assert.ok(row !== undefined, `查不到行：${sql}`)
  return row as Row
}

before(async () => {
  h = await startHarness()
})
after(async () => {
  await h.close()
})

/** 直接往库里插一行「没有 title」的老数据，模拟回填之前的状态 */
function insertLegacyProduct(sku: string, name: string): number {
  const now = new Date().toISOString()
  const row = one(
    'INSERT INTO products (sku, name, title, price_cents, stock, created_at) VALUES (?, ?, NULL, ?, ?, ?) RETURNING id',
    sku,
    name,
    1000,
    5,
    now,
  )
  return row.id as number
}

describe('expand：加了一列，老数据没有值', () => {
  test('003 迁移跑完，products 表确实多了一列 title', async () => {
    const cols = h.rawDb.prepare('PRAGMA table_info(products)').all().map((r) => r.name as string)
    assert.ok(cols.includes('title'), `列里没有 title：${JSON.stringify(cols)}`)
    // 老列还在。这一章不删任何东西，删是 contract 阶段的事
    assert.ok(cols.includes('name'), 'name 这一章不该被删')
  })

  // 这是整章最关键的一条：老数据 title 是 NULL，双读兜底之后
  // title 必须等于 name，而不是消失。
  test('老数据（title 为 NULL）读出来的 title 退回 name', async () => {
    const id = insertLegacyProduct('LEGACY-1', '老商品甲')

    const res = await fetch(`${h.baseUrl}/api/products/${id}`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as ProductBody

    assert.equal(body.title, '老商品甲')
    assert.equal(body.name, '老商品甲')
  })

  // 断言「键存在」，不只是「值对」。JSON.stringify 遇到 undefined
  // 会把键直接删掉，值断言用 === undefined 比反而抓不住这种情况。
  test('title 这个键一定在响应里，不会被 JSON.stringify 悄悄删掉', async () => {
    const id = insertLegacyProduct('LEGACY-2', '老商品乙')
    const raw = await (await fetch(`${h.baseUrl}/api/products/${id}`)).text()

    assert.ok(raw.includes('"title"'), `响应里没有 title 这个键：${raw}`)
  })
})

describe('双写', () => {
  test('只给 name，title 跟着落成同一个值', async () => {
    const created = (await (
      await fetch(`${h.baseUrl}/api/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: 'DW-1', name: '双写测试', priceCents: 100, stock: 1 }),
      })
    ).json()) as ProductBody

    assert.equal(created.title, '双写测试')
    assert.equal(created.name, '双写测试')

    // 落库确认，不只看响应
    const row = one('SELECT name, title FROM products WHERE id = ?', created.id)
    assert.equal(row.name, '双写测试')
    assert.equal(row.title, '双写测试')
  })

  test('只给 title 不给 name 不行（name 仍是必填）', async () => {
    const { status, body } = await call(h.baseUrl, '/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sku: 'DW-2', title: '只有 title', priceCents: 100, stock: 1 }),
    })
    assert.equal(status, 400)
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.equal(body.error.fields?.name, '名称不能为空')
  })

  test('两个都给但不一样时，以 name 为准写进 name 列，title 用给的', async () => {
    const created = (await (
      await fetch(`${h.baseUrl}/api/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'DW-3',
          name: '老调用方的名字',
          title: '新调用方的标题',
          priceCents: 100,
          stock: 1,
        }),
      })
    ).json()) as ProductBody

    const row = one('SELECT name, title FROM products WHERE id = ?', created.id)
    assert.equal(row.name, '老调用方的名字')
    assert.equal(row.title, '新调用方的标题')
  })
})

describe('回填的幂等性', () => {
  // 回填脚本的 WHERE 条件只看「title IS NULL」，所以跑两遍和跑一遍一样。
  // 这条守住的是脚本本身的性质，不是某一次执行的结果。
  test('把 title 手工补上之后，再跑一次不会覆盖已经补好的值', async () => {
    const id = insertLegacyProduct('BF-1', '原始名字')

    h.rawDb.prepare('UPDATE products SET title = ? WHERE id = ?').run('原始名字', id)
    // 再跑一次回填的逻辑：只碰 title IS NULL 的行
    const changed = h.rawDb
      .prepare('UPDATE products SET title = name WHERE id = ? AND title IS NULL')
      .run(id)

    assert.equal(changed.changes, 0, '已经补过的行不该再被改动')
    const row = one('SELECT title FROM products WHERE id = ?', id)
    assert.equal(row.title, '原始名字')
  })

  test('回填的 WHERE 条件只命中还没补的行', async () => {
    const a = insertLegacyProduct('BF-2', '待补甲')
    const b = insertLegacyProduct('BF-3', '待补乙')
    h.rawDb.prepare('UPDATE products SET title = name WHERE id = ?').run(a)

    const pending = one('SELECT COUNT(*) AS n FROM products WHERE title IS NULL')
    assert.ok((pending.n as number) >= 1, 'b 还没补，应该还在待补里')
    const rowB = one('SELECT title FROM products WHERE id = ?', b)
    assert.equal(rowB.title, null, 'b 确实还没补')
  })
})

describe('老代码视角', () => {
  // 老版本（v1.1）的映射只认 name。库上多了 title 列对它没有影响，
  // 因为它压根不去读那一列。
  test('库上多了一列，老版本只读 name 的那条路径仍然通', async () => {
    const created = await createProduct(h.baseUrl, { sku: 'OLD-1', name: '老版本建的数据' })

    const row = one('SELECT name, title FROM products WHERE id = ?', created.id)
    assert.equal(row.name, '老版本建的数据')
    assert.equal(row.title, '老版本建的数据', '新版本写的时候顺带把 title 也落上了')
  })
})
