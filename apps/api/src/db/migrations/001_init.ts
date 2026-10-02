import type { Db } from '../index.ts'
import type { Migration } from '../migrate.ts'

/**
 * 001：建四张业务表。
 *
 * 注意这里**没有** IF NOT EXISTS，和平时写建表语句的习惯相反。
 *
 * 平时用 IF NOT EXISTS 是为了让「每次启动跑一遍」安全。但迁移只应该跑一次，
 * 靠的是版本表判断，不是靠 IF NOT EXISTS 兜底。迁移里再套一层
 * IF NOT EXISTS，等于把「这张表本来不该存在」这种情况悄悄咽下去——
 * 而那通常意味着版本表被清过、或者库被手工改过，正是最该停下来看一眼的时候。
 *
 * 迁移里让它炸。炸了会回滚，库不会被改坏。
 */
export const m001: Migration = {
  version: 1,
  name: 'init',
  async up(db: Db): Promise<void> {
    await db.query(`
      CREATE TABLE users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        email      TEXT    NOT NULL UNIQUE,
        created_at TEXT    NOT NULL
      )
    `)

    await db.query(`
      CREATE TABLE products (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        sku         TEXT    NOT NULL UNIQUE,
        name        TEXT    NOT NULL,
        -- 金额一律整数分。用 REAL 存钱会在累加时出错。
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
        stock       INTEGER NOT NULL CHECK (stock >= 0),
        created_at  TEXT    NOT NULL
      )
    `)

    await db.query(`
      CREATE TABLE orders (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id),
        -- 取值域在这里钉死。cancelled 只能从 pending 转，那是状态机，
        -- 属于事务那章的事，这里只管住「允许哪些值」。
        status      TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled')),
        total_cents INTEGER NOT NULL,
        created_at  TEXT    NOT NULL
      )
    `)

    await db.query(`
      CREATE TABLE order_items (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id         INTEGER NOT NULL REFERENCES orders(id),
        product_id       INTEGER NOT NULL REFERENCES products(id),
        quantity         INTEGER NOT NULL CHECK (quantity > 0),
        -- 下单时的价格快照。商品改价不能改历史订单，所以存副本。
        unit_price_cents INTEGER NOT NULL
      )
    `)
  },
}
