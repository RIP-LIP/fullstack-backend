import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db, Param } from './index.ts'
import { migrate } from './migrate.ts'
import { DB_PATH } from '../config.ts'

/**
 * node:sqlite 的实现。
 *
 * 全项目只有这个文件知道底层是 SQLite。别的文件只见 Db 接口，
 * 换库时改的就是这里。
 */

export type SqliteHandle = {
  db: Db
  raw: DatabaseSync
  close: () => void
}

/**
 * 开一个库并跑迁移。
 *
 * 做成函数而不是只导出一个单例，是因为迁移测试需要在临时文件上开好几次库，
 * 每次只跑一部分迁移，模拟「库里只有 001」这种真实场景。
 */
export function createDb(file: string): SqliteHandle {
  // 目录必须先建，否则文件不存在时 DatabaseSync 会直接抛错。
  mkdirSync(dirname(file), { recursive: true })

  const raw = new DatabaseSync(file)

  /**
   * WAL 模式：读写不互相阻塞，比默认的 rollback journal 少很多
   * 「database is locked」。
   *
   * 下面这条 foreign_keys 看着像多余，实际要设，理由不是「SQLite 默认关着」——
   * 实测 node:sqlite 的默认值就是 1（@types/node 的声明里也标着 @default true）。
   * 真正的原因是这三条：
   *
   *   1. PRAGMA 按连接生效，不写进数据库文件。换一条连接就是另一个值。
   *   2. 在事务里设置会**静默失效**——不报错，值就是没变。所以它必须
   *      在任何事务之外执行，写在这里而不是迁移里不是随手放的。
   *   3. 换客户端（sqlite3 命令行、容器里的工具、别的迁移脚本）默认值
   *      不保证相同。代码里写死，行为就不依赖「谁在连」。
   */
  raw.exec('PRAGMA journal_mode = WAL')
  raw.exec('PRAGMA foreign_keys = ON')

  const db: Db = {
    async query<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
      return raw.prepare(sql).all(...params) as unknown as T[]
    },

    async one<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
      const row = raw.prepare(sql).get(...params)
      return row === undefined ? undefined : (row as unknown as T)
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      raw.exec('BEGIN')
      try {
        const result = await fn(db)
        raw.exec('COMMIT')
        return result
      } catch (err) {
        raw.exec('ROLLBACK')
        throw err
      }
    },
  }

  return { db, raw, close: () => raw.close() }
}

/** 本进程用的那个库。 */
const handle = createDb(DB_PATH)

/**
 * 原始连接。导出是因为两处真的需要它：
 * 1. 测试要直接查 sqlite_master、看列有没有建出来；
 * 2. money 那组测试要造一张 REAL 列的表演示浮点错误。
 * 业务代码不要用。
 */
export const rawDb = handle.raw
export const db = handle.db

export function closeDb(): void {
  handle.close()
}

/**
 * 启动时把库推到最新版本。
 *
 * 用模块顶层的 await 是有意的：模块没加载完，import 它的人就拿不到 db，
 * 于是「迁移还没跑完就开始收请求」这件事在结构上就不可能发生。
 * 迁移失败（checksum 对不上、SQL 写错）会让这里直接抛，
 * 进程带着非 0 退出，不会带着一个半成品库对外服务。
 */
await migrate(db)
