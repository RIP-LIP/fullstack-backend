import type { Db } from '../../index.ts'
import type { Migration } from '../../migrate.ts'

/**
 * 002：给 products 加一列。
 *
 * 这一条存在的意义是演示「改表结构」到底该怎么做。
 *
 * 如果只是把 001 里的 CREATE TABLE 加上 description，v1.0 之前建的库
 * 启动时会看到 products 表已经存在，001 直接被跳过——新列不会出现，
 * 而新装的库有这列。同一个版本号，两种结构。
 *
 * 所以改表结构 = 新增一个迁移，永远不要回头改旧的。
 *
 * 列选成可空的 TEXT，不是 NOT NULL。实测过 SQLite 的两条边界：
 *   - ADD COLUMN ... NOT NULL 且没有默认值，表**有行**时会失败
 *     （Cannot add a NOT NULL column with default value NULL）
 *   - 表**空**时同样不写默认值也能成功
 * 也就是说「能不能加」取决于表里有没有数据，而不是语法允不允许。
 * 想给已有数据的表加必填列，必须带默认值，然后分几步把老数据补齐、
 * 再把约束加上。这里先不展开。
 */
export const m002: Migration = {
  version: 2,
  name: 'add_product_description',
  async up(db: Db): Promise<void> {
    await db.query('ALTER TABLE products ADD COLUMN description TEXT')
  },
}
