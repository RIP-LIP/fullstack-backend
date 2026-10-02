import type { Db } from '../../index.ts'
import type { Migration } from '../../migrate.ts'

/**
 * 003：给 products 加一列 title。
 *
 * 这是 expand 阶段。expand = 先把新结构加上去，让新旧两种代码都能跑，
 * 期间不删任何东西。
 *
 * **为什么不直接改列名。** 直觉做法是：
 *
 *     ALTER TABLE products RENAME COLUMN name TO title
 *
 * 一句话就完事。但老代码还在跑着，它的查询和字段映射写的是 name。
 * 改完之后那一列**查不到了**，映射出来是 undefined，而
 * JSON.stringify 会**直接把这个键从响应里删掉**——不报错、不警告，
 * 调用方拿到的是一个少了一个字段的成功响应。
 *
 * 实测输出见手册 ch06。这一章讲的就是怎么绕开它。
 *
 * 列选成可空 TEXT，理由和 002 一样：给有数据的表加 NOT NULL 列会失败
 * （见 002 的注释），而 title 这一步本来就不该有值——
 * 老数据要靠回填补，而回填和加列不该挤在同一个迁移里。
 */
export const m003: Migration = {
  version: 3,
  name: 'add_product_title',
  async up(db: Db): Promise<void> {
    await db.query('ALTER TABLE products ADD COLUMN title TEXT')
  },
}
