# 覆盖情况

这个文件是会话之间的交接依据。换一个会话接着做之前，先读它。

最后更新：S1 完成时

## 现在在哪

S1（立项与约定）已完成，尚未开写任何章节。

| 章节 | 主题 | tag | 状态 |
| --- | --- | --- | --- |
| — | 立项基线 | `v0.0` | 已完成 |
| ch04 | 数据模型 | `v1.0` | 未开始 |
| ch05 | 迁移 | `v1.1` | 未开始 |
| ch06 | 零停机变更 | `v1.2` | 未开始 |
| ch07 | 事务 | `v1.3` | 未开始 |
| ch08 | 换 PostgreSQL | `v1.4` | 未开始 |
| ch09 | 幂等 | `v1.5` | 未开始 |
| ch10 | 认证与授权 | `v1.6` | 未开始 |
| ch11 | 错误契约 | `v1.7` | 未开始 |
| ch12 | 性能 | `v1.8` | 未开始 |

## 已经验过的

| 项 | 结果 |
| --- | --- |
| `npm test` | 3 pass / 0 fail |
| `npm run typecheck` | 退出 0 |
| 类型检查有效性 | 注入两处错误都抓到：导入不存在的导出报 `TS2724`、数字赋给 `service` 报 `TS2322`，均退出 1；恢复后回 0 |
| `PRAGMA foreign_keys` 默认值 | 实测 `1`（开），传 `enableForeignKeyConstraints: false` 才是 0 |
| `npm ls zod` | 解析到 `3.25.76`（`~3.25.76` 生效） |
| `node scripts/verify-tag.mjs v0.0` | 走完导出→装依赖→测试→起服务→健康检查，退出 0 |
| 对不存在的 tag 跑同一脚本 | 退出 1，不静默通过 |
| `docker compose up -d` | 容器起来且 healthy |

S1 按计划不做变异测试：从 S2 起每章必做。类型检查本身的变异测试已在 S1 做过，因为「检查器是摆设」这件事不等到 S2 才发现就太晚了。

## Node 版本下限

`>=22.13.0`。`node:sqlite` 在 v22.5.0 加入，但要到 v22.13.0 / v23.4.0 才去掉 `--experimental-sqlite` 标志。22.0–22.4 没这个模块，22.5–22.12 有但要手动加 flag。CI 矩阵写 `22` 会解析到最新 22.x，掩盖掉这个下限，所以 `engines` 和 README 都写死。

## 载体状态

还没有任何表，也没有数据访问层。下面这些文件是 S2 要建的：

```
apps/api/src/db/index.ts          三方法数据访问层（query / one / transaction）
apps/api/src/db/sqlite.ts         node:sqlite 实现
apps/api/src/db/migrate.ts        迁移执行器
apps/api/src/db/migrations/
```

## 下一步：S2 做 ch04 + ch05

ch04 数据模型，四张表（`users` / `products` / `orders` / `order_items`）加外键，同时建立三方法数据访问层。

四件事最容易做错：

1. **数据层只暴露三个方法。** 一旦长出 `OrderRepository` / `ProductRepository` 就是过度抽象 —— `fullstack-dev` skill 明确警告不要强加模式。加这一层的唯一理由是 ch08 换库，所以只加到够换库为止。
2. **显式写 `PRAGMA foreign_keys = ON`，但理由不是「SQLite 默认关着」。** 实测 `new DatabaseSync(path)` 的默认值是 `1`（开），`@types/node/sqlite.d.ts` 也标了 `@default true`；传 `enableForeignKeyConstraints: false` 才是 0。真要显式开，理由是三条：pragma 按连接生效、不写进数据库文件；**在事务内设置会静默无效**；换客户端（sqlite3 CLI、容器内工具、迁移工具）默认值不保证相同。写「默认关着」是错的，会把读者引去查一个不存在的问题。
3. **金额用 INTEGER 存分。** ch04 要实跑一次 `REAL` 的 `0.1 + 0.2 !== 0.3`，不能只写结论。
4. **孤儿行那个核心失败要真能复现。** 既然默认就开着外键，就得用 `enableForeignKeyConstraints: false` 建一个「没开外键」的库来演示，否则插孤儿行会直接被拒，演示不成立。

ch05 迁移表要带 checksum，且 checksum 对不上时**报错停下，不要自动继续**。

收尾要做变异测试，把挂掉的测试名写进 commit message。

## 已知接缝（S1 记录，S2 或之后要补）

`errors.ts` 的兜底分支现在把所有未知异常都变成 500。还没有数据库时这样没问题，但 **ch04 一建表，这个缺口立刻变成「外键冲突返回 500」** —— 数据库约束失败是业务错误，客户端该看到 409 或 400，不是 500。

ch04 接入数据层时一并处理：把约束冲突翻译成明确的业务错误码。

## 硬约束

改动之前先看这几条，它们不随会话变化：

- zod 钉 `~3.25.76`，不升 v4
- 端口 3002，不复用 3001
- `config.ts` 只放代码真的读到的键
- 数据访问层不按实体建 repository
- 文档不写「待写 / 待补 / 还没写」，不写「我们只讲 X 不讲 Y」这类句子
- 文档里的每条命令标明是否改动数据
- `::: request` 容器里的响应必须实跑抓取，不能凭印象写
