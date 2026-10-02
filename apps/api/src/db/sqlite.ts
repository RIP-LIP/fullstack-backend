import { DatabaseSync } from 'node:sqlite'
import { AsyncLocalStorage } from 'node:async_hooks'
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
 * 项目自己的「不支持嵌套事务」。
 *
 * 原来没有这个类型，报错是从 SQLite 直接漏出来的
 * （cannot start a transaction within a transaction）。两个问题：
 * 一是那句话对读代码的人没有意义，二是它经过错误处理之后会变成 500，
 * 而「你把事务边界画错了」是一个应该在开发期就看清的 400/500 级错误，
 * 不该伪装成「服务端出错了」。
 */
export class NestedTransactionError extends Error {
  constructor() {
    super(
      [
        '不支持嵌套事务。',
        '',
        '这说明边界画错了：内层想开的事务应该和外层是同一个，',
        '或者它们本来就该是两个互不相干的事务，不该一个套一个。',
        '加个计数器把嵌套「支持」起来只会让问题更晚暴露。',
      ].join('\n'),
    )
    this.name = 'NestedTransactionError'
  }
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

  /**
   * 「这条连接现在是不是已经有主了」。
   *
   * AsyncLocalStorage 存的是**异步上下文**，不是全局变量。事务体里
   * await 出去的每一段异步代码都带着同一个标记，外面的请求拿不到。
   * 这就是能区分「事务体自己的读写」和「别人的读写」的原因——
   * 用一个普通布尔量区分不了，因为 await 期间控制权根本不在栈上。
   */
  const txOwner = new AsyncLocalStorage<true>()

  /** 有事务开着的时候为 true。连接一次只归一个事务。 */
  let busy = false

  /** 等连接的人。连接一空就全部叫醒。 */
  const waiters: Array<() => void> = []

  /**
   * 拿到连接的唯一入口。
   *
   * 有事务开着的时候，事务体**之外**的读写在这里排队，直到那个事务结束。
   * 没有这一步，事务体一旦 await 到事件循环，另一个请求的写语句就会被
   * 执行在这个事务里，跟着它一起回滚——那个请求拿到的是成功响应，
   * 数据却没了，全程没有任何异常。
   *
   * 判断条件是「不是这个事务的owner」，不是「我在不在回调里」。
   * 前者靠 AsyncLocalStorage，后者靠调用栈，await 一层就失效了。
   */
  async function withConnection<T>(fn: () => T): Promise<T> {
    while (busy && txOwner.getStore() !== true) {
      await new Promise<void>((resolve) => waiters.push(resolve))
    }
    return fn()
  }

  const db: Db = {
    async query<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
      return withConnection(() => raw.prepare(sql).all(...params) as unknown as T[])
    },

    async one<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
      return withConnection(() => {
        const row = raw.prepare(sql).get(...params)
        return row === undefined ? undefined : (row as unknown as T)
      })
    },

    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // 先判嵌套，判据是「我自己是不是已经在事务体里」，不是 busy。
      // busy 为 true 也可能只是另一个请求开着事务，那种情况该排队而不是报错。
      if (txOwner.getStore() === true) throw new NestedTransactionError()

      while (busy) {
        await new Promise<void>((resolve) => waiters.push(resolve))
      }
      busy = true
      raw.exec('BEGIN')

      try {
        const result = await txOwner.run(true, () => fn(db))
        raw.exec('COMMIT')
        return result
      } catch (err) {
        // 回滚失败**不能顶替**原始错误。
        //
        // 没有活动事务时 ROLLBACK 自己会抛
        // （cannot rollback - no transaction is active）。让那句话说出去的话，
        // 调用方原本的 409 OUT_OF_STOCK 就变成了 500 INTERNAL_ERROR，
        // 真正的原因只留在日志里——正是前面几章一直在消灭的那种失败。
        // 所以这里把两个错误都留着，原始的那个优先。
        try {
          raw.exec('ROLLBACK')
        } catch (rollbackErr) {
          console.error('[db] 回滚失败，事务状态可能已经不对了：', rollbackErr)
        }
        throw err
      } finally {
        // 必须放 finally。放错位置的话，回滚路径下连接永远不释放，
        // 后面所有请求都卡在这个队列上，整服务假死。
        busy = false
        const waiting = waiters.splice(0)
        for (const wake of waiting) wake()
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
