import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness } from './harness.ts'
import type { Harness } from './harness.ts'
import { migrate, MigrationError } from '../src/db/migrate.ts'
import type { Migration } from '../src/db/migrate.ts'
import { m001 } from '../src/db/migrations/001_init.ts'
import { m002 } from '../src/db/migrations/002_add_product_description.ts'
import type { Db } from '../src/db/index.ts'

/**
 * 迁移的行为。
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

/**
 * 开一个一次性的库，跑完回调后立刻关掉并删掉。
 *
 * createDb 必须动态 import：src/db/sqlite.ts 在模块顶层就 await migrate(db)，
 * 静态 import 会在 before() 设好 DB_PATH **之前**执行，于是它拿着默认路径
 * 把开发库打开并跑一遍迁移。测试就会打到开发数据上。
 */
async function withTempDb(fn: (db: Db, raw: import('node:sqlite').DatabaseSync) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-test-'))
  const { createDb } = await import('../src/db/sqlite.ts')
  const handle = createDb(join(dir, 'm.db'))
  try {
    await fn(handle.db, handle.raw)
  } finally {
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function columnsOf(raw: import('node:sqlite').DatabaseSync, table: string): Promise<string[]> {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r['name']))
}

describe('全新库跑迁移', () => {
  test('应用完所有迁移，schema_migrations 里每个版本各一行', async () => {
    const rows = await h.db.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    assert.equal(rows.length, 2)
    assert.equal(rows[0]!.version, 1)
    assert.equal(rows[0]!.name, 'init')
    assert.equal(rows[1]!.version, 2)
    assert.equal(rows[1]!.name, 'add_product_description')
    assert.ok(rows[0]!.checksum.length > 0, 'checksum 不能是空串')
  })

  test('四张业务表都在', async () => {
    const rows = await h.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    const names = rows.map((r) => r.name)
    for (const t of ['order_items', 'orders', 'products', 'users']) {
      assert.ok(names.includes(t), `缺少表 ${t}`)
    }
  })
})

describe('重复跑迁移是幂等的', () => {
  test('再跑一次，一个新版本都不执行', async () => {
    const ran = await migrate(h.db)
    assert.deepEqual(ran, [], '全部版本都应用过了，不该再跑')
  })

  test('跑三次和跑一次，schema_migrations 的行数一样', async () => {
    const before = await h.db.query<{ version: number }>('SELECT version FROM schema_migrations')
    await migrate(h.db)
    await migrate(h.db)
    const after = await h.db.query<{ version: number }>('SELECT version FROM schema_migrations')
    assert.equal(after.length, before.length)
  })
})

describe('已应用的迁移被改写时要停下', () => {
  test('版本号在、内容不同，抛 MigrationError', async () => {
    // 同一个 version=1，但 up 的内容不一样了——相当于有人回头改了 001。
    const tampered: Migration = {
      version: 1,
      name: 'init',
      async up(db: Db): Promise<void> {
        // 内容和真的 001 不一样，但版本号一样
        await db.query('CREATE TABLE something_else (id INTEGER PRIMARY KEY)')
      },
    }

    await assert.rejects(
      () => migrate(h.db, [tampered, m002]),
      (err: unknown) => {
        assert.ok(err instanceof MigrationError, `应当抛 MigrationError，实际 ${err}`)
        assert.match(err.message, /内容被改过/)
        return true
      },
    )
  })

  test('停下的时候，后面的迁移一个都不会跑', async () => {
    // 这条是上面那条的补充，而且必须有。
    // 只断言「没建出某张表」是不够的：checksum 校验坏掉时迁移是被**跳过**的，
    // 同样一张表都不会建，两种行为都能让那种断言通过。
    // 真正要区分的是「抛错停下」和「静默跳过」——
    // 所以这里在后面放一个会建表的迁移：抛错 → 它没机会跑；跳过 → 它照跑。
    const decoy: Migration = {
      version: 2,
      name: 'decoy',
      async up(db: Db): Promise<void> {
        await db.query('CREATE TABLE should_not_exist (id INTEGER PRIMARY KEY)')
      },
    }

    const tampered: Migration = {
      version: 1,
      name: 'init',
      async up(db: Db): Promise<void> {
        await db.query('CREATE TABLE something_else (id INTEGER PRIMARY KEY)')
      },
    }

    await assert.rejects(() => migrate(h.db, [tampered, decoy]), MigrationError)

    const rows = await h.db.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('should_not_exist', 'something_else')",
    )
    assert.deepEqual(rows, [], '抛错之后不该有任何后续迁移被执行')
  })
})

describe('迁移失败要回滚', () => {
  test('up 执行到一半抛错，表不会被建出来', async () => {
    await withTempDb(async (db, raw) => {
      const half: Migration = {
        version: 1,
        name: 'half_done',
        async up(tx: Db): Promise<void> {
          await tx.query('CREATE TABLE created_before_failure (id INTEGER PRIMARY KEY)')
          throw new Error('故意失败')
        },
      }

      await assert.rejects(() => migrate(db, [half]), MigrationError)

      // DDL 在 SQLite 里是事务性的，所以回滚之后表应该不存在
      const rows = raw
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'created_before_failure'")
        .get() as { n: number }
      assert.equal(rows.n, 0, '事务回滚了，表不该还在')
    })
  })

  test('迁移失败不留版本记录，重跑能干净地重来一次', async () => {
    await withTempDb(async (db, raw) => {
      let shouldFail = true
      const flaky: Migration = {
        version: 1,
        name: 'flaky',
        async up(tx: Db): Promise<void> {
          if (shouldFail) throw new Error('第一次会失败')
          await tx.query('CREATE TABLE second_time_ok (id INTEGER PRIMARY KEY)')
        },
      }

      await assert.rejects(() => migrate(db, [flaky]), MigrationError)

      const afterFail = await db.query<{ version: number }>('SELECT version FROM schema_migrations')
      assert.equal(afterFail.length, 0, '失败的那次不能留下版本行')

      shouldFail = false
      const ran = await migrate(db, [flaky])
      assert.deepEqual(ran, [1], '重跑应该执行第 1 个版本')

      const cols = raw.prepare("SELECT name FROM sqlite_master WHERE name = 'second_time_ok'").get()
      assert.ok(cols !== undefined, '重跑之后表建出来了')
    })
  })
})

describe('老库往前走', () => {
  test('先跑到 001，再带上 002，新列会补上', async () => {
    await withTempDb(async (db, raw) => {
      // 模拟一个只有 001 的老库
      const ranFirst = await migrate(db, [m001])
      assert.deepEqual(ranFirst, [1])

      const beforeCols = await columnsOf(raw, 'products')
      assert.ok(!beforeCols.includes('description'), '跑完 001 时还不该有这列')

      // 升级
      const ranSecond = await migrate(db, [m001, m002])
      assert.deepEqual(ranSecond, [2], '只该执行 002')

      const afterCols = await columnsOf(raw, 'products')
      assert.ok(afterCols.includes('description'), '升级之后新列出现了')
      assert.deepEqual(afterCols, ['id', 'sku', 'name', 'price_cents', 'stock', 'created_at', 'description'])
    })
  })

  test('老库里已有的数据没被动过', async () => {
    await withTempDb(async (db) => {
      await migrate(db, [m001])
      await db.query(
        "INSERT INTO products (sku, name, price_cents, stock, created_at) VALUES ('OLD-1', '老数据', 1234, 7, '2026-01-01T00:00:00.000Z')",
      )

      await migrate(db, [m001, m002])

      const rows = await db.query<{ sku: string; price_cents: number; stock: number }>(
        "SELECT sku, price_cents, stock FROM products WHERE sku = 'OLD-1'",
      )
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.price_cents, 1234)
      assert.equal(rows[0]!.stock, 7)
    })
  })
})

describe('版本号本身要守法', () => {
  test('版本跳号时报错', async () => {
    const gap: Migration = {
      version: 2,
      name: 'skipping_one',
      async up(): Promise<void> {},
    }
    await assert.rejects(() => migrate(h.db, [gap]), MigrationError)
  })

  test('版本重复时报错', async () => {
    const a: Migration = { version: 1, name: 'a', async up(): Promise<void> {} }
    const b: Migration = { version: 1, name: 'b', async up(): Promise<void> {} }
    await assert.rejects(() => migrate(h.db, [a, b]), MigrationError)
  })
})
