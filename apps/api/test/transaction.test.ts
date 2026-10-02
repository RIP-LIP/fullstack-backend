import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './harness.ts'
import type { Harness } from './harness.ts'
import { NestedTransactionError } from '../src/db/errors.ts'

/**
 * 事务本身的测试。
 *
 * 这个文件是整章的命门。它守的是一条**曾经不成立**的性质：
 *
 *   事务失败时，只有它自己写的那些行被回滚。
 *   别的请求在同一时刻写的行，必须活着。
 *
 * SQLite 时代那版实现的失败是真实发生过的：整个进程只有一条连接，
 * 事务体 await 出去的时候，别的请求的写语句执行进了这个事务，
 * 跟着它一起回滚。那个请求拿到 200，日志干净，数据没了。
 *
 * ## 换库之后，这条性质一个字节都没变，机制全变了
 *
 * 换到连接池之后，「排队」那一半没了——池把两条连接发出去，
 * 两个事务各写各的，物理上就不可能卷进对方的事务。
 *
 * 所以这一组测试的意义变了：它不再是「证明我加了道门」，
 * 而是**证明换库没有把这条性质弄丢**。少了它，
 * 「换库是安全的」这句话就没有任何证据。
 *
 * ## 怎么证明这些测试不是空转
 *
 * 把 `db/postgres.ts` 里 `transaction` 的 `client.release()`
 * 从 `finally` 挪到 `try` 的成功分支上（回滚路径不还连接），
 * 再跑这个文件，「事务失败后连接还能继续用」那一条必须挂。
 * 挂掉的名字见 commit message。
 */

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

let seq = 0

/** 造一件商品，返回它的 id。 */
async function makeProduct(stock = 1): Promise<number> {
  seq += 1
  const rows = await h.db.query<{ id: number }>(
    `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
     VALUES (?, ?, ?, 100, ?, ?) RETURNING id`,
    [`TX-${Date.now()}-${seq}`, `tx-${seq}`, `tx-${seq}`, stock, new Date().toISOString()],
  )
  const row = rows[0]
  assert.ok(row !== undefined, '造商品没有返回行')
  return row.id
}

async function stockOf(id: number): Promise<number> {
  const row = await h.db.one<{ stock: number }>('SELECT stock FROM products WHERE id = ?', [id])
  assert.ok(row !== undefined, `商品 ${id} 不存在`)
  return row.stock
}

test('事务失败时，它自己写的行被回滚', async () => {
  const before = await makeProduct(5)

  await assert.rejects(
    h.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
         VALUES (?, ?, ?, 1, 1, ?)`,
        ['own-sku', 'x', 'x', new Date().toISOString()],
      )
      throw new Error('故意失败')
    }),
    /故意失败/,
  )

  // 事务里写的行必须没了
  const leftovers = await h.db.query<{ id: number }>('SELECT id FROM products WHERE sku = ?', ['own-sku'])
  assert.equal(leftovers.length, 0, '事务里写的行必须被回滚')

  // 事务之前就存在的行必须还在。回滚不该碰到不属于这个事务的东西。
  assert.equal(await stockOf(before), 5, '事务之前的行不该被这次回滚带走')
})

test('两个并发事务各写各的，一个回滚不带走另一个', async () => {
  // 这一条换库之后换了机制，但守的还是同一件事。
  const failing = h.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
       VALUES (?, ?, ?, 1, 1, ?)`,
      ['failing-sku', 'x', 'x', new Date().toISOString()],
    )
    // 让出事件循环，给另一个事务一个插进来的窗口。
    // SQLite 那一版的 bug 就是在这个窗口里被卷走的。
    await new Promise((r) => setTimeout(r, 30))
    throw new Error('事务失败')
  })

  const other = (async () => {
    await new Promise((r) => setTimeout(r, 10))
    await h.db.query(
      `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
       VALUES (?, ?, ?, 1, 1, ?)`,
      ['other-sku', 'x', 'x', new Date().toISOString()],
    )
  })()

  const results = await Promise.allSettled([failing, other])
  assert.equal(results[0]?.status, 'rejected', '第一个事务必须失败')
  assert.equal(results[1]?.status, 'fulfilled', '第二个事务必须成功')

  const survivor = await h.db.query<{ id: number }>('SELECT id FROM products WHERE sku = ?', ['other-sku'])
  assert.equal(survivor.length, 1, '另一个事务写的那一行必须活着，不能跟着回滚消失')

  const dead = await h.db.query<{ id: number }>('SELECT id FROM products WHERE sku = ?', ['failing-sku'])
  assert.equal(dead.length, 0, '失败事务自己写的行仍然要回滚')
})

test('两个事务并发提交，都不丢', async () => {
  const make = (sku: string, ms: number) =>
    h.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
         VALUES (?, ?, ?, 1, 1, ?)`,
        [sku, 'x', 'x', new Date().toISOString()],
      )
      await new Promise((r) => setTimeout(r, ms))
      return sku
    })

  const out = await Promise.all([make('par-1', 30), make('par-2', 5)])
  assert.deepEqual(out, ['par-1', 'par-2'])

  const rows = await h.db.query<{ sku: string }>(
    'SELECT sku FROM products WHERE sku IN (?, ?) ORDER BY sku',
    ['par-1', 'par-2'],
  )
  assert.deepEqual(rows.map((r) => r.sku), ['par-1', 'par-2'], '两个事务都要提交成功')
})

test('嵌套事务报项目自己的错，不是数据库的原始报错', async () => {
  await assert.rejects(
    h.db.transaction(async () => {
      await h.db.transaction(async () => {
        throw new Error('不该走到这里')
      })
    }),
    (err: unknown) => {
      assert.ok(err instanceof NestedTransactionError, '必须是项目自己的错误类型')
      assert.match((err as Error).message, /不支持嵌套事务/)
      // 关键：不能是数据库那句原文。
      // PostgreSQL 的原文是 BEGIN，SQLite 那句是
      // cannot start a transaction within a transaction——两个都不是。
      assert.doesNotMatch((err as Error).message, /SQLITE|cannot start a transaction|^BEGIN$/)
      return true
    },
  )
})

test('事务失败后连接还能继续用，不会把池耗光', async () => {
  // 如果 release() 放错了位置（不在 finally 里），失败的事务就永远不还连接。
  // 一次看不出来——池还有空位。**必须失败得比池的空位多。**
  // 池的 max 是 10，所以这里连着失败 15 次。
  //
  // 池被耗光之后，第 11 个 `pool.connect()` **永远不返回**。
  // 所以整个探测段必须套一个超时：
  // 一个会挂住的回归守卫比一个会失败的糟糕得多——
  // 挂住的时候你看到的是「测试超时」，看不出是哪一条规则被破坏了。
  const POOL_MAX = Number(process.env.PG_POOL_MAX ?? 10)
  const LEAKS = POOL_MAX + 5

  const probe = (async () => {
    for (let i = 0; i < LEAKS; i += 1) {
      await assert.rejects(
        h.db.transaction(async (tx) => {
          await tx.query(
            `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
             VALUES (?, ?, ?, 1, 1, ?)`,
            [`leak-${i}`, 'x', 'x', new Date().toISOString()],
          )
          throw new Error('每一次都失败')
        }),
        /每一次都失败/,
      )
    }
    // 连接还在，说明每次失败都还回去了
    const row = await h.db.one<{ id: number }>('SELECT id FROM users LIMIT 1')
    return row === undefined || typeof row.id === 'number' ? 'ok' : 'ok'
  })()

  const verdict = await Promise.race([
    probe,
    new Promise((r) => setTimeout(() => r('耗光了'), 3000)),
  ])
  assert.equal(
    verdict,
    'ok',
    `连接池被耗光了：失败的事务没有把连接还回去。池的 max 是 ${POOL_MAX}，这里失败了 ${LEAKS} 次`,
  )

  const id = await makeProduct(3)
  assert.equal(await stockOf(id), 3, '事务失败之后连接必须还能用')
})

test('事务的返回值能传出来', async () => {
  const value = await h.db.transaction(async (tx) => {
    const row = await tx.one<{ id: number }>('SELECT id FROM users LIMIT 1')
    return row?.id ?? 0
  })
  assert.equal(typeof value, 'number')
})

test('COMMIT 之后的普通查询能看到刚写进去的行', async () => {
  const id = await h.db.transaction(async (tx) => {
    const rows = await tx.query<{ id: number }>(
      `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
       VALUES (?, ?, ?, 1, 1, ?)
       RETURNING id`,
      ['commit-ok', 'x', 'x', new Date().toISOString()],
    )
    return rows[0]?.id ?? 0
  })
  assert.ok(id > 0)
  assert.equal(await stockOf(id), 1, 'COMMIT 之后数据要真的在')
})
