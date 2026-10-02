import { createHash } from 'node:crypto'
import type { Db } from './index.ts'
import { m001 } from './migrations/001_init.ts'
import { m002 } from './migrations/002_add_product_description.ts'
import { m003 } from './migrations/003_add_product_title.ts'

/**
 * 迁移执行器。
 *
 * 表结构改了以后，光改代码里的 CREATE TABLE 是不够的：已经存在的库
 * 启动时看到「表在」，就整句跳过，新加的列不会出现。新装的人拿到新结构，
 * 老用户拿到旧结构，同一份代码在两种机器上跑出两种结果。
 *
 * 解决办法是给数据库也记一份版本：改了什么、什么时候改的、当时那版
 * 长什么样（checksum）。启动时对一遍，只补没做过的。
 */

export type Migration = {
  version: number
  name: string
  up: (db: Db) => Promise<void>
}

/**
 * 迁移出错专用。
 *
 * 单独一个类型，是为了让上层能把「迁移失败」和「业务代码抛错」分开处理：
 * 前者必须让进程退出，不要带伤继续跑；后者是该返回 500 的那种。
 */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  )
`

/**
 * 迁移内容的指纹。
 *
 * 算的是 up 函数本身的源码（Function.prototype.toString），不是文件字节。
 * 区别是：文件里加一行注释不会触发误报，而真的改了建表语句一定会被发现。
 * 这比按文件哈希算更贴近「这段逻辑有没有变」这个问题本身。
 */
export function checksumOf(migration: Migration): string {
  return createHash('sha256').update(migration.up.toString()).digest('hex')
}

/** 全部迁移，按版本号排好。显式列出，不去扫目录。 */
export const allMigrations: readonly Migration[] = [m001, m002, m003]

/**
 * 跑到最新版本，返回这次实际执行了哪些版本号。
 *
 * 三条规则，都是有意选的行为，不是默认行为：
 *
 * 1. 每个迁移在**自己的事务**里跑。DDL 在 SQLite 里是事务性的（实测：
 *    事务里建的表，ROLLBACK 之后就没了），所以半路失败不会留下「建了一半的表」。
 *    整批迁移套一个大事务更省事，但那样一个失败就全白做，
 *    而且大库上长时间持锁的代价很高。
 *
 * 2. checksum 对不上就**抛错停下**，不自动重跑也不自动跳过。已经应用过的
 *    迁移被改过，说明有人在动历史。这时最糟的做法是「聪明地」猜——
 *    猜错一次，数据库状态就永远回不到任何一份迁移能描述的样子了。
 *    停下来让人先想清楚，比继续跑代价小。
 *
 * 3. 版本必须连续递增且不重复。中间空一个号说明有人漏提交了一个迁移，
 *    按序执行会直接把库带到错误的版本。
 */
export async function migrate(db: Db, migrations: readonly Migration[] = allMigrations): Promise<number[]> {
  await db.query(CREATE_MIGRATIONS_TABLE)

  const sorted = [...migrations].sort((a, b) => a.version - b.version)
  assertVersionsAreSane(sorted)

  const applied = new Map<number, { name: string; checksum: string }>()
  for (const row of await db.query<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM schema_migrations',
  )) {
    applied.set(row.version, { name: row.name, checksum: row.checksum })
  }

  const ran: number[] = []

  for (const migration of sorted) {
    const checksum = checksumOf(migration)
    const existing = applied.get(migration.version)

    if (existing !== undefined) {
      if (existing.checksum !== checksum) {
        throw new MigrationError(
          [
            `迁移 ${pad(migration.version)}_${migration.name} 已经应用过，但内容被改过。`,
            `  库里的 checksum：${existing.checksum}`,
            `  现在的 checksum：${checksum}`,
            '',
            '已经执行过的迁移不能改写——数据库此刻的状态只和当时那一版对得上。',
            '要加新改动就写一个新版本的迁移。',
          ].join('\n'),
        )
      }
      continue
    }

    try {
      await db.transaction(async (tx) => {
        await migration.up(tx)
        await tx.query(
          'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          [migration.version, migration.name, checksum, new Date().toISOString()],
        )
      })
    } catch (err) {
      throw new MigrationError(
        `迁移 ${pad(migration.version)}_${migration.name} 执行失败，已回滚，没有留下版本记录。\n` +
          `原始错误：${err instanceof Error ? err.message : String(err)}`,
      )
    }

    ran.push(migration.version)
  }

  return ran
}

/** 版本号从 1 开始连续递增，不允许重复或跳号。 */
function assertVersionsAreSane(sorted: readonly Migration[]): void {
  const seen = new Set<number>()
  sorted.forEach((m, i) => {
    const expected = i + 1
    if (seen.has(m.version)) {
      throw new MigrationError(`迁移版本 ${m.version} 重复了`)
    }
    if (m.version !== expected) {
      throw new MigrationError(
        `迁移版本必须从 1 开始连续递增：第 ${expected} 个迁移的版本是 ${m.version}，中间缺了号`,
      )
    }
    seen.add(m.version)
  })
}

function pad(version: number): string {
  return String(version).padStart(3, '0')
}
