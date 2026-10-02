import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createProduct } from './harness.ts'
import type { Harness, ProductBody } from './harness.ts'

/**
 * 为什么金额存整数分。
 *
 * 这一组测试不是为了测业务，是为了让浮点的错在读者的机器上真的发生一次。
 * 只写结论的话，下次遇到对账差一分钱的人不会知道该往哪看。
 *
 * 下面每一个「会错」的数字都在本机实跑确认过。下面这组数**不会**错：
 * 0.999 + 1.5 + 0.501、19.99 * 3、9.99 + 0.01、29.9 + 10.1、1234.56 + 0.44。
 * 写教程最容易出的错就是「随便挑几个数说它们会错」——挑到不会错的，整章就废了。
 */

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

describe('浮点数存钱会错', () => {
  test('0.1 + 0.2 不等于 0.3', () => {
    // 地基：不是 SQLite 的问题，是二进制浮点表示不了 0.1。
    assert.equal(0.1 + 0.2 === 0.3, false)
    assert.equal(0.1 + 0.2, 0.30000000000000004)
  })

  test('三件 8.2 元的商品总价不等于 24.6', () => {
    // 比 0.1 + 0.2 更像真实业务：按单价乘数量再汇总，是每个购物车都在做的事。
    assert.equal(8.2 * 3 === 24.6, false)
    assert.equal(8.2 * 3, 24.599999999999998)
  })

  test('SQLite 用 REAL 列算同一个总价，错的数会落进库里', () => {
    // 换成 REAL 存钱，错的不是内存里的数，是**存下来的数**。
    // 对账时你看到的就是一个说不清来由的 24.599999999999998。
    h.rawDb.exec('CREATE TABLE money_demo_real (price REAL, qty INTEGER)')
    h.rawDb.exec('INSERT INTO money_demo_real (price, qty) VALUES (8.2, 3)')

    const rows = h.rawDb
      .prepare('SELECT price * qty AS total FROM money_demo_real')
      .get() as { total: number } | undefined

    assert.ok(rows !== undefined)
    assert.equal(rows.total, 24.599999999999998)
  })

  test('用「元 × 100」换成分，这一步自己就会错', () => {
    // 这条是「接口为什么也收分、而不只是数据库存分」的理由。
    // 大多数人以为只要数据库存整数就够了，忘了从元转分这一步就已经偏了。
    assert.equal(4.35 * 100 === 435, false)
    assert.equal(4.35 * 100, 434.99999999999994)
    assert.equal(1.005 * 100 === 100.5, false)
  })
})

describe('整数分求和精确', () => {
  test('同样两个数，换成分之后求和是对的', () => {
    // 0.1 元 = 10 分，0.2 元 = 20 分。10 + 20 是整数运算，一个二进制位都不会偏。
    const totalCents = 10 + 20
    assert.equal(totalCents, 30)
    assert.equal(totalCents / 100, 0.3, '只有最后显示的时候才除 100')
  })

  test('三件 8.2 元的商品，用分算是精确的 2460', async () => {
    // 走一遍真实路径：建三个同价商品，把单价加起来。
    // 断言的是「加完之后正好是 2460 分」，不是「差不多 24.6 块」。
    const products: ProductBody[] = []
    for (let i = 0; i < 3; i += 1) {
      products.push(await createProduct(h.baseUrl, { name: `8块2的商品${i}`, priceCents: 820 }))
    }

    const totalCents = products.reduce((sum, p) => sum + p.priceCents, 0)

    assert.equal(totalCents, 2460)
    assert.equal(8.2 * 3 !== totalCents / 100, true, '浮点路径会给出一个不一样的数')
  })

  test('单价从 8.2 元转成 820 分时，接口要的就是整数本身，不是算出来的', () => {
    // 上游发来 820，前端直接展示 8.2。全程没有出现过 8.2 这个浮点数。
    const priceCents = 820
    assert.ok(Number.isInteger(priceCents))
    assert.equal(priceCents / 100, 8.2)
  })
})
