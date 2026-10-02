import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createProduct, call } from './harness.ts'
import type { Harness, ProductBody } from './harness.ts'

/**
 * 商品接口的行为。
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

/** 发一个 POST，body 已经是字符串（有些用例要故意写坏 JSON） */
function post(base: string, raw: string) {
  return call(base, '/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  })
}

describe('GET /api/products', () => {
  test('一个商品都没有时返回空数组，不是 404 也不是 null', async () => {
    const res = await fetch(`${h.baseUrl}/api/products`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.ok(Array.isArray(body), '必须是数组，前端才能直接 .map')
    assert.equal(body.length, 0)
  })

  test('多个商品按 id 倒序返回', async () => {
    const a = await createProduct(h.baseUrl, { name: '先建的' })
    const b = await createProduct(h.baseUrl, { name: '后建的' })

    const res = await fetch(`${h.baseUrl}/api/products`)
    const list = (await res.json()) as ProductBody[]

    assert.ok(list[0]!.id > list[list.length - 1]!.id, '应当最新的在前')
    assert.ok(list.some((p) => p.id === a.id))
    assert.ok(list.some((p) => p.id === b.id))
  })
})

describe('POST /api/products', () => {
  test('合法输入返回 201，并带上数据库自动发的 id', async () => {
    const { status, body } = await post(
      h.baseUrl,
      JSON.stringify({ sku: 'NEW-1', name: '机械键盘', priceCents: 39900, stock: 25 }),
    )
    assert.equal(status, 201)

    const product = (body as unknown as ProductBody)
    assert.equal(typeof product.id, 'number')
    assert.equal(product.sku, 'NEW-1')
    assert.equal(product.priceCents, 39900)
    assert.equal(product.stock, 25)
    assert.match(product.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'createdAt 要是 ISO 字符串')
  })

  test('缺 name 返回 400，并在 fields 里点名 name', async () => {
    const { status, body } = await post(h.baseUrl, JSON.stringify({ sku: 'X-1', priceCents: 100, stock: 1 }))
    assert.equal(status, 400)
    assert.equal(body.error.code, 'VALIDATION_FAILED')
    assert.equal(body.error.fields!.name, '名称不能为空')
  })

  test('name 是空白时报错，不是空白去掉后存一个空名字进去', async () => {
    const { status, body } = await post(
      h.baseUrl,
      JSON.stringify({ sku: 'X-2', name: '   ', priceCents: 100, stock: 1 }),
    )
    assert.equal(status, 400)
    assert.equal(body.error.fields!.name, '名称不能为空')
  })

  test('priceCents 是小数返回 400，并说明为什么不能用小数', async () => {
    const { status, body } = await post(
      h.baseUrl,
      JSON.stringify({ sku: 'X-3', name: '带小数的价', priceCents: 19.99, stock: 1 }),
    )
    assert.equal(status, 400)
    assert.equal(body.error.fields!.priceCents, '价格必须是以分计的整数，不能是小数')
  })

  test('priceCents 是负数返回 400', async () => {
    const { status, body } = await post(
      h.baseUrl,
      JSON.stringify({ sku: 'X-4', name: '负价', priceCents: -1, stock: 1 }),
    )
    assert.equal(status, 400)
    assert.equal(body.error.fields!.priceCents, '价格不能是负数')
  })

  test('stock 是小数返回 400', async () => {
    const { status, body } = await post(
      h.baseUrl,
      JSON.stringify({ sku: 'X-5', name: '半个库存', priceCents: 100, stock: 1.5 }),
    )
    assert.equal(status, 400)
    assert.equal(body.error.fields!.stock, '库存必须是非负整数')
  })

  test('sku 重复返回 409，不是 400 也不是 500', async () => {
    await createProduct(h.baseUrl, { sku: 'DUP-1', name: '第一个' })
    const { status, body } = await post(
      h.baseUrl,
      JSON.stringify({ sku: 'DUP-1', name: '第二个', priceCents: 100, stock: 1 }),
    )
    assert.equal(status, 409, `重复 sku 应当是 409，实际 ${status}`)
    assert.equal(body.error.code, 'PRODUCT_SKU_TAKEN')
  })

  test('请求体不是合法 JSON 返回 400 而不是 500', async () => {
    const { status, body } = await post(h.baseUrl, '{"sku": "Y-1"')
    assert.equal(status, 400)
    assert.equal(body.error.code, 'INVALID_JSON')
  })
})

describe('GET /api/products/:id', () => {
  test('存在的 id 返回 200', async () => {
    const p = await createProduct(h.baseUrl, { name: '查得到的' })
    const res = await fetch(`${h.baseUrl}/api/products/${p.id}`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as ProductBody
    assert.equal(body.name, '查得到的')
  })

  test('不存在的 id 返回 404，且 code 是 PRODUCT_NOT_FOUND', async () => {
    const { status, body } = await call(h.baseUrl, '/api/products/999999')
    assert.equal(status, 404)
    assert.equal(body.error.code, 'PRODUCT_NOT_FOUND')
  })

  test('id 不是数字返回 400，不是 404', async () => {
    // 这里最容易写错：参数本身不合法，报 404 会让人以为是「没这个商品」，
    // 于是换个 id 再试。真正的问题是请求就不合法。
    const { status, body } = await call(h.baseUrl, '/api/products/abc')
    assert.equal(status, 400)
    assert.equal(body.error.code, 'INVALID_PARAM')
  })

  test('id 是小数返回 400', async () => {
    const { status, body } = await call(h.baseUrl, '/api/products/1.5')
    assert.equal(status, 400)
    assert.equal(body.error.code, 'INVALID_PARAM')
  })
})

describe('DELETE /api/products/:id', () => {
  test('删一个没人引用的商品返回 204 且响应体为空', async () => {
    const p = await createProduct(h.baseUrl)
    const res = await fetch(`${h.baseUrl}/api/products/${p.id}`, { method: 'DELETE' })
    assert.equal(res.status, 204)
    assert.equal(await res.text(), '', '204 不该有响应体')
  })

  test('不存在的 id 返回 404', async () => {
    const { status, body } = await call(h.baseUrl, '/api/products/999999', { method: 'DELETE' })
    assert.equal(status, 404)
    assert.equal(body.error.code, 'PRODUCT_NOT_FOUND')
  })

  test('同一个 id 连删两次，第二次返回 404', async () => {
    const p = await createProduct(h.baseUrl)
    const first = await fetch(`${h.baseUrl}/api/products/${p.id}`, { method: 'DELETE' })
    assert.equal(first.status, 204)

    const second = await call(h.baseUrl, `/api/products/${p.id}`, { method: 'DELETE' })
    assert.equal(second.status, 404)
  })

  test('删完之后再查单条返回 404', async () => {
    const p = await createProduct(h.baseUrl)
    await fetch(`${h.baseUrl}/api/products/${p.id}`, { method: 'DELETE' })
    const { status } = await call(h.baseUrl, `/api/products/${p.id}`)
    assert.equal(status, 404)
  })
})

describe('金额原样往返', () => {
  test('以分存的整数读回来还是整数，不会变成小数', async () => {
    // 前端拿到 399.00 还是 39900，决定了它怎么显示和怎么累加。
    // 少了这一步转换，接口就等于悄悄改了数据。
    const p = await createProduct(h.baseUrl, { priceCents: 39900 })
    const res = await fetch(`${h.baseUrl}/api/products/${p.id}`)
    const body = (await res.json()) as ProductBody
    assert.equal(body.priceCents, 39900)
    assert.equal(typeof body.priceCents, 'number')
    assert.ok(Number.isInteger(body.priceCents), '必须是整数，读成 399.0 说明中途被除过 100')
  })
})
