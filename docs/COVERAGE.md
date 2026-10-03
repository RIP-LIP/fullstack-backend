# 覆盖情况

这个文件是会话之间的交接依据。换一个会话接着做之前，先读它。

最后更新：交付前审查修复完成后（本轮修 16 条文档缺陷 + 9 处代码问题）

## 现在在哪

**ch04 到 ch09 全部完成。** 这一组的主线到这里结束。

下一步只有两个方向，都不在本会话范围内：
**身份与权限**（这一组唯一的遗留假设），或者**发布到 GitHub**。

| 章节 | 主题 | tag | 本章检查 | 状态 |
| --- | --- | --- | --- | --- |
| — | 立项基线 | `v0.0` | — | 已完成 |
| ch04 | 数据模型 | `v1.0` | 5 条 | 已完成 |
| ch05 | 迁移 | `v1.1` | 4 条 | 已完成 |
| ch06 | 零停机变更 | `v1.2` | 5 条 | 已完成 |
| ch07 | 事务 | `v1.3` | 6 条 | 已完成 |
| ch08 | 换 PostgreSQL | `v1.4` | 9 条 | 已完成 |
| ch09 | 幂等 | `v1.5` | 6 条 | 已完成 |

手册侧在 `fullstack-handbook` 的 `docs/guide/deep/`，侧边栏是「后端往下走」第二分组。

## 已经验过的

| 项 | 结果 |
| --- | --- |
| `npm run verify`（后端） | 退出 0（typecheck + 乱码 + **157 tests** / 0 fail，S1 结束时是 3 条） |
| `verify-tag v0.0` | 退出 0。**这一条 S5 改过**：它之前必然退出 1（不对应任何一章，脚本显式拒绝），而 README 写着每个 tag 都能复现。现在空数组表示「这一章确实没有要验的东西」，整项缺失仍然退出 1 |
| `verify-tag v1.0` – `v1.5` | 六个全部退出 0，本章检查分别 5/4/5/6/9/6 |
| 手册 `npm run verify` | **25 页** 700+ 条站内链接全部有效 |
| 计划性/自标榜字样 | ch04–ch09 均为 0 |
| U+FFFD 乱码 | 两仓各一道检查，插入即 exit 1、恢复即 exit 0 |
| `git diff v1.3..v1.4` | 41 个文件、3552 增 981 删。`products.ts` **只差一行 import**；`orders.ts` 多改一处——删掉 `ORDER_IN_USE` 那段约束翻译，因为 23505 在 PG 上盖住了主键冲突。`order-state.ts`、`app.ts`、`packages/shared/src` 一个字没动 |

## S5 做了什么

三件事：审查前四章的产物并修掉 14 处、写 ch08、写 ch09。

### 审查改掉的 14 处

**事实错误 2 处。** ch04 那句「换库时只改 `db/sqlite.ts` 一个文件」经实测站不住，
按 ch08 的实测改成五类；`COVERAGE.md` 同一句错误判断也改了。

**章节结构 2 处。** ch07 缺「下一步」（那一节被并进了「跑完之后」）；
ch05 的「下一步」讲的是**事务**（ch07 的主题）而且没链到紧邻的 ch06——
根因是 S2 写这一节时 ch06 还不存在，S3 插了一章没回头改。

**站点 5 处。** `index.md` 两行表格被 `||` 缝成了一行、少一个空行；
`howto/index.md` 有一条完全重复的行，而且整个后端分组 0 条条目；
`cheatsheet.md` 0 条后端命令，错误码表连 409 都没有。

**证据不足 1 处。** ch07 有五处「本机实测」只给输出不给命令。
为此新增了 `scripts/probe.mjs`，并把第 9 节整节从散文改成带命令和真实数字。

**代码与配置 3 处。** `orders.ts` 一条走不到且语义相反的死分支；
`ci.yml` 没跑 `check:encoding`；`packages/shared` 一个测试文件都没有（补 19 条）。

**工作区残留 1 处。** 五个日志文件和一个 `$null`（在 `D:\MiniMax Code Tasks\` 下）。

### 换库

`db/sqlite.ts` 连同那道排队门一起删掉，换成 `db/postgres.ts`。
业务代码一行没改——**改的只有两个 import 路径**。

四件事不是业务代码但必须一起换，每一件都是当场才发现的：

1. **占位符。** `pg` 只认 `$1`，`placeholders.ts` 逐字符改写。
   它跳过五类区域（单引号、双引号、行注释、块注释、dollar-quoting），
   17 条测试钉住这个边界。**它是便利层，不是 SQL 解析器。**
2. **错误码。** SQLite 的 errcode 位运算 → SQLSTATE 查表。
   `23505` 同时覆盖唯一键和主键，PG 上分不开，`primarykey` 那一档去掉了。
3. **迁移基线。** `AUTOINCREMENT` 在 PG 里不存在，所以**不能翻译老迁移**，
   只能给新库一份新历史（`migrations/pg/001_pg_baseline.ts`，版本从 1 重新开始）。
   SQLite 那三个冻结在 `migrations/sqlite/`，`frozen.test.ts` 把指纹钉死。
4. **测试夹具。** `rawDb` 全部退役；测试库一进程一个，跑完就删；
   库名必须含 `_test`，不满足直接退出。

### 幂等

唯一约束当判据，撞键之后分四种情况处理。
**失败时把键还回去**——漏了不会立刻暴露，而且一次失败就废掉一次意图。

结构上有一个改动：建订单拆成 `createOrderInTx`（接受已开好的事务）
和 `createOrder`（自己开）。幂等要在外层包事务好让回填原子，
而嵌套事务是本项目明确禁止的。

## ch08 / ch09 实跑确认的事实

以下每条都附了本会话跑出来的命令和实际输出。要复现就复制命令跑一遍。

### 丢失更新是真的，而且**没有任何异常**

```bash
node scripts/race.mjs lost
```

```
  甲 读到了 stock = 1
  乙 读到了 stock = 1
  乙 按自己读到的值写回了 stock = 0
  甲 按自己读到的值写回了 stock = 0

  买到手的件数: 2     <- 两个请求都拿到了成功响应
  库存实际减少: 1     <- 库里的 stock 从 1 变成了 0

  **丢失更新。** 两个请求都拿到了成功响应，
  但库存只减了 1 件——有 1 个订单没有对应的发货。
  没有异常，没有日志，没有 409。
```

判据不是「库存是不是 0」，是**买到手的件数和库存减少的件数对不对得上**。

### SERIALIZABLE 是**在提交时**拒绝你的

```bash
node scripts/race.mjs serializable
```

```
  甲 读到了 stock = 1
  乙 读到了 stock = 1
  甲 提交成功
  乙 被拒绝：40001  could not serialize access due to concurrent update
```

读已提交（PG 的默认）挡不住这个。**数据库不阻止你写错，它在提交时拒绝你**，
所以调用方必须处理 40001，而重试又要求写操作是幂等的。

### 池耗尽的表现是排队，不是报错

```bash
node scripts/race.mjs pool
```

```
  借走了池里唯一那条连接，开始一个事务
  发第二个查询——它没有报错，也没有立刻返回，它在排队
  它等了 823 ms。
```

### COUNT(\*) 在 PG 里是字符串，BIGINT 会静默丢精度

```
=== COUNT(*) 读回来是什么 ===
typeof n          : string
值                : "3"
加了 ::int 之后   : number 3

=== BIGINT（int8）读回来是什么 ===
typeof n          : string
值                : "9007199254740993"
转成 number       : 9007199254740992
JS 认为相等的那个 : true
```

`timestamptz` 原始驱动返回的是 **object**（Date），
驱动里用 `types.setTypeParser(1184, ...)` 归一成 ISO 字符串。
`BIGINT` 是**故意不改**的——`pg` 默认返回字符串正是为了不替你做这个决定。

### 换库对业务代码的影响

```bash
git diff --name-only 8285736..v1.4 -- 'apps/api/src/routes/*' \
  'apps/api/src/order-state.ts' 'apps/api/src/app.ts' 'packages/shared/src/*'
```

```
apps/api/src/routes/orders.ts
apps/api/src/routes/products.ts
```

两个文件，每个只差一行 import：

```diff
-import { db } from '../db/sqlite.ts'
+import { db } from '../db/postgres.ts'
```

### 并行跑测试时，**清空不是隔离**

一开始的写法是「所有测试文件共用一个库，每个文件开头
`DROP SCHEMA public CASCADE`」，结果几乎每个文件都报
`relation "products" does not exist`。

原因：**Node 的 test runner 并行跑各个测试文件**（默认并发度是 CPU 核数），
十一个文件同时清空同一个库，互相把对方的表删了。

清空不是隔离。**每个进程一个库才是。** SQLite 时代每个文件 `mkdtemp`
出一个自己的 `.db`，隔离是白拿的，换库把这个性质弄丢了。

### 一个**试过但没挂住**的变异

在 `claim` 的 INSERT **之前**加一句「先 SELECT 看这个键在不在」，
只当快速路径、判据仍然是唯一约束——**12 条幂等测试全绿，一条没挂**。

因为那次查询不参与判据：查到了不等于「归我」，不查也不影响
（撞键之后 catch 里还是会查那一行）。它只是一次多余的查询。

真正的错误做法是**拿那次查询的结果当判据**——
「查不到就直接 INSERT 并当成自己的」，那样两个并发请求
会同时查到「查不到」，同时当成自己的，窗口真实存在。

> **判据在哪儿，比有没有那次查询重要得多。**
> 说「它是对的」也要有证据。

## 变异测试记录

| 章 | 改坏的地方 | 挂掉的用例 |
| --- | --- | --- |
| ch04 | 去掉 DELETE 里的外键 409 翻译 | 1 条：删一个已经被订单引用的商品，返回 409 而不是 500 |
| ch04 | `rowToProduct` 里 `price_cents` 除以 100 | 3 条 |
| ch05 | 关掉迁移的 checksum 校验 | 2 条 |
| ch06 | 双读里的 `?? row.name` 去掉 | 1 条：老数据 title 退回 name |
| ch06 | `INSERT` 少写 `title` 一列 | 3 条：双写两条 + 老代码视角一条 |
| ch07 | 去掉 `withConnection` 的排队 | 1 条：并发请求的写入不会被事务回滚吞掉 |
| ch07 | 转移表里 `completed` 加上 `paid` | 2 条 |
| ch07 | 转移表里 `pending` 加上 `completed` | 1 条 |
| **ch08** | 去掉改写器的 dollar-quoting 跳过 | **3 条**：匿名标签 / 带名字的标签 / 多行标签 |
| **ch08** | 删掉 `23505` 的映射 | **1 条**：sku 重复返回 409，不是 400 也不是 500 |
| **ch08** | `client.release()` 从 `finally` 挪到成功分支 | **1 条**：事务失败后连接还能继续用，不会把池耗光 |
| **ch09** | 删掉 `claim` 里的 `request_hash` 比对 | **1 条**：同一个键配不同内容时返回 409 |
| **ch09** | 删掉 `complete` 的回填 UPDATE | **2 条**：重放那两条 |
| **ch09** | 删掉 `release` 调用 | **1 条**：失败之后同一个键还能重新用 |

**ch08 第三条第一次做的时候挂住了而不是失败**——池被耗光之后
`pool.connect()` 永远不返回，你看到的只是一句「测试超时」。
改法是给整段探测套一个超时，并给 `npm test` 加了 `--test-timeout=60000`。
**一个会挂住的回归守卫比一个会失败的糟糕得多。**

## 载体状态

```
apps/api/src/index.ts            入口
apps/api/src/app.ts              Express 组装
apps/api/src/config.ts           PORT / DATABASE_URL / PG_POOL_MAX
apps/api/src/errors.ts           错误形状 + SQLSTATE -> ConstraintKind
apps/api/src/idempotency.ts      requestHash / canonicalize / claim / complete / release
apps/api/src/order-state.ts      状态机转移表
apps/api/src/db/index.ts         Db 接口（query / one / transaction）+ Dialect
apps/api/src/db/postgres.ts      pg 驱动 + 连接池 + 认领标记
apps/api/src/db/placeholders.ts  ? -> $n
apps/api/src/db/errors.ts        NestedTransactionError
apps/api/src/db/migrate.ts       迁移执行器（不认识任何一套具体迁移）
apps/api/src/db/migrations/pg/   001_pg_baseline、002_idempotency_keys
apps/api/src/db/migrations/sqlite/  001–003，冻结
apps/api/src/routes/             products.ts、orders.ts、async-handler.ts
apps/api/test/                   harness + test-db + 12 个测试文件
packages/shared/                 Zod schema + 22 条校验测试
scripts/                         verify-tag / race / backfill / reset-db / probe / check-encoding / drop-test-dbs
```

### 接口清单

| 接口 | 成功 | 可能失败 |
| --- | --- | --- |
| `GET /api/health` | 200 | — |
| `GET /api/products` | 200 | — |
| `GET /api/products/:id` | 200 | 404 `PRODUCT_NOT_FOUND` / 400 `INVALID_PARAM` |
| `POST /api/products` | 201 | 400 `VALIDATION_FAILED` / 409 `PRODUCT_SKU_TAKEN` |
| `DELETE /api/products/:id` | 204 | 404 `PRODUCT_NOT_FOUND` / 409 `PRODUCT_IN_USE` |
| `POST /api/orders` | 201 / 200（重放） | 400 `VALIDATION_FAILED` / 404 `USER_NOT_FOUND` / 404 `PRODUCT_NOT_FOUND` / 409 `OUT_OF_STOCK` / 409 `IDEMPOTENCY_KEY_REUSED` / 409 `IDEMPOTENT_REQUEST_IN_PROGRESS` |
| `GET /api/orders/:id` | 200 | 404 `ORDER_NOT_FOUND` / 400 `INVALID_PARAM` |
| `POST /api/orders/:id/transition` | 200 | 404 `ORDER_NOT_FOUND` / 409 `ORDER_STATE_INVALID` / 400 `VALIDATION_FAILED` |

`POST /api/orders` 接受 `Idempotency-Key` 请求头。**不带就是普通请求**，
自动生成一个键等于把幂等变成碰运气。

## 硬约束

改动之前先看这几条，它们不随会话变化：

- zod 钉 `~3.25.76`，不升 v4
- 端口 3002，不复用 3001
- `config.ts` 只放代码真的读到的键
- 数据访问层不按实体建 repository
- 文档不写「待写 / 待补 / 还没写」，不写「我们只讲 X 不讲 Y」这类句子
- **文档不引用还没写的章节**
- 文档里的每条命令标明是否改动数据
- `::: request` 容器里的响应必须实跑抓取，不能凭印象写
- **文档里举的每个例子都要实跑确认过**
- 工具选型每条都要给「不选它的理由」和「什么信号出现时该换」
- 交接文档里的行为断言要带本会话跑出来的命令和输出
- **改任何长文档，改完数一遍标题，逐段对照旧版**（四次审查里有三次栽在这）
- 每章收尾做变异测试，把挂掉的用例名写进 commit message
- 变异测试**一次只改一处**。两处同时改会落到另一条组合上，
  测到的不是你想测的东西
- 加测试文件后要改根 `package.json` 的 `test` 脚本（显式列文件名），
  并确认**测试条数涨了**
- **改了驱动或迁移执行器之后，五个 tag 全部重跑**
- **做变异测试前先提交**。`git checkout --` 恢复的是**已提交版本**，
  不是一个字没改过的当前工作区——S5 的 SQLSTATE 改写就是这样被抹掉过一次
- commit message 里不要出现双引号；用 `git commit -F %TEMP%\msg.txt`，
  文件放 `%TEMP%`（放仓库里会被 `git add -A` 带进去）
- 仓库根不要留日志文件
- **脚本里不要把局部变量命名为 `URL`**。它会遮蔽全局的 `URL` 构造器，
  下一行 `new URL(...)` 报「不是构造函数」，运行时也一样炸。
  **这个坑本会话踩了两次**（`reset-db.mjs` 和 `drop-test-dbs.mjs`），
  两次都是 `tsc` 抓到的——所以 scripts 纳入类型检查是有用的，不是形式主义
- 强停的测试进程会留下 `orders_test_<pid>` 库。
  清一次：`node scripts/drop-test-dbs.mjs`（不加 `--yes` 只列不删）
- **库名里带不带 `_test`，决定了它清不清得掉。** `drop-test-dbs.mjs` 认的是
  `LIKE '%\_test%'`。`verify-tag` 建的那个库早先叫 `verify_v1_4`，
  强停时留下之后清理脚本会报「没有残留」——**它不是没清，是压根没匹配上**。
  命名要跟着清理脚本的判据走，不是跟着「这个库干什么用的」走
- `db:reset` 会 `DROP DATABASE ... WITH (FORCE)`，**认的是 `DATABASE_URL`**。
  它有一道库名黑名单（`postgres` / `template0` / `template1` 直接拒绝），
  但除此之外的库名它照删不误。改这个环境变量之前先看一眼它指向哪

## 下一步

### 方向一：身份与权限（这一组唯一的遗留假设）

从 ch04 到 ch09，单进程、一个进程一条连接、同一时刻只有一个人在操作——
这些假设已经被逐个打破过了。**剩下「谁在操作」。**

它不是「再加一个接口」那么简单，会牵动已经定好的东西：

- **所有接口都没有归属校验，这一条范围比「幂等键」大得多。**
  `GET /api/orders/:id` 不看这个订单归谁，`POST /api/orders` 的 `userId`
  直接取自请求体。**任何人改一个 id 就能读别人的订单、为任意 userId 建单。**
  只加一道「登录中间件」不够——它解决「你是谁」，不解决「这个能碰吗」。
- `idempotency_keys` 的唯一键要从 `key` 变成 `(user_id, key)`。
  现在是全局唯一的，任何人拿别人的键重放都能拿到别人的订单。
  **这是上面那条的一个子集**，不是全部——只改成复合唯一键，
  「改个 id 读别人订单」照样成立。
- 状态机要加上「谁有资格走这条转移」。`order-state.ts` 现在是纯逻辑，
  判定输入只有 `(from, to)`，加上身份之后就不是纯函数了
- **不要就地改 SQLite 那三个迁移。** `migrations/sqlite/001_init.ts` 的注释里写着
  「cancelled 只能从 pending 转」，这与 `order-state.ts` 和手册 `ch07` 都对不上
  （`paid` 可以到 `cancelled`，代码是对的，注释是错的）。
  **但那行注释在 `up` 函数的 SQL 模板字符串里，改一个字 `checksumOf` 就变，
  `frozen.test.ts` 的三个指纹会挂。** 冻结的意义就是「明知有错也不动」——
  真要更正就把说明写在这里（也就是这一段），别去动文件。

**这三个改动会动到 ch09 刚定下的东西**，所以它不是「顺手加一章」。

### 方向二：发布

**三个仓已发布**（`RIP-LIP/fullstack-handbook` / `fullstack-todo-app` / `fullstack-backend`，
均为 public，issues 已关），handbook 走 GitHub Pages 上线。
**这里只写与本项目有关的三条经验**，建仓和推送的通用步骤不在这一份里。

**一、凭据不是「登录了就能用」。** `gh auth status` 可能同时列出两套凭据：
一个来自环境变量（`GH_TOKEN`）、一个来自系统 keyring。
前者如果是 fine-grained PAT，**它没有建仓这个权限项**，
`gh repo create` 会返回 403，换一个令牌也解决不了。
先确认 active 的是哪一套，需要建仓就切到 keyring 那一套：

```powershell
$env:GH_TOKEN = $null; $env:GITHUB_TOKEN = $null   # 只对当前这个 PowerShell 有效
gh auth status
```

新开一个窗口会退回环境变量里的那一套，所以这几条命令要在同一个会话里连着做完。

**二、git 和 gh 不读 Windows 的系统代理。**
开着系统代理（WinINET）PowerShell 能连上，但 git 直连会报
`Connection was reset`。**这里不要写死端口**——每个人的代理端口不一样，
写死了一个别人抄过去会静默失败。先问清楚自己的代理地址再配，
而且只配 repo 级，别污染全局：

```powershell
git config http.proxy http://<你的代理地址>:<端口>   # repo 级，不加 --global
```

**三、Pages 站点要先存在，第一次 push 一定失败。**
仓库里有 `deploy.yml` 并不等于 Pages 开着。首次 push 触发的那个 run
会在 `configure-pages` 报 `Not Found`——**因为站点还没建**。
而 `PUT .../pages` 是「更新」，对不存在的站点返回 404，得用 `POST` 建一次：

```powershell
gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow
gh workflow run deploy.yml --repo <owner>/<repo>     # 再手动触发一次
```

建站成功会返回 `html_url` 和 `build_type`，那个 `html_url` 就是站点地址。
`POST` 之后再 `PUT` 才有效。

**推送之前要确认两件事**：测试用的库全在容器里（`pg_database` 是容器内的东西，
代码推不走它），以及 `apps/api/data/` 已经在 `.gitignore` 里。
