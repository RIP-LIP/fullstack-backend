/**
 * 校验规则的单元测试。
 *
 * 为什么这一份单独立一个文件测：CreateProductInput / CreateOrderInput /
 * TransitionInput 是**全项目唯一的入参真相源**。它们坏了两端一起坏，
 * 而且症状很隐蔽——界面上的表单可能照常工作，curl 也能绕过去。
 *
 * 走 HTTP 的集成测试会覆盖到一部分，但覆盖不到边界值：
 * 50 项的上限、999 件的上限、纯空格靠 trim 被拦下来、枚举提示语到底写了什么。
 * 那些是这套规则里最容易被改坏、又最不容易被发现的地方。
 *
 * 跑法：在仓库根目录 npm test
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { CreateProductInput, CreateOrderInput, TransitionInput, ORDER_STATUSES } from '../src/index.ts'

/** 取第一条错误信息，失败时把整个 issues 摊开看。 */
function firstMessage(parsed: { success: boolean; error?: { issues: Array<{ message: string }> } }): string {
  assert.equal(parsed.success, false, '这一条应该被拒绝')
  return parsed.error?.issues[0]?.message ?? '(没有错误信息)'
}

describe('CreateProductInput', () => {
  const valid = { sku: 'KB-87', name: '机械键盘', priceCents: 39900, stock: 25 }

  test('接受一个正常的商品', () => {
    assert.equal(CreateProductInput.safeParse(valid).success, true)
  })

  test('拒绝纯空格的 SKU（靠 trim，不是靠 min）', () => {
    const parsed = CreateProductInput.safeParse({ ...valid, sku: '     ' })
    assert.equal(firstMessage(parsed), 'SKU 不能为空')
  })

  test('缺少 sku 时用中文提示，不是 zod 默认的 Required', () => {
    const { sku: _drop, ...rest } = valid
    const parsed = CreateProductInput.safeParse(rest)
    assert.equal(firstMessage(parsed), 'SKU 不能为空')
  })

  test('拒绝小数价格，并且说清是「分」', () => {
    const parsed = CreateProductInput.safeParse({ ...valid, priceCents: 39.9 })
    assert.equal(firstMessage(parsed), '价格必须是以分计的整数，不能是小数')
  })

  test('接受价格为 0，但拒绝负数', () => {
    assert.equal(CreateProductInput.safeParse({ ...valid, priceCents: 0 }).success, true)
    const parsed = CreateProductInput.safeParse({ ...valid, priceCents: -1 })
    assert.equal(firstMessage(parsed), '价格不能是负数')
  })

  // 下面两条盯的是「错误在哪一层暴露」。
  // 少了上界，2147483648 会通过校验，然后在 INSERT 时让数据库报 22003，
  // 事务回滚，客户端拿到 500——原因完全在它自己发的请求里。
  test('拒绝超出 int4 范围的价格，在这一层就挡住', () => {
    const parsed = CreateProductInput.safeParse({ ...valid, priceCents: 2147483648 })
    assert.equal(firstMessage(parsed), '价格超出允许范围')
  })

  test('接受刚好等于上界的整数分', () => {
    assert.equal(CreateProductInput.safeParse({ ...valid, priceCents: 100_000_000 }).success, true)
  })

  test('库存同样有上界', () => {
    const parsed = CreateProductInput.safeParse({ ...valid, stock: 1_000_001 })
    assert.equal(firstMessage(parsed), '库存超出允许范围')
  })

  test('title 是可选的：expand 阶段老调用方只传 name', () => {
    assert.equal(CreateProductInput.safeParse(valid).success, true)
  })

  test('title 给了就必须非空', () => {
    const parsed = CreateProductInput.safeParse({ ...valid, title: '  ' })
    assert.equal(firstMessage(parsed), '标题不能为空')
  })
})

describe('CreateOrderInput', () => {
  const item = { productId: 1, quantity: 2 }
  const valid = { userId: 1, items: [item] }

  test('接受一个正常的一单', () => {
    assert.equal(CreateOrderInput.safeParse(valid).success, true)
  })

  test('items 不能是空数组', () => {
    const parsed = CreateOrderInput.safeParse({ ...valid, items: [] })
    assert.equal(firstMessage(parsed), '订单至少要有一项')
  })

  // 50 是边界，两个方向都要钉住。只测 51 的话，把 50 改成 49 是测不出来的。
  test('items 正好 50 项通过（边界）', () => {
    const items = Array.from({ length: 50 }, () => item)
    assert.equal(CreateOrderInput.safeParse({ ...valid, items }).success, true)
  })

  test('items 超过 50 项被拒（边界）', () => {
    const items = Array.from({ length: 51 }, () => item)
    const parsed = CreateOrderInput.safeParse({ ...valid, items })
    assert.equal(firstMessage(parsed), '一个订单最多 50 项')
  })

  test('单个商品一次最多 999 件（边界）', () => {
    assert.equal(CreateOrderInput.safeParse({ ...valid, items: [{ productId: 1, quantity: 999 }] }).success, true)
    const parsed = CreateOrderInput.safeParse({ ...valid, items: [{ productId: 1, quantity: 1000 }] })
    assert.equal(firstMessage(parsed), '单个商品一次最多 999 件')
  })

  test('数量必须是正整数，0 和小数都拒绝', () => {
    assert.equal(firstMessage(CreateOrderInput.safeParse({ ...valid, items: [{ productId: 1, quantity: 0 }] })), '数量至少是 1')
    assert.equal(firstMessage(CreateOrderInput.safeParse({ ...valid, items: [{ productId: 1, quantity: 1.5 }] })), '数量必须是整数')
  })

  test('userId 必须是正整数', () => {
    assert.equal(firstMessage(CreateOrderInput.safeParse({ ...valid, userId: 0 })), 'userId 必须是正整数')
    assert.equal(firstMessage(CreateOrderInput.safeParse({ ...valid, userId: 1.5 })), 'userId 必须是整数')
  })

  // 同一个 productId 出现两次是**允许**的，合并不合并交给业务决定。
  // 这条一旦被「顺手」改成去重，测试会立刻挂——所以它是有意的。
  test('同一个 productId 出现两次仍然通过（不在这一层合并）', () => {
    const parsed = CreateOrderInput.safeParse({ ...valid, items: [item, item] })
    assert.equal(parsed.success, true)
  })
})

describe('TransitionInput', () => {
  test('五个合法状态都接受', () => {
    for (const to of ORDER_STATUSES) {
      assert.equal(TransitionInput.safeParse({ to }).success, true, `${to} 应该是合法的`)
    }
  })

  test('拒绝枚举外的状态，并把五个合法值都写进提示里', () => {
    const parsed = TransitionInput.safeParse({ to: 'refunded' })
    const message = firstMessage(parsed)
    assert.match(message, /refunded/)
    for (const status of ORDER_STATUSES) {
      assert.ok(message.includes(status), `提示里应该列出 ${status}`)
    }
  })

  // 状态机的**转移**规则在 order-state.ts，这里只管**值域**。
  // 写成 'completed' 能过校验，不等于 completed 一定能转过去。
  test('合法值也未必能转过去：值域在这一层，转移在下一层', () => {
    assert.equal(TransitionInput.safeParse({ to: 'completed' }).success, true)
  })

  test('缺少 to 时用中文提示', () => {
    assert.equal(firstMessage(TransitionInput.safeParse({})), 'to 不能为空')
  })
})
