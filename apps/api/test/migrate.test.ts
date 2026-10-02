import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './harness.ts'
import type { Harness } from './harness.ts'
import { migrate, MigrationError } from '../src/db/migrate.ts'
import type { Migration } from '../src/db/migrate.ts'
import { m001 } from '../src/db/migrations/pg/001_pg_baseline.ts'
import { pgMigrations } from '../src/db/migrations/pg/index.ts'
import { columnsOf, resetSchema, TEST_DATABASE_URL } from './test-db.ts'
import type { Db } from '../src/db/index.ts'

/**
 * 迁移的行为。
 *
 * 换库之后这一组的重点变了。SQLite 时代真正在跑的是三个迁移，
 * 「老库往前走」有真东西可测（001 → 002 加一列）。
 * PostgreSQL 这边是**一份基线**，从空库直接建成当前结构。
 *
 * 所以老库升级那一组改用**合成的两个迁移**来测机制——
 * 机制是「跑过的版本会跳过、没跑的会补上」，
 * 和它是 SQLite 时代写的还是换库之后写的无关。
 * 真基线本身的行为由 `pg-types.test.ts` 和下面第一条守住。
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

/** 清空 schema 之后跑回调。用来测「一个只有 001 的老库」这种场景。 */
async function withCleanSchema(fn: (db: Db) => Promise<void>): Promise<void> {
  await resetSchema(TEST_DATABASE_URL)
  try {
    await fn(h.db)
  } finally {
    // 交还一个干净的库，别让后面的用例踩到这里的残留
    await resetSchema(TEST_DATABASE_URL)
    await migrate(h.db, pgMigrations)
  }
}

/**
 * 给定几个表名，返回其中**确实存在**的那些。
 *
 * 注意是「存在的」，不是「不存在的」——写反了的话，
 * 「表没被建出来」和「表被建出来了」两种结果会得到同样的结论，
 * 那这条断言就等于没写。
 */
async function presentAmong(db: Db, names: string[]): Promise<string[]> {
  const rows = await db.query<{ table_name: string }>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = ?',
    ['public'],
  )
  const present = rows.map((r) => r.table_name)
  return names.filter((n) => present.includes(n))
}

describe('全新库跑迁移', () => {
  test('应用完所有迁移，schema_migrations 里每个版本各一行', async () => {
    const rows = await h.db.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )

    // 对着迁移清单本身断言，不写死条数。写死的话每加一个迁移这条就红一次，
    // 而那次红跟「迁移有没有跑对」没关系——是测试自己过期了。
    assert.equal(rows.length, pgMigrations.length)
    for (const [i, row] of rows.entries()) {
      assert.equal(row.version, pgMigrations[i]!.version)
      assert.equal(row.name, pgMigrations[i]!.name)
    }
    assert.ok(rows[0]!.checksum.length > 0, 'checksum 不能是空串')
  })

  test('四张业务表都在', async () => {
    const wanted = ['order_items', 'orders', 'products', 'users']
    const found = await presentAmong(h.db, wanted)
    for (const t of wanted) {
      assert.ok(found.includes(t), `表 ${t} 没建出来`)
    }
  })
})

describe('重复跑迁移是幂等的', () => {
  test('再跑一次，一个新版本都不执行', async () => {
    const ran = await migrate(h.db, pgMigrations)
    assert.deepEqual(ran, [], '全部版本都应用过了，不该再跑')
  })

  test('跑三次和跑一次，schema_migrations 的行数一样', async () => {
    const before = await h.db.query<{ version: number }>('SELECT version FROM schema_migrations')
    await migrate(h.db, pgMigrations)
    await migrate(h.db, pgMigrations)
    const after = await h.db.query<{ version: number }>('SELECT version FROM schema_migrations')
    assert.equal(after.length, before.length)
  })
})

describe('已应用的迁移被改写时要停下', () => {
  test('版本号在、内容不同，抛 MigrationError', async () => {
    // 同一个 version=1，但 up 的内容不一样了——相当于有人回头改了基线。
    // **这正是换库时最容易犯的错**：手贱去改 migrations/pg/001 里的 DDL。
    const tampered: Migration = {
      version: 1,
      name: 'pg_baseline',
      async up(db: Db): Promise<void> {
        await db.query('CREATE TABLE something_else (id INTEGER PRIMARY KEY)')
      },
    }

    await assert.rejects(
      () => migrate(h.db, [tampered]),
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
      name: 'pg_baseline',
      async up(db: Db): Promise<void> {
        await db.query('CREATE TABLE something_else (id INTEGER PRIMARY KEY)')
      },
    }

    await assert.rejects(() => migrate(h.db, [tampered, decoy]), MigrationError)

    const created = await presentAmong(h.db, ['should_not_exist', 'something_else'])
    assert.deepEqual(created, [], '抛错之后不该有任何后续迁移被执行')
  })
})

describe('迁移失败要回滚', () => {
  test('up 执行到一半抛错，表不会被建出来', async () => {
    await withCleanSchema(async (db) => {
      const half: Migration = {
        version: 1,
        name: 'half_done',
        async up(tx: Db): Promise<void> {
          await tx.query('CREATE TABLE created_before_failure (id INTEGER PRIMARY KEY)')
          throw new Error('故意失败')
        },
      }

      await assert.rejects(() => migrate(db, [half]), MigrationError)

      // DDL 在 PostgreSQL 里同样是事务性的，所以回滚之后表应该不存在。
      // 这是换库时值得重新确认的一条——两个数据库都支持事务性 DDL，
      // 但不是所有数据库都支持，所以要测，不能靠推断。
      const created = await presentAmong(db, ['created_before_failure'])
      assert.deepEqual(created, [], '事务回滚了，表不该还在')
    })
  })

  test('迁移失败不留版本记录，重跑能干净地重来一次', async () => {
    await withCleanSchema(async (db) => {
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

      const created = await presentAmong(db, ['second_time_ok'])
      assert.deepEqual(created, ['second_time_ok'], '重跑之后表建出来了')
    })
  })
})

describe('老库往前走', () => {
  // 合成两个迁移，测的是「跑过的跳过、没跑的补上」这个机制。
  // 用真实的 001 和 002 测不了——它们是 SQLite 的 DDL，在 PostgreSQL 里跑不了。
  //
  // 顺带记一件事：这个文件的第一版里，synthetic_init 写的是
  // `id INTEGER PRIMARY KEY`，插数据时直接吃到
  // `null value in column "id" violates not-null constraint`。
  //
  // **那就是 `AUTOINCREMENT` 那一课的真实版。** SQLite 里
  // `INTEGER PRIMARY KEY` 是 rowid 的别名，不给值它自己会填；
  // PostgreSQL 里 `INTEGER PRIMARY KEY` 就是一个普通的 NOT NULL 列，
  // 不给值就是 null。差一个 `GENERATED ALWAYS AS IDENTITY`。
  const syntheticV1: Migration = {
    version: 1,
    name: 'synthetic_init',
    async up(db: Db): Promise<void> {
      await db.query(
        'CREATE TABLE widgets (id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY, name TEXT NOT NULL)',
      )
    },
  }
  const syntheticV2: Migration = {
    version: 2,
    name: 'synthetic_add_label',
    async up(db: Db): Promise<void> {
      await db.query('ALTER TABLE widgets ADD COLUMN label TEXT')
    },
  }

  test('先跑到 001，再带上 002，新列会补上', async () => {
    await withCleanSchema(async (db) => {
      const ranFirst = await migrate(db, [syntheticV1])
      assert.deepEqual(ranFirst, [1])

      const beforeCols = await columnsOf(db, 'widgets')
      assert.deepEqual(beforeCols, ['id', 'name'], '跑完 001 时还不该有这列')

      const ranSecond = await migrate(db, [syntheticV1, syntheticV2])
      assert.deepEqual(ranSecond, [2], '只该执行 002，001 必须被跳过')

      const afterCols = await columnsOf(db, 'widgets')
      assert.deepEqual(afterCols, ['id', 'name', 'label'], '升级之后新列出现了')
    })
  })

  test('老库里已有的数据没被动过', async () => {
    await withCleanSchema(async (db) => {
      await migrate(db, [syntheticV1])
      await db.query('INSERT INTO widgets (name) VALUES (?)', ['老数据'])

      await migrate(db, [syntheticV1, syntheticV2])

      const rows = await db.query<{ name: string }>('SELECT name FROM widgets')
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.name, '老数据')
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

describe('基线建出来的东西', () => {
  test('基线一次性建出了 name 和 title（002 和 003 被折叠进来了）', async () => {
    const cols = await columnsOf(h.db, 'products')
    assert.ok(cols.includes('name'))
    assert.ok(cols.includes('title'))
    assert.ok(cols.includes('description'))
  })

  test('基线是 001 建的，名字叫 pg_baseline', () => {
    assert.equal(m001.version, 1)
    assert.equal(m001.name, 'pg_baseline')
  })
})
