import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createUser } from './harness.ts'
import type { Harness } from './harness.ts'

/**
 * 事务本身的测试。
 *
 * 这个文件是整章的命门。它守的是一条**曾经不成立**的性质：
 *
 *   事务失败时，只有它自己写的那些行被回滚。
 *   别的请求在同一时刻写的行，必须活着。
 *
 * 原来的实现没有这道门，「别的请求的写入被卷进事务一起回滚」是真实发生过的：
 * 那个请求拿到 200，日志干净，数据没了。
 *
 * ## 怎么证明这些测试不是空转
 *
 * 把 `db/sqlite.ts` 里 `withConnection` 的排队去掉（让 query/one 直接
 * 执行），再跑这个文件，「并发请求的写入不会被吞掉」那一条必须挂。
 * 挂掉的名字见 commit message。
 */

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

/** 直接往库里写一行，返回它的 id。用来看某一行到底还在不在。 */
let seq = 0
function rawInsert(table: string, note: string): number {
  seq += 1
  const now = new Date().toISOString()
  if (table === 'users') {
    h.rawDb.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').run(`${note}-${seq}`, now)
  } else {
    h.rawDb.prepare('INSERT INTO products (sku, name, title, price_cents, stock, created_at) VALUES (?,?,?,?,?,?)')
      .run(`${note}-${seq}`, note, note, 100, 1, now)
  }
  const col = table === 'users' ? 'email' : 'sku'
  const row = h.rawDb.prepare(`SELECT id FROM ${table} WHERE ${col} = ?`).get(`${note}-${seq}`) as { id: number }
  return row.id
}

function rowExists(table: 'users' | 'products', id: number): boolean {
  const row = h.rawDb.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) as { id: number } | undefined
  return row !== undefined
}

test('事务失败时，它自己写的行被回滚', async () => {
  const userId = createUser(h.rawDb)
  const insideId = rawInsert('products', 'tx-own')

  await assert.rejects(
    h.db.transaction(async (tx) => {
      await tx.query('INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?)', [
        'own-sku', 'x', 'x', 1, 1, new Date().toISOString(),
      ])
      throw new Error('故意失败')
    }),
    /故意失败/,
  )

  assert.equal(rowExists('products', insideId), true, '这里的行是提前造的，不该被回滚')
  const leftovers = h.rawDb.prepare("SELECT COUNT(*) AS n FROM products WHERE sku = 'own-sku'").get() as { n: number }
  assert.equal(leftovers.n, 0, '事务里写的行必须被回滚')
  assert.ok(userId > 0)
})

test('并发请求的写入不会被事务回滚吞掉', async () => {
  // 这是这一章的核心断言。
  //
  // 事务体里 await 一个定时器 = 让出事件循环 = 给别的请求一个插进来的窗口。
  // 旧实现在这个窗口里让另一个请求的写语句执行进了自己的事务，
  // 事务一失败，那一行就跟着消失了。
  //
  // 注意「另一个请求」走的是 h.db.query 而不是 h.rawDb——
  // 前者是接口层，真实路由用的就是它；后者是原始连接，绕过了所有门。
  // 用 rawDb 的话这条测试永远通不过，而且通过与否和门没关系。
  const concurrentSku = `concurrent-${Date.now()}`
  const otherId = rawInsert('products', 'other-request')

  const failing = h.db.transaction(async (tx) => {
    await tx.query('INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?)', [
      'tx-sku', 'x', 'x', 1, 1, new Date().toISOString(),
    ])
    // 关键：让出事件循环
    await new Promise((r) => setTimeout(r, 40))
    throw new Error('事务失败')
  })

  // 在事务还开着的时候，让「另一个请求」往同一条连接上写。
  // 没有门的话这句会立刻执行在那个事务里，跟着一起回滚。
  const other = (async () => {
    await new Promise((r) => setTimeout(r, 10))
    await h.db.query('INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?)', [
      concurrentSku, 'concurrent', 'concurrent', 1, 1, new Date().toISOString(),
    ])
  })()

  const results = await Promise.allSettled([failing, other])
  assert.equal(results[0].status, 'rejected')
  assert.equal(results[1].status, 'fulfilled')

  // 这一行是「另一个请求」提前造的，它的成功和这个事务无关，必须活着
  assert.equal(rowExists('products', otherId), true, '另一个请求提前造的行不该被吞')

  const concurrent = h.rawDb
    .prepare('SELECT COUNT(*) AS n FROM products WHERE sku = ?')
    .get(concurrentSku) as { n: number }
  assert.equal(concurrent.n, 1, '事务窗口里那个请求的写入必须存活，不能跟着回滚消失')

  const txLeftovers = h.rawDb.prepare("SELECT COUNT(*) AS n FROM products WHERE sku = 'tx-sku'").get() as { n: number }
  assert.equal(txLeftovers.n, 0, '事务自己写的行仍然要回滚')
})

test('并发的事务排队执行，不会互相踩', async () => {
  const first = h.db.transaction(async (tx) => {
    await tx.query('INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?)', [
      'ser-1', 'x', 'x', 1, 1, new Date().toISOString(),
    ])
    await new Promise((r) => setTimeout(r, 30))
    return 'first'
  })

  // 第二个事务在第一个还开着的时候就来
  const second = h.db.transaction(async (tx) => {
    await tx.query('INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?)', [
      'ser-2', 'x', 'x', 1, 1, new Date().toISOString(),
    ])
    return 'second'
  })

  const out = await Promise.all([first, second])
  assert.deepEqual(out, ['first', 'second'])

  const rows = h.rawDb
    .prepare("SELECT sku FROM products WHERE sku IN ('ser-1','ser-2') ORDER BY sku")
    .all() as Array<{ sku: string }>
  assert.deepEqual(rows.map((r) => r.sku), ['ser-1', 'ser-2'], '两个事务都要提交成功')
})

test('嵌套事务报项目自己的错，不是 SQLite 的原始报错', async () => {
  const { NestedTransactionError } = await import('../src/db/sqlite.ts')

  await assert.rejects(
    h.db.transaction(async () => {
      await h.db.transaction(async () => {
        throw new Error('不该走到这里')
      })
    }),
    (err: unknown) => {
      assert.ok(err instanceof NestedTransactionError, '必须是项目自己的错误类型')
      assert.match((err as Error).message, /不支持嵌套事务/)
      // 关键：不能是 SQLite 那句
      assert.doesNotMatch((err as Error).message, /SQLITE|cannot start a transaction/)
      return true
    },
  )
})

test('事务失败后连接还能继续用，不会把后面所有请求卡死', async () => {
  await assert.rejects(
    h.db.transaction(async (tx) => {
      await tx.query('INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?)', [
        'after-fail', 'x', 'x', 1, 1, new Date().toISOString(),
      ])
      throw new Error('炸了')
    }),
  )

  // 如果释放队列的那句放错了位置（不在 finally 里），这里会一直挂着直到超时。
  const row = await h.db.one<{ id: number }>("SELECT id FROM products WHERE sku = 'after-fail'")
  assert.equal(row, undefined)

  const ok = rawInsert('products', 'after-recovery')
  assert.equal(rowExists('products', ok), true, '事务失败之后连接必须还能用')
})

test('事务的返回值能传出来', async () => {
  const value = await h.db.transaction(async (tx) => {
    const row = await tx.one<{ id: number }>('SELECT id FROM users LIMIT 1')
    return row?.id ?? 0
  })
  assert.equal(typeof value, 'number')
})

test('事务里 COMMIT 之后的普通查询正常', async () => {
  const id = await h.db.transaction(async (tx) => {
    const rows = await tx.query<{ id: number }>(
      'INSERT INTO products (sku,name,title,price_cents,stock,created_at) VALUES (?,?,?,?,?,?) RETURNING id',
      ['commit-ok', 'x', 'x', 1, 1, new Date().toISOString()],
    )
    return rows[0]?.id ?? 0
  })
  assert.ok(id > 0)
  assert.equal(rowExists('products', id), true, 'COMMIT 之后数据要真的在')
})
