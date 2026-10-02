import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Db, Param } from './index.ts'
import { DB_PATH } from '../config.ts'

/**
 * node:sqlite 的实现。
 *
 * 全项目只有这个文件知道底层是 SQLite。别的文件只见 Db 接口，
 * 换库时改的就是这里。
 */

/** 目录必须先建，否则文件不存在时 DatabaseSync 会直接抛错。 */
mkdirSync(dirname(DB_PATH), { recursive: true })

/**
 * 原始连接。导出是因为两处真的需要它：
 * 1. 迁移执行器要跑 BEGIN/COMMIT 之外的 DDL；
 * 2. 测试要直接插数据来构造「商品被订单引用」这个场景。
 * 业务代码不要用。
 */
export const rawDb = new DatabaseSync(DB_PATH)

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
 *      在任何事务之外执行，写在这里而不是事务里不是随手放的。
 *   3. 换客户端（sqlite3 命令行、容器里的工具、别的迁移脚本）默认值
 *      不保证相同。代码里写死，行为就不依赖「谁在连」。
 */
rawDb.exec('PRAGMA journal_mode = WAL')
rawDb.exec('PRAGMA foreign_keys = ON')

/**
 * 建表。
 *
 * 用 IF NOT EXISTS，所以每次启动跑一遍是安全的。
 * 但它只保证「表在」，不保证「表长得对」——老库里少一列时它照样跳过整句。
 * 这个坑要到讲迁移那章才会真正爆出来，这里先留着。
 */
rawDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT    NOT NULL UNIQUE,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sku         TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    -- 金额一律整数分。用 REAL 存钱会在累加时出错，教程里有实跑演示。
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    stock       INTEGER NOT NULL CHECK (stock >= 0),
    created_at  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    -- 取值域在这里钉死。cancelled 只能从 pending 转，那属于状态机，
    -- 是事务那章的事，这里只管住「允许哪些值」。
    status      TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled')),
    total_cents INTEGER NOT NULL,
    created_at  TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id         INTEGER NOT NULL REFERENCES orders(id),
    product_id       INTEGER NOT NULL REFERENCES products(id),
    quantity         INTEGER NOT NULL CHECK (quantity > 0),
    -- 下单时的价格快照。商品改价不能改历史订单，所以这里存副本，
    -- 读的时候不 join products 取现价。
    unit_price_cents INTEGER NOT NULL
  );
`)

export const db: Db = {
  async query<T>(sql: string, params: readonly Param[] = []): Promise<T[]> {
    return rawDb.prepare(sql).all(...params) as unknown as T[]
  },

  async one<T>(sql: string, params: readonly Param[] = []): Promise<T | undefined> {
    const row = rawDb.prepare(sql).get(...params)
    return row === undefined ? undefined : (row as unknown as T)
  },

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    rawDb.exec('BEGIN')
    try {
      const result = await fn(db)
      rawDb.exec('COMMIT')
      return result
    } catch (err) {
      rawDb.exec('ROLLBACK')
      throw err
    }
  },
}

/** 关连接。测试在删临时目录之前必须先调它，否则 Windows 上文件被锁住删不掉。 */
export function closeDb(): void {
  rawDb.close()
}
