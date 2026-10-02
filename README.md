# fullstack-backend

订单/库存领域的后端。Node + Express + TypeScript，正文在 [fullstack-handbook](https://github.com/RIP-LIP/fullstack-handbook) 的 `guide/deep/` 分组。

配套的入门项目是 [fullstack-todo-app](https://github.com/RIP-LIP/fullstack-todo-app)，一条任务清单从空目录做到可用应用。两个项目独立，端口不冲突。

## 环境要求

| 项 | 版本 | 说明 |
| --- | --- | --- |
| Node | >= 22.13 | 见下面那条说明 |
| Docker | 任意近期版本 | 只有讲 PostgreSQL 那几章用得到 |

Node 版本下限不是拍脑袋定的。`node:sqlite` 在 v22.5.0 加入，但要到 **v22.13.0**（和 v23.4.0）才去掉 `--experimental-sqlite` 标志。低于这个版本，`import { DatabaseSync } from 'node:sqlite'` 要么直接报模块不存在，要么得手动加 flag。22.0–22.4 根本没有这个模块，22.5–22.12 有但需要 flag。

本机没装 PostgreSQL 也不用装，用 Docker 起一个。

## 跑起来

```bash
npm install
npm test          # 81 条测试
npm run dev:api   # 起服务，监听 3002
```

起完试一下（只读，不改任何数据）：

```bash
curl -i http://localhost:3002/api/health
```

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8

{"ok":true,"service":"api"}
```

端口是 3002。入门项目占 3001，所以两个服务可以同时开着。

## 数据库

用的是 SQLite，数据库文件是 `apps/api/data/app.db`。**起后端时自动跑迁移**，不需要执行任何 SQL 命令。测试跑在临时目录上，不会碰到你开发库里的数据。

表结构改了就加一个迁移文件放进 `apps/api/src/db/migrations/`，**不要回头改已经提交过的迁移**——启动时会拿迁移内容算 checksum 和库里的记录对，对不上直接退出并告诉你哪个版本出了问题。

开发库搞坏了就重置（**不可恢复**）：

```bash
npm run db:reset
```

PostgreSQL 的 compose 文件先摆在这儿，当前代码不连它：

```bash
docker compose up -d        # 起库
docker compose ps           # 看到 healthy 才算好
docker compose down         # 停掉；加 -v 连数据卷一起删
```

`docker compose up -d` 不改你机器上任何已有容器的状态，只新建 `fullstack-backend-db` 这一个。

## 目录结构

```
apps/api/
  src/index.ts               入口，读端口、监听
  src/app.ts                 Express 组装，导出以便测试
  src/config.ts              环境变量集中读
  src/errors.ts              统一错误形状 + 数据库约束的识别
  src/db/index.ts            数据访问层的接口（三个方法）
  src/db/sqlite.ts           node:sqlite 实现，全项目唯一知道底层的地方
  src/db/migrate.ts          迁移执行器
  src/db/migrations/         001_init、002_add_product_description、003_add_product_title
  src/routes/products.ts     商品接口
  src/routes/orders.ts       订单接口
  src/order-state.ts         订单状态机的转移表
  src/routes/async-handler.ts 让 async 路由的错误能走到错误中间件
  test/harness.ts            测试的公共启动逻辑
  test/api.test.ts           错误形状
  test/products.test.ts      商品接口
  test/foreign-key.test.ts   外键约束
  test/money.test.ts         金额为什么存整数分
  test/migrate.test.ts       迁移
  test/expand.test.ts        双读双写与回填
  test/orders.test.ts        订单接口与状态机
  test/transaction.test.ts   事务边界（并发请求的写入不会被吞）
packages/shared/
  src/index.ts               Zod schema 与共享类型
  test/schema.test.ts        入参校验规则的单元测试
scripts/
  verify-tag.mjs             tag 级复现
  backfill.mjs               分批回填（幂等 + 可中断）
  probe.mjs                  事务那一章的实验，外加一条只读查库命令
  check-encoding.mjs         乱码检查
docker-compose.yml           PostgreSQL
```

## tag 与章节的对应

每个 tag 都能被独立复现，指的是：导出这个 tag 的代码、装依赖、跑测试、起服务、健康检查通过，**再跑这个 tag 对应的本章验证命令**。

| tag | 对应章节 | 内容 | 本章检查 |
| --- | --- | --- | --- |
| `v0.0` | 无 | 立项基线：能跑、能测、能复现 | — |
| `v1.0` | ch04 | 四张表、外键约束、金额存整数分 | 5 条 |
| `v1.1` | ch05 | 版本表、checksum、每个迁移一个事务 | 4 条 |
| `v1.2` | ch06 | expand 阶段：加 title 列、双读双写 | 5 条 |
| `v1.3` | ch07 | 订单接口、状态机、事务的连接归属 | 6 条 |

`v0.0` 不对应任何一章，它代表「讲任何一章之前，仓库长这样」。

后续每写完一章会多一个 tag，对应关系以这张表为准。**加一章就要在 `scripts/verify-tag.mjs` 的 `CHAPTER_CHECKS` 里补一条**——漏了的话跑那个 tag 会直接退出 1 并提示你，不会静默当成「验过了」。

复现一个 tag：

```bash
node scripts/verify-tag.mjs v1.2
```

脚本会导出到临时目录、装依赖、跑测试、起服务探健康、跑本章检查、然后清理。**会改动临时目录，也会在本机短暂占一个端口**，不碰你当前工作区。

## 回填脚本

ch06 用来给老数据补 `title` 的：

```bash
node scripts/backfill.mjs --status      # 只看还剩多少，不改数据
node scripts/backfill.mjs --batch=1000  # 分批补，每批一个事务
```

幂等、可中断。**每批跑完会核对「剩余数真的少了」，没少就报错停下**——批处理最坏的失败不是报错，是不报错也不推进。

## 查库

本机不一定装了 `sqlite3` 命令行，所以给一条能直接复制的：

```bash
node scripts/probe.mjs state
```

**只读**开发库，把四张表现在有几行、内容是什么打出来。想看别的库就带 `DB_PATH`：

```bash
DB_PATH=/tmp/somewhere/test.db node scripts/probe.mjs state
```

同一个脚本还有三个实验，都是内存库，不碰开发数据：

```bash
node scripts/probe.mjs            # 全部跑一遍
node scripts/probe.mjs notx       # 不用事务的半套数据
node scripts/probe.mjs rollback   # 回滚失败会顶替原始错误
node scripts/probe.mjs nested     # 嵌套 BEGIN 的报错来自 SQLite
node scripts/probe.mjs check      # CHECK 只管值域，不管转移
```

## 类型检查

```bash
npm run typecheck
```

`tsx` 只剥掉类型不检查，所以跑通测试不代表类型对。这一条是独立检查：类型写错、导入了不存在的字段、`any` 泄漏，都在这里暴露。`npm run verify` 会先类型检查再跑测试。

`tsconfig.base.json` 是全仓共用的一份，各子包只写自己的 `include`。开了 `noUncheckedIndexedAccess`，因为数组下标访问在生产代码里基本都是错的，却不会让 `tsc` 报警。

## 依赖说明

zod 钉在 `~3.25.76`，不是 `^3.25.76`。zod v4 的 API 与 v3 不兼容，代码里用的 `safeParse` / `error.issues` / `flatten` 全是 v3 写法，浮到 4.x 会静默失效而不是报错。看到有人提「升级 zod」，先看这一行。

## 错误响应形状

所有对外错误都是这一个形状：

```json
{ "error": { "code": "NOT_FOUND", "message": "没有这个接口：GET /api/nope" } }
```

校验失败会多一个 `fields`：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "请求参数不合法",
    "fields": { "email": "必须是合法邮箱" }
  }
}
```

## 当前状态

`docs/COVERAGE.md` 记着每章做到哪、验过什么、下一步从哪进。
