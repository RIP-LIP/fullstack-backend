# 覆盖情况

这个文件是会话之间的交接依据。换一个会话接着做之前，先读它。

最后更新：S2 完成时

## 现在在哪

S2（ch04 数据模型 + ch05 迁移）已完成。ch06 起未开始。

| 章节 | 主题 | tag | 状态 |
| --- | --- | --- | --- |
| — | 立项基线 | `v0.0` | 已完成 |
| ch04 | 数据模型 | `v1.0` | 已完成 |
| ch05 | 迁移 | `v1.1` | 已完成 |
| ch06 | 零停机变更 | `v1.2` | 未开始 |
| ch07 | 事务 | `v1.3` | 未开始 |
| ch08 | 换 PostgreSQL | `v1.4` | 未开始 |
| ch09 | 幂等 | `v1.5` | 未开始 |
| ch10 | 认证与授权 | `v1.6` | 未开始 |
| ch11 | 错误契约 | `v1.7` | 未开始 |
| ch12 | 性能 | `v1.8` | 未开始 |

手册侧在 `fullstack-handbook` 的 `docs/guide/deep/`，侧边栏是「后端往下走」第二分组。

## 已经验过的

| 项 | 结果 |
| --- | --- |
| `npm run verify` | 退出 0（typecheck + 47 tests / 0 fail） |
| `npm test` | 47 tests / 17 suites / 0 fail |
| `node scripts/verify-tag.mjs v1.0` | 走完七步，导出目录里 35 tests 全跑，退出 0 |
| `node scripts/verify-tag.mjs v1.1` | 同上，47 tests 全跑，退出 0 |
| 对不存在的 tag 跑同一脚本 | 退出 1，不静默通过 |
| 开发库 `apps/api/data/app.db` | 测试全程不碰（用 mkdtemp 临时库） |
| 手册 `npm run build` | 退出 0 |
| 手册 `npm run check:links` | 21 页 559 条站内链接（含 54 个锚点）全部有效 |
| 三页新文章节 | 200；桌面 1280px 与窄屏 874px 两档都正常；控制台 0 错误 |
| 计划性/自标榜字样 | 三页均为 0（待写/待补/还没写/我们只讲/TODO/占位） |

## 变异测试记录

| 改坏的地方 | 挂掉的用例 |
| --- | --- |
| 去掉 DELETE 里的外键 409 翻译 | 1 条：删一个已经被订单引用的商品，返回 409 而不是 500 |
| `rowToProduct` 里 `price_cents` 除以 100 | 3 条：三件 8.2 元的商品，用分算是精确的 2460 / 合法输入返回 201，并带上数据库自动发的 id / 以分存的整数读回来还是整数，不会变成小数 |
| 关掉迁移的 checksum 校验 | 2 条：版本号在、内容不同，抛 MigrationError / 停下的时候，后面的迁移一个都不会跑 |

**前两条抓到的用例没有重叠**，说明它们守的是不同行为。

## 本机实跑确认的事实（写文档直接用，别再自己猜）

**外键**：`node:sqlite` 默认 `foreign_keys = 1`（开），`@types/node` 标 `@default true`。
传 `enableForeignKeyConstraints: false` 才是 0，删父行后孤儿行静默留存。
`PRAGMA foreign_keys = ON` 在事务内**静默无效**。有子行时删父行 → `errcode: 787`。

**ADD COLUMN 的边界**：

| 条件 | 结果 |
| --- | --- |
| 表**有行** + `NOT NULL` 无默认值 | 失败：`Cannot add a NOT NULL column with default value NULL` |
| 表**空** + `NOT NULL` 无默认值 | 成功 |
| 表**有行** + `NOT NULL DEFAULT ''` | 成功 |

**CREATE TABLE IF NOT EXISTS**：老表上重跑（多一列）→ 列不变。

**DDL 在 SQLite 里是事务性的**：事务里建的表，`ROLLBACK` 之后不存在。所以「每个迁移一个事务」成立。
DDL 走 `prepare().all()` 正常，所以数据层只要 `query` / `one` / `transaction` 三个方法就够，不需要第四个。

**浮点（会错的）**：`0.1 + 0.2 = 0.30000000000000004`、`8.2 * 3 = 24.599999999999998`、
`4.35 * 100 = 434.99999999999994`、`1.005 * 100 = 100.49999999999999`。
SQLite REAL 列里 `8.2 * 3` 存下来就是 `24.599999999999998`。

**浮点（不会错的，别拿去举例）**：`0.999 + 1.5 + 0.501`、`19.99 * 3`、`9.99 + 0.01`、
`29.9 + 10.1`、`1234.56 + 0.44`。这几个实跑结果都精确。
S2 就因为随手挑了 `0.999 + 1.5 + 0.501` 当反例，测试直接挂了一条。

## 载体状态

```
apps/api/src/db/index.ts       Db 接口（query / one / transaction 三个方法）
apps/api/src/db/sqlite.ts     node:sqlite 实现 + createDb 工厂 + 模块顶层 await migrate
apps/api/src/db/migrate.ts    迁移执行器（版本表 + checksum + 每迁移一事务）
apps/api/src/db/migrations/   001_init.ts、002_add_product_description.ts
apps/api/src/routes/          products.ts、async-handler.ts
apps/api/test/                harness.ts + 5 个测试文件
```

四张表 `users` / `products` / `orders` / `order_items` 已建，外键已生效。
订单状态机用 `CHECK` 钉住了取值域（`pending` `paid` `shipped` `completed` `cancelled`），
**转移规则还没实现**——那是 ch07 的事。

`errors.ts` 已有 `constraintKind()` / `isConstraint()`，能把 SQLite 扩展错误码
翻译成 `PRODUCT_IN_USE` / `PRODUCT_SKU_TAKEN` / `CONSTRAINT_VIOLATION`。

## 下一步：S3 做 ch06 + ch07

ch06 零停机变更（expand-contract），ch07 事务边界。

ch06 已经铺好的伏笔：002 迁移里写了 `ADD COLUMN NOT NULL` 无默认值在有行表上会失败。
这一章要讲的是**加列容易、删列和改类型难**，以及为什么老代码和新代码要能在同一段时间里
同时对着一个库跑。

ch07 建订单要同时动三张表（`orders` / `order_items` / `products.stock`），
中途失败会留下不一致。`Db.transaction` 已经在 `sqlite.ts` 里实现好了，直接用。

## 硬约束

改动之前先看这几条，它们不随会话变化：

- zod 钉 `~3.25.76`，不升 v4
- 端口 3002，不复用 3001
- `config.ts` 只放代码真的读到的键
- 数据访问层不按实体建 repository
- 文档不写「待写 / 待补 / 还没写」，不写「我们只讲 X 不讲 Y」这类句子
- 文档里的每条命令标明是否改动数据
- `::: request` 容器里的响应必须实跑抓取，不能凭印象写
- **文档里举的每个例子都要实跑确认过**。会错和不会错的例子要分开写清楚，
  随手挑数字是这一组已经犯过的错
- **交接文档里的行为断言要带本会话跑出来的命令和输出**。S1 留下的
  「SQLite 默认关着外键」没人跑过，害得 ch04 差点立论不成立
- 每章收尾做变异测试，把挂掉的用例名写进 commit message
- 加测试文件后要改根 `package.json` 的 `test` 脚本（显式列文件名），
  并确认 `npm test` 的**测试条数涨了**。没涨就是没跑到
