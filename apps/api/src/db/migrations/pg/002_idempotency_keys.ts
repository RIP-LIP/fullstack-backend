import type { Db } from '../../index.ts'
import type { Migration } from '../../migrate.ts'

/**
 * 002：幂等键表。
 *
 * ## 这张表解决的是什么
 *
 * 客户端网络卡住，用户点了两次「提交订单」——两次请求内容完全一样，
 * 到了服务端就是两个独立的 HTTP 请求。数据库不知道它们是同一个意图，
 * 于是建两笔订单、扣两次库存。
 *
 * 前一章挡的是「两个不同的请求同时改一行」（并发），
 * 这一章挡的是「同一个请求来了两次」（重复）。机制完全不同：
 * 前者靠锁和隔离级别，后者靠**唯一约束**。
 *
 * ## 为什么主键只有 key，没有 user_id
 *
 * 诚实地说：**这一组还没有登录态，拿不到「这个请求属于谁」。**
 * 所以唯一性只能落在 key 本身。
 *
 * 代价是明确的：任何人拿着别人的 key 重放，都能拿到别人的订单。
 * 真正的做法是把唯一键建成 `(user_id, key)`——
 * 而那要等有了登录态之后才谈得上。
 *
 * ## 为什么存 order_id 而不是整份响应
 *
 * 响应是**快照**，订单是**活数据**。订单状态从 pending 变成 paid 之后，
 * 存下来的响应体还停在 pending，重放就会返回一个过期状态。
 * 存 order_id、每次重放时重新读，是唯一不会过期的做法。
 */
export const m002: Migration = {
  version: 2,
  name: 'idempotency_keys',
  async up(db: Db): Promise<void> {
    // order_id 一开始是空的：这一行是「占位」，
    // 它先被插进去占住这个键，订单建好之后才回填。
    //
    // 这就是「先插再干活」和「先查再插」的区别：
    // 先查再插在两个并发请求之间有窗口——两个都查不到，
    // 然后两个都插，第二个撞唯一键。
    // 先插的话，**唯一约束就是那个裁判**，而它是原子的。
    await db.query(`
      CREATE TABLE idempotency_keys (
        key          TEXT        PRIMARY KEY,
        request_hash TEXT        NOT NULL,
        order_id     INTEGER     REFERENCES orders(id),
        created_at   TIMESTAMPTZ NOT NULL
      )
    `)

    // 过期清理要用这个。没有它，清理脚本只能全表扫。
    await db.query(
      'CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at)',
    )
  },
}
