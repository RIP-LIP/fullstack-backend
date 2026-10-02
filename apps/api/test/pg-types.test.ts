import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, createProduct, createUser } from './harness.ts'
import type { Harness } from './harness.ts'
import { columnsOf } from './test-db.ts'
import { pgMigrations } from '../src/db/migrations/pg/index.ts'

/**
 * PostgreSQL 的取值规则。
 *
 * 换库最隐蔽的一类问题不在 SQL 上，在**读回来的值是什么类型**。
 * 同一个列名，SQLite 给字符串，PostgreSQL 给 Date；
 * 同一个函数，SQLite 给数字，`COUNT(*)` 在 PostgreSQL 里给字符串。
 *
 * 这些都不会报错。它们只是悄悄地变了形状，等某天有人
 * 拿 `===` 比一个 Date，或者把一个 id 塞进 JSON 里变成 `"1"`。
 *
 * 所以这一组测试的作用是：**把「读回来是什么」钉死**。
 */

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

describe('时间：timestamptz 读回来是字符串', () => {
  test('driver 把 Date 归一成了 ISO 字符串', async () => {
    await h.db.query('INSERT INTO users (email, created_at) VALUES (?, ?)', [
      'time-1@test.dev',
      new Date('2026-10-02T12:34:56.789Z').toISOString(),
    ])

    const row = await h.db.one<{ created_at: unknown }>(
      'SELECT created_at FROM users WHERE email = ?',
      ['time-1@test.dev'],
    )

    assert.equal(typeof row?.created_at, 'string', 'created_at 必须是字符串，不是 Date')
    assert.equal(row?.created_at, '2026-10-02T12:34:56.789Z')
  })

  test('接口返回的 createdAt 也还是字符串（契约没变）', async () => {
    const product = await createProduct(h.baseUrl, { name: '时间契约' })
    assert.equal(typeof product.createdAt, 'string', '接口契约要求 createdAt 是字符串')
    // 能被 Date 解析且反解回同一个瞬间，说明它是标准 ISO 串
    assert.equal(new Date(product.createdAt).toISOString(), product.createdAt)
  })
})

describe('整数：int4 是数字，int8 是字符串', () => {
  test('INTEGER 列读回来是 number', async () => {
    const id = await createUser(h.db)
    assert.equal(typeof id, 'number', 'int4 必须是 number')
    assert.ok(id > 0)
  })

  test('金额读回来是整数而不是字符串', async () => {
    const product = await createProduct(h.baseUrl, { priceCents: 39900 })
    assert.equal(typeof product.priceCents, 'number', 'priceCents 必须是 number')
    assert.equal(product.priceCents, 39900)
  })

  // 这一条是换库最容易踩的坑，而且症状极不明显。
  // COUNT(*) 在 PostgreSQL 里返回 bigint，pg 默认读成**字符串**。
  test('COUNT(*) 默认读回来是字符串，不是数字', async () => {
    const rows = await h.db.query<{ n: unknown }>('SELECT COUNT(*) AS n FROM products')
    assert.equal(typeof rows[0]?.n, 'string', 'COUNT(*) 在 pg 里是 bigint，默认读成字符串')
  })

  // 两条出路任选：转成 int，或者装一个类型解析器。
  // 本项目选前者，因为它只在用到的地方出现一次。
  test('CAST 成 int 之后就是数字', async () => {
    const rows = await h.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM products')
    assert.equal(typeof rows[0]?.n, 'number')
    assert.ok((rows[0]?.n ?? -1) > 0)
  })

  // 顺带把「静默丢精度」讲清楚：2^53 之后 number 就不再精确。
  test('2^53 以上的整数用 number 存就已经不精确了', () => {
    assert.equal(Number.MAX_SAFE_INTEGER, 9007199254740991)
    // 这两个数在 JS 里是同一个，因为都超过了安全整数上限
    assert.equal(Number('9007199254740993'), Number('9007199254740992'))
  })
})

describe('表结构：PRAGMA 的替代品', () => {
  test('columnsOf 列出 products 的全部列', async () => {
    const cols = await columnsOf(h.db, 'products')
    assert.deepEqual(cols, [
      'id',
      'sku',
      'name',
      'title',
      'description',
      'price_cents',
      'stock',
      'created_at',
    ])
  })

  // 换库时最容易漏的一处：SQLite 的基线是一张一张迁移建出来的，
  // PostgreSQL 的基线是一口气建全部表，所以「title 和 description 都在」
  // 变成了一个必须单独断言的事实，而不是迁移过程的副产品。
  test('基线直接建出了 name 和 title 两列（002 和 003 被折叠进来了）', async () => {
    const cols = await columnsOf(h.db, 'products')
    assert.ok(cols.includes('name'), '老列 name 必须在')
    assert.ok(cols.includes('title'), '新列 title 必须在')
  })

  // 对着迁移清单本身断言，不写死条数。写死的话每加一个迁移这条就红一次，
  // 而那次红跟「迁移有没有跑对」没关系——是测试自己过期了。
  test('版本表里的每一条都和迁移清单一一对上', async () => {
    const rows = await h.db.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version',
    )
    assert.equal(rows.length, pgMigrations.length)
    for (const [i, row] of rows.entries()) {
      assert.equal(row.version, pgMigrations[i]!.version)
      assert.equal(row.name, pgMigrations[i]!.name)
    }
  })

  // 这一条要单独钉住：PostgreSQL 这边的版本是**重新从 1 开始的**，
  // 不接着 SQLite 那三个版本。写死了条数就会在加迁移时失效，
  // 所以这里只钉「第一条是基线」这个不随章节变化的事实。
  test('版本 1 一定是基线，版本号从 1 重新开始', async () => {
    const first = await h.db.one<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version LIMIT 1',
    )
    assert.equal(first?.version, 1)
    assert.equal(first?.name, 'pg_baseline')
  })
})
