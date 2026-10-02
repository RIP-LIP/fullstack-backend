import type { Db } from '../../index.ts'
import type { Migration } from '../../migrate.ts'

/**
 * 001：PostgreSQL 基线。
 *
 * ## 为什么不是「把 001 到 003 翻译一遍」
 *
 * SQLite 那边已经跑过的三个迁移**一个字都不能改**：它们的内容算过指纹
 * 存进了 schema_migrations，改了就等于打破「库此刻的状态只和当时那一版
 * 对得上」这条前提。迁移执行器会直接抛错停下，那是它该做的。
 *
 * 而 AUTOINCREMENT 这个关键字在 PostgreSQL 里根本不存在，四个主键全用它。
 * 所以「翻译」这条路从第一步就是死的。
 *
 * ## 那这个基线是什么
 *
 * **给新库一份新历史。** PostgreSQL 这边是空库，没有人经历过 002（加
 * description）和 003（加 title）那两次变更，所以基线直接建成**当前**结构，
 * 那两步被折叠进来了。
 *
 * 版本号从 1 重新开始，是有意为之：版本表是给**这个库**看的，不是给代码看的。
 * 两个库各有一份 schema_migrations，各记各的，没有任何哪个库声称自己
 * 经历过 SQLite 的那段历史。
 *
 * 代价说清楚：换库之后**不能拿 SQLite 的库直接顶上来**，两边的
 * schema_migrations 内容不一样。要把老数据搬进 PostgreSQL，那是一次独立的
 * 工作，不在迁移体系里。
 */
export const m001: Migration = {
  version: 1,
  name: 'pg_baseline',
  async up(db: Db): Promise<void> {
    await db.query(`
      CREATE TABLE users (
        id         INTEGER     PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        email      TEXT        NOT NULL UNIQUE,
        created_at TIMESTAMPTZ NOT NULL
      )
    `)

    // name 和 title 同时存在：expand 阶段还没进到 contract，两个键都要留着。
    // 基线建的是当前状态，所以两列都在。
    await db.query(`
      CREATE TABLE products (
        id          INTEGER     PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        sku         TEXT        NOT NULL UNIQUE,
        name        TEXT        NOT NULL,
        title       TEXT,
        description TEXT,
        price_cents INTEGER     NOT NULL CHECK (price_cents >= 0),
        stock       INTEGER     NOT NULL CHECK (stock >= 0),
        created_at  TIMESTAMPTZ NOT NULL
      )
    `)

    // 值域交给数据库，转移交给代码。CHECK 只管这一列的值，
    // 它不知道这一行之前是什么状态。详见 guide/deep/ch07。
    await db.query(`
      CREATE TABLE orders (
        id          INTEGER     PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        user_id     INTEGER     NOT NULL REFERENCES users(id),
        status      TEXT        NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled')),
        total_cents INTEGER     NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL
      )
    `)

    await db.query(`
      CREATE TABLE order_items (
        id               INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
        order_id         INTEGER NOT NULL REFERENCES orders(id),
        product_id       INTEGER NOT NULL REFERENCES products(id),
        quantity         INTEGER NOT NULL CHECK (quantity > 0),
        unit_price_cents INTEGER NOT NULL
      )
    `)
  },
}
