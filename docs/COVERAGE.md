# 覆盖情况

这个文件是会话之间的交接依据。换一个会话接着做之前，先读它。

最后更新：S4 完成时

## 现在在哪

S4（ch07 事务）已完成。ch08 起未开始。

| 章节 | 主题 | tag | 状态 |
| --- | --- | --- | --- |
| — | 立项基线 | `v0.0` | 已完成 |
| ch04 | 数据模型 | `v1.0` | 已完成 |
| ch05 | 迁移 | `v1.1` | 已完成 |
| ch06 | 零停机变更 | `v1.2` | 已完成 |
| ch07 | 事务 | `v1.3` | 已完成 |
| ch08 | 换 PostgreSQL | `v1.4` | 未开始 |
| ch09 | 幂等 | `v1.5` | 未开始 |
| ch10 | 认证与授权 | `v1.6` | 未开始 |
| ch11 | 错误契约 | `v1.7` | 未开始 |
| ch12 | 性能 | `v1.8` | 未开始 |

手册侧在 `fullstack-handbook` 的 `docs/guide/deep/`，侧边栏是「后端往下走」第二分组。

## 已经验过的

| 项 | 结果 |
| --- | --- |
| `npm run verify` | 退出 0（typecheck + 乱码 + **81 tests** / 0 fail，ch07 前是 56） |
| `node scripts/verify-tag.mjs v1.3` | 走完八步，81 tests 全跑，**本章检查 6/6**，退出 0 |
| `node scripts/verify-tag.mjs v1.0` / `v1.1` / `v1.2` | 全部退出 0。**改了 `sqlite.ts` 之后必须重跑这三个**，它们也走 `transaction` |
| 手册 `npm run verify` | **23 页** 631 条站内链接（54 锚点）全部有效 |
| 四页新文章节 | 200；桌面与窄屏两档都正常 |
| 计划性/自标榜字样 | ch04–ch07 均为 0（`待写/待补/未来的/ch0[8-9]/ch1[0-9]` 全扫过） |
| U+FFFD 乱码 | 两仓各加了一道检查，插入即 exit 1、恢复即 exit 0 |

## 审查记录

这一组不是一次写完的。S2、S3、S4 各做过一次产出审查。

### S2 审查（针对 ch04 + ch05）

做法不是读代码挑毛病，是**把文档里声称的输出逐条重跑一遍**。
「示例必须实跑过」是这个站的底线，只有重跑才算核过。

| # | 查什么 | 结果 |
| --- | --- | --- |
| 1 | 两个 tag 能否独立复现 | v1.0 / v1.1 各跑当时时点的测试数，退出 0 |
| 2 | ch04 的 8 个 `::: request` 响应 | 逐字一致 |
| 3 | ch05 的 5 段可运行输出 | 逐字一致 |
| 4 | 迁移报错模板 | 与 `migrate.ts` 实际拼装逐行一致 |
| 5 | 浮点例子（会错 / 不会错两组） | 都实跑过，数字准确 |
| 6 | 导航三处、禁止项、zod 锁定、三方法数据层 | 全部符合 |

**结论：无阻塞性问题。** 但审出 2 个中等 + 4 个轻微缺口，都已修完：

| 编号 | 缺口 | 怎么修的 |
| --- | --- | --- |
| M1 | COVERAGE 违反自己定的规矩：行为断言只给结论不给命令 | 每条断言补上实跑的命令和实际输出 |
| M2 | `asyncHandler` 在三页文档里 0 命中 | 补进 ch04 §7，**配实跑输出** |
| L1 | `description` 列接口从不返回，全文无解释 | ch05 §1 点明是有意为之 |
| L2 | `HttpError` 二次翻译的防错只在代码注释里 | ch04 §7 加「还有第三种」 |
| L3 | `verify-tag` 只探 health，不跑该章验证命令 | 加 `CHAPTER_CHECKS` 表 |
| V1 | ch04 §2 接口表只列成功码 | 加「可能失败时」列 |
| L4 | `verify-out` 落在仓库根、`.verify-tmp` 是死条目 | outDir 挪进 `node_modules/.cache/`，删死条目 |

**M2 那条带出一个教训**：计划预测「去掉 asyncHandler 后请求挂住直到超时」，
**实跑推翻了它**——实际是**整个进程退出**。

### S3 自查（针对 ch06）

交付前自己又查了两轮，抓到两个问题：

1. **ch06 有一条断言是推的没验的。**「回填永远补不齐所有行」这句话，
   机制在别处验过，但**那个顺序没跑过**。补跑了一遍完整序列，结论还比原来那句更硬。
2. **COVERAGE 自己被改出 5 段重复残留**，其中两段是过期的。已去重。

由此加进硬约束：**改交接文档时，替换完要数一遍标题，确认没有残留。**

### S4 审查（针对 ch04–ch06 的全部产物）

**这次审出的是真缺陷，不是风格问题。** 最重要的一条：

> **`Db.transaction` 的原子性不成立。**
> `BEGIN` 之后 `await fn(db)` 把控制权交回事件循环，
> 别的请求的写语句会执行在这个事务里，跟着它一起回滚。
> 那个请求拿到 200，数据没了，全程无异常。

已修（`withConnection` 占用门 + `AsyncLocalStorage` 归属标记），
并且 `transaction.test.ts` 是它的回归守卫。**详见下面「ch07 实跑确认的事实」。**

审出 14 项，全部已修。分类：

| 类别 | 条数 | 代表 |
| --- | :-: | --- |
| 真缺陷（数据正确性） | 1 | 事务原子性是假的 |
| 真缺陷（错误语义） | 2 | `ROLLBACK` 失败顶替原始错误；嵌套靠 SQLite 报错 |
| 事实错误 | 2 | `async-handler` 注释还写着「请求挂住」；README 测试条数 47（实际 56） |
| 乱码 | 3 | `ch03.md:180`、`ch06.md:553`、`toolkit/design.md:161` |
| 重复段落 | 2 | `ch06.md` 结尾两段逐字重复；COVERAGE 的重复块（S3 自称已去重，实际没去干净） |
| 覆盖缺失 | 2 | 工具选型几乎空白（用户明确要求，三章合计只有 1 行提到 ORM） |
| 计划字样 | 2 | 「未来的 004」「ch11 会…后面 9 章」 |

**这一轮也暴露了一个模式**：三次审查里，有两次抓到的重复段落
都出现在**「改了开头没删旧的」**这个位置。COVERAGE 和 ch06 各中一次。
所以硬约束那条现在扩展成：**改任何长文档，改完数一遍标题，逐段对照旧版。**

## ch07 实跑确认的事实

以下每条都附了本会话跑出来的命令和实际输出。要复现就直接复制命令。

### 事务的原子性来自「不让出事件循环」，不是来自 BEGIN/COMMIT

2×2 对照（两种实现 × 两种事务体）：

| 实现 | 事务体里 await 什么 | 另一个请求的结果 | 它写的行 |
| --- | --- | --- | --- |
| 没有门 | 只 await 同步查询 | `fulfilled` | 还在 |
| 没有门 | **await 定时器** | `fulfilled` | **没了** |
| 加了门 | 只 await 同步查询 | `fulfilled` | 还在 |
| 加了门 | await 定时器 | `fulfilled` | 还在 |

只有第二行是故障点。**为什么第一种情况没事**：
`await` 一个已 resolve 的 Promise 产生的只是**微任务**，微任务队列会被排空，
而 Node 处理下一个 HTTP 请求需要**宏任务**。所以「只 await 数据库查询」
的链路上事件循环插不进来。

**这就是 `migrate.ts` 今天没出事的原因**，也仅限于这个原因。

### 数据静默丢失的完整现场

```
事务这一侧: rejected - 这一步失败了
另一个请求: fulfilled   <- 它成功了

=== 事务回滚之后（只读）===
另一个请求写的那一行还在吗: 没了
它拿到的响应是: 200 / 成功
服务端日志: 没有任何异常
```

### 回滚失败会顶替原始错误

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('BEGIN'); d.exec('ROLLBACK');
try { d.exec('ROLLBACK'); console.log('空 ROLLBACK: 没报错'); }
catch(e){ console.log('空 ROLLBACK ->', e.message); }
d.exec('BEGIN'); d.exec('COMMIT');
try { d.exec('ROLLBACK'); console.log('COMMIT 后 ROLLBACK: 没报错'); }
catch(e){ console.log('COMMIT 后 ROLLBACK ->', e.message); }
"
```

```
空 ROLLBACK -> cannot rollback - no transaction is active
COMMIT 后 ROLLBACK -> cannot rollback - no transaction is active
```

不单独 try/catch 的话，这句会顶替掉本该给客户端的 409 `OUT_OF_STOCK`。

### 嵌套事务原来不是守卫

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('BEGIN');
try { d.exec('BEGIN'); console.log('嵌套 BEGIN: 没报错'); }
catch(e){ console.log('嵌套 BEGIN ->', e.message); }
"
```

```
嵌套 BEGIN -> cannot start a transaction within a transaction
```

**报错来自 SQLite，不是代码。** 现在换成 `NestedTransactionError`。

### CHECK 只管值域，不管转移

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec(\"CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','completed','cancelled'))\");
d.prepare('INSERT INTO orders (status) VALUES (?)').run('cancelled');
const r=d.prepare(\"UPDATE orders SET status='paid' WHERE id=1\").run();
console.log('cancelled 改成 paid，changes =', r.changes, ' <- 库接受了');
try { d.prepare(\"UPDATE orders SET status='refunded' WHERE id=1\").run(); }
catch(e){ console.log('改成 refunded ->', e.code); }
"
```

```
cancelled 改成 paid，changes = 1  <- 库接受了
改成 refunded -> ERR_SQLITE_ERROR
```

**一个 cancelled 的订单被直接改成 paid，库照收不误。**
改成 `refunded` 会被拦住，因为它不在枚举里——**值域和转移是两件事**，
`CHECK` 只管前者，转移必须在代码里判。

### 不用事务的半套数据

```
第 1 步：orders 建好了，id = 2
第 2 步：order_items 写了 1 行
第 3 步：甲的库存扣了 3，changes = 1
第 4 步：乙库存不足，changes = 0  <- 这一步失败了

=== 现在库里是什么状态（只读）===
订单 2 存在: true
它的明细行数: 1 （这一单要 2 行）
甲的库存: 7 （下单前 10，这一单要买 3 件）
甲的库存和订单对得上吗: 对得上
```

**订单存在，明细缺一行。** 而且第 4 步**没有抛异常**——
`UPDATE ... WHERE stock >= 50` 匹配不到行，语句成功执行、0 行受影响。

## 载体状态

```
apps/api/src/db/index.ts       Db 接口（query / one / transaction 三个方法）
apps/api/src/db/sqlite.ts      node:sqlite 实现 + withConnection 占用门 + NestedTransactionError
apps/api/src/db/migrate.ts     迁移执行器（版本表 + checksum + 每迁移一事务）
apps/api/src/db/migrations/    001_init / 002_add_product_description / 003_add_product_title
apps/api/src/routes/           products.ts、orders.ts、async-handler.ts
apps/api/src/order-state.ts    订单状态机转移表（独立于路由，可单独测）
apps/api/test/                 harness.ts + 8 个测试文件
scripts/backfill.mjs           ch06 的分批回填
scripts/verify-tag.mjs         tag 级复现 + 每章的 CHAPTER_CHECKS
scripts/check-encoding.mjs     乱码检查
```

`products` 表现在 8 列：`id / sku / name / title / price_cents / stock / created_at / description`。
`name` 和 `title` 并存是**故意的**——expand 阶段不删任何东西。

### 订单接口的形状

| 接口 | 成功 | 可能失败 |
| --- | --- | --- |
| `POST /api/orders` | 201 | 400 `VALIDATION_FAILED` / 404 `PRODUCT_NOT_FOUND` / 404 `USER_NOT_FOUND` / 409 `OUT_OF_STOCK` |
| `GET /api/orders/:id` | 200 | 404 `ORDER_NOT_FOUND` / 400 `INVALID_PARAM` |
| `POST /api/orders/:id/transition` | 200 | 404 `ORDER_NOT_FOUND` / 409 `ORDER_STATE_INVALID` / 400 `VALIDATION_FAILED` |

状态机转移表：

| 从 | 可以到 |
| --- | --- |
| `pending` | `paid`、`cancelled` |
| `paid` | `shipped`、`cancelled` |
| `shipped` | `completed` |
| `completed` | （终态） |
| `cancelled` | （终态） |

## 变异测试记录

| 章 | 改坏的地方 | 挂掉的用例 |
| --- | --- | --- |
| ch04 | 去掉 DELETE 里的外键 409 翻译 | 1 条：删一个已经被订单引用的商品，返回 409 而不是 500 |
| ch04 | `rowToProduct` 里 `price_cents` 除以 100 | 3 条 |
| ch05 | 关掉迁移的 checksum 校验 | 2 条 |
| ch06 | 双读里的 `?? row.name` 去掉 | 1 条：老数据 title 退回 name |
| ch06 | `INSERT` 少写 `title` 一列 | 3 条：双写两条 + 老代码视角一条 |
| **ch07** | **去掉 `withConnection` 的排队** | **1 条**：并发请求的写入不会被事务回滚吞掉 |
| **ch07** | **转移表里 `completed` 加上 `paid`** | **2 条**：终态没有任何出边 + 转移表和接口表现一致 |
| **ch07** | **转移表里 `pending` 加上 `completed`** | **1 条**：非法转移不写库，状态保持原样 |

**ch07 三次抓到的用例不重叠**，说明三处规则各自被独立守着。

**ch07 的变异测试还抓出了自己的覆盖缺口**：
第二次变异（`completed` 加 `paid`）最初只被纯逻辑那条抓住，
接口层没有对应断言——因为没有任何 HTTP 测试走 `completed → paid`。
补上之后两个变异都能被接口层抓到。

## 下一步：S5 做 ch08 换 PostgreSQL

### 这一章的转折点

ch04 那层只暴露三个方法，就是为了这一天。**换库时业务代码应该一行不改**，
改的只有 `db/sqlite.ts` 这一个文件。

**兑现 ch02 原文承诺**：「SQLite 代价什么时候不可接受，讲换数据库那篇会讲」。

### S5 的起点

1. `docker compose up -d`，`docker compose ps` 看到 healthy 才算好。
   `postgres:17-alpine` 镜像本机已确认能拉下来（exit 0）。
   **本机没有装 PostgreSQL，5432 无监听**——必须用 Docker。
   这条命令**会新建容器**，不碰你机器上已有的任何容器。
2. 选驱动（**本轮未决，S5 决定**）：`pg` 8.23.1 还是 `postgres.js`。
   `node_modules` 里目前**没有** `pg`，要新装。
3. 新建 `db/postgres.ts`，实现同样的三个方法。
4. **不需要新迁移**：PostgreSQL 兼容 SQLite 的大部分 SQL，
   但 `AUTOINCREMENT`、`TEXT NOT NULL` 之外的细节要逐条验。

### 换库时一定会踩的坑（S5 验一遍再写）

- **`withConnection` 那道门要删掉。** PostgreSQL 的连接池会保证
  一个事务独占一条连接，事务归属不再是「一个进程只有一条连接」那个前提。
  留着它只会让所有查询排队到池里。
- **`AUTOINCREMENT` 在 PostgreSQL 里不存在**，对应的是 `SERIAL` / `IDENTITY`。
- **大小写**：PostgreSQL 会把未加引号的标识符转成小写。
  `order_items` 这种全小写没事，`unitPriceCents` 这种驼峰会找不到列。
- **`RETURNING` 两边都支持**，这一点不用改。
- **金额仍是整数分**，这条不随数据库变。

### ch08 的量

比 ch07 小。核心工作是「写 `db/postgres.ts` + 证明业务代码没改」，
再补上**换库后才出现的那几个问题**（连接池耗尽、`LIMIT` 的执行计划、
`SERIAL` 的序列）。不需要新写接口。

**注意**：ch07 的 `transaction.test.ts` 里那些并发断言，
在换库之后**要重新验一遍**——它们守的性质不变，但实现机制完全不同了。

## 硬约束

改动之前先看这几条，它们不随会话变化：

- zod 钉 `~3.25.76`，不升 v4
- 端口 3002，不复用 3001
- `config.ts` 只放代码真的读到的键
- 数据访问层不按实体建 repository
- 文档不写「待写 / 待补 / 还没写」，不写「我们只讲 X 不讲 Y」这类句子
- **文档不引用还没写的章节**（`ch08` 及以后）。范围没覆盖到的地方就不提
- 文档里的每条命令标明是否改动数据
- `::: request` 容器里的响应必须实跑抓取，不能凭印象写
- **文档里举的每个例子都要实跑确认过**。会错和不会错的例子要分开写清楚
- **工具选型每条都要给「不选它的理由」和「什么信号出现时该换」**，只列库名不算
- 交接文档里的行为断言要带本会话跑出来的命令和输出
- **改任何长文档，改完数一遍标题，逐段对照旧版**（三次审查里有两次栽在这）
- 每章收尾做变异测试，把挂掉的用例名写进 commit message
- 加测试文件后要改根 `package.json` 的 `test` 脚本（显式列文件名），
  并确认 `npm test` 的**测试条数涨了**。没涨就是没跑到
- **改了 `db/sqlite.ts` 之后，`verify-tag` 四个 tag 全部重跑**，
  它们都走 `transaction`
- **commit message 里不要出现双引号**——PowerShell 会把它截断，git 收到乱参数。
  写进文件用 `git commit -F 文件`，文件也**别放在仓库里**（会被 `git add -A` 带进去），
  放 `%TEMP%`
- 仓库根不要留日志文件。它们被 `.gitignore` 挡住所以 `git status` 看不出来，
  但下一个会话会误读成产物

## 前三个会话留下的、本会话原样保留的事实

> 每条都附了实跑出来的命令和实际输出。要复现就复制命令跑一遍。

### 外键默认是开的

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const a=new DatabaseSync(':memory:');
console.log('默认:', JSON.stringify(a.prepare('PRAGMA foreign_keys').get())); a.close();
const b=new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
console.log('显式关掉:', JSON.stringify(b.prepare('PRAGMA foreign_keys').get()));"
```

```
默认: {"foreign_keys":1}
显式关掉: {"foreign_keys":0}
```

**所以「SQLite 默认关外键」是错的**，会把读者引去查一个不存在的问题。
显式设 `ON` 仍然该做，真实理由是三条：pragma **按连接**生效；
**事务内设置静默无效**；换客户端默认值不保证相同。

### ADD COLUMN 的边界

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT)');
d.prepare('INSERT INTO t (title) VALUES (?)').run('有一条数据');
try { d.exec('ALTER TABLE t ADD COLUMN owner TEXT NOT NULL'); console.log('有行+无默认值: 成功'); }
catch(e){ console.log('有行+无默认值: 失败 ->', e.message); }
const e2=new DatabaseSync(':memory:');
e2.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT)');
e2.exec('ALTER TABLE t ADD COLUMN owner TEXT NOT NULL');
console.log('空表+无默认值: 成功');"
```

```
有行+无默认值: 失败 -> Cannot add a NOT NULL column with default value NULL
空表+无默认值: 成功
```

**「能不能加」取决于表里有没有数据，不是语法允不允许。**
ch06 的 003 迁移用的就是可空列，正是因为这条。

### CREATE TABLE IF NOT EXISTS 不管表长什么样

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT)');
d.prepare('INSERT INTO products (sku) VALUES (?)').run('OLD-1');
d.exec('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, sku TEXT, name TEXT)');
console.log('重跑之后的列:', JSON.stringify(d.prepare('PRAGMA table_info(products)').all().map(r=>r.name)));"
```

```
重跑之后的列: ["id","sku"]
```

**新加的列没有出现。** `IF NOT EXISTS` 只判断「这张表在不在」。

### DDL 在 SQLite 里是事务性的

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('BEGIN');
d.prepare('CREATE TABLE v (id INTEGER PRIMARY KEY)').all();
d.exec('ROLLBACK');
console.log('回滚后表数:', d.prepare('SELECT COUNT(*) AS n FROM sqlite_master WHERE name = \'v\'').get().n);"
```

```
回滚后表数: 0
```

两个推论：「每个迁移一个事务」成立；DDL 走 `prepare().all()` 正常，
所以数据层只要 `query` / `one` / `transaction` 三个方法就够。

### 浮点：会错的

```bash
node -e "console.log('0.1+0.2  =', 0.1+0.2);
console.log('8.2*3    =', 8.2*3);
console.log('4.35*100 =', 4.35*100);"
```

```
0.1+0.2  = 0.30000000000000004
8.2*3    = 24.599999999999998
4.35*100 = 434.99999999999994
```

### 浮点：不会错的，别拿去举例

```bash
node -e "console.log('0.999+1.5+0.501 =', 0.999+1.5+0.501);
console.log('19.99*3          =', 19.99*3);
console.log('9.99+0.01        =', 9.99+0.01);
console.log('29.9+10.1        =', 29.9+10.1);"
```

```
0.999+1.5+0.501 = 3
19.99*3          = 59.97
9.99+0.01        = 10
29.9+10.1        = 40
```

**这四个全是精确的。** S2 就因为随手挑了 `0.999 + 1.5 + 0.501` 当反例，
测试直接挂了一条。**随手挑几个数说明浮点有问题，挑到不会错的那组整段话就废了。**

### 没有 asyncHandler 会怎样

**不是「请求挂住」，是整个进程退出。**

```bash
curl -i --max-time 5 http://localhost:3002/api/products/1.5
```

```
HTTP/1.1 400 Bad Request
{"error":{"code":"INVALID_PARAM","message":"id 必须是正整数"}}
```

22 毫秒返回。**把那一处的 `asyncHandler(...)` 拆掉，其余不动**，同一条命令：

```
HTTP 000  耗时 0.031s
```

`000` 是 curl 的说法：连接被关掉了，一个字节都没收到。随后 health 也是 `000`，
Node 进程已经不在了。Express 4 不等 async 路由返回的 Promise，
`throw` 变成 unhandled rejection，Node 15 之后默认让进程退出。

**一条非法参数请求打死整个服务，当时在处理的所有请求一起死。**

### 批处理脚本的进度守卫

`db.exec()` **不接受绑定参数**。用 `exec()` 跑 `... IN (?,?,?)`，
那些问号是未绑定的占位符，值全为 NULL，语句成功执行、0 行受影响、无异常。
换成 `prepare().run(...ids)` 立刻 `changes = 1`。

而批处理的循环条件是 `while (total > 0)`——`total` 永远不降，于是**无限循环**。
修法是每批跑完核对「剩余数真的少了」，没少就报错停下。

**批处理最坏的失败不是报错，是不报错也不推进。** 这条对任何批处理脚本都成立。
