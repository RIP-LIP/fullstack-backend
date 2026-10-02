import type { Migration } from '../../migrate.ts'
import { m001 } from './001_init.ts'
import { m002 } from './002_add_product_description.ts'
import { m003 } from './003_add_product_title.ts'

/**
 * SQLite 那套迁移，**冻结**。
 *
 * ## 它现在不参与任何运行路径
 *
 * 换到 PostgreSQL 之后，没有任何代码会执行这三个文件里的 `up`。
 * 它们留在这里只有两个理由：
 *
 * 1. 历史。想知道「v1.2 的库长什么样」，`git checkout v1.2` 就有。
 * 2. 当反面教材。`001_init.ts` 里的 `AUTOINCREMENT` 在 PostgreSQL 里
 *    根本不存在——**这就是「不能把老迁移翻译一遍」的第一手证据**，
 *    而不是一个抽象的原则。
 *
 * ## 为什么留着它们不算死代码
 *
 * 因为 `apps/api/test/frozen.test.ts` 把它们的指纹钉死了。
 * 任何人改了这三个文件里的 `up` 函数，那条测试立刻挂。
 * 一份「不许改」的东西，光靠注释说是不够的，得有东西拦着。
 *
 * 真要删的话，先删那条测试。顺序反了这个约束就形同虚设。
 */
export const sqliteMigrations: readonly Migration[] = [m001, m002, m003]
