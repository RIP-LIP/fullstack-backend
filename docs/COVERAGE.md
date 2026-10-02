# 覆盖情况

这个文件是会话之间的交接依据。换一个会话接着做之前，先读它。

最后更新：S3 完成时

## 现在在哪

S3（ch06 零停机变更）已完成。ch07 起未开始。

| 章节 | 主题 | tag | 状态 |
| --- | --- | --- | --- |
| — | 立项基线 | `v0.0` | 已完成 |
| ch04 | 数据模型 | `v1.0` | 已完成 |
| ch05 | 迁移 | `v1.1` | 已完成 |
| ch06 | 零停机变更 | `v1.2` | 已完成 |
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
| `npm run verify` | 退出 0（typecheck + **56 tests** / 0 fail，ch06 前是 47） |
| `node scripts/verify-tag.mjs v1.2` | 走完八步，56 tests 全跑，**本章检查 5/5**，退出 0 |
| `node scripts/verify-tag.mjs v1.0` / `v1.1` | 退出 0，各跑当时时点的测试数（35 / 47） |
| 手册 `npm run verify` | 22 页 593 条站内链接（54 锚点）全部有效 |
| 三页新文章节 | 200；桌面与窄屏两档都正常 |
| 计划性/自标榜字样 | ch04 / ch05 / ch06 均为 0 |

## ch06 实跑确认的事实

**JSON.stringify 会删掉值为 undefined 的键。** 直觉做法 `ALTER TABLE ... RENAME COLUMN name TO title`
跑完之后老代码 `row.name` 是 `undefined`，响应里 `name` **整个键消失**——不报错、不警告：

```
映射对象里 name 的值: undefined
序列化后: {"id":1,"sku":"KB-87","priceCents":39900,"stock":25,"createdAt":"..."}
```

**两种「静默」不一样，别混**：

| 情况 | 映射结果 | JSON 里 |
| --- | --- | --- |
| 列还在，值是 NULL | `null` | `"name":null`，键在，看得出不对 |
| 列被改名/删掉 | `undefined` | **键整个消失**，看不出少了东西 |

双读的 `?? row.name` 只能守第一种；第二种靠的是**别去改列名**。

**「两个版本同时对着一个库」的实测输出**（v1.1 导出到临时目录，`DB_PATH` 指向同一个
`app.db`，两个端口同时跑）：

```
v1.2 读 -> {"id":1,"sku":"OLD-1","name":"老商品1","title":"老商品1",...}
v1.1 读 -> {"id":1,"sku":"OLD-1","name":"老商品1",...}        没有 title 键
v1.1 写 -> 库里那一行 title 是 null
v1.2 读 -> {"id":25,...,"title":"老版本写的",...}            ?? 兜住了
```

**「回填归零」这个前提在老版本还在跑的时候不成立**（完整顺序跑过一遍）：

```
1. 造 3 行老数据 -> 回填补完 -> title IS NULL = 0
2. 老版本写一条   -> title IS NULL = 1   又回来了
3. 新版本读它     -> title 依然正确，靠 ??
```

所以 contract 的前提是「**老版本不会再被部署**」，不是「某一时刻回填归零」。
这两个看着像，差得很远——拿前者当前者用，删列之后老版本一写就是生产事故。

**回填脚本踩的两个坑（都是「不报错也不干活」）**：

1. `db.exec()` **不接受绑定参数**。用 `exec()` 跑 `... IN (?,?,?)`，那些问号是未绑定的
   占位符，值全为 NULL，`id IN (NULL,NULL,NULL)` 匹配不到任何行。语句成功执行、0 行受影响、
   无异常。换成 `prepare().run(...ids)` 立刻 `changes = 1`。实测：
   ```
   用 exec() 跑完（不传参）后: 0 ← 仍然是 0，语句没报错但一行没改
   用 prepare().run(3) 后: 1  changes = 1
   ```
2. **批处理没有「有没有真的推进」的检查**，剩余数不降就无限转，日志刷了 300 多行。
   已加进度守卫：每批核对剩余数真的少了，没少就报错停下。**批处理最坏的失败不是报错，
   是不报错也不推进。** 这条对任何批处理脚本都成立。

修好后每批 10 行：10 → 剩 13 → 剩 3 → 剩 0，共 3 批；再跑一遍 0 批 0 改动 0 补错。

**ch05 留下的 ADD COLUMN 边界现在派上用场了**：003 加 `title` 用的就是可空列，
正因为 002 的注释里记着「有行表上加 NOT NULL 无默认值会失败」。

## 变异测试记录

| 章 | 改坏的地方 | 挂掉的用例 |
| --- | --- | --- |
| ch04 | 去掉 DELETE 里的外键 409 翻译 | 1 条：删一个已经被订单引用的商品，返回 409 而不是 500 |
| ch04 | `rowToProduct` 里 `price_cents` 除以 100 | 3 条 |
| ch05 | 关掉迁移的 checksum 校验 | 2 条 |
| **ch06** | **双读里的 `?? row.name` 去掉** | **1 条**：老数据 title 退回 name |
| **ch06** | **`INSERT` 少写 `title` 一列** | **3 条**：双写两条 + 老代码视角一条 |

**ch06 两次抓到的用例不重叠**，说明双读和双写各自被独立守住，不是同一批断言在空转。

## 载体状态

```
apps/api/src/db/index.ts       Db 接口（query / one / transaction 三个方法）
apps/api/src/db/sqlite.ts     node:sqlite 实现 + createDb 工厂 + 模块顶层 await migrate
apps/api/src/db/migrate.ts    迁移执行器（版本表 + checksum + 每迁移一事务）
apps/api/src/db/migrations/   001_init / 002_add_product_description / 003_add_product_title
apps/api/src/routes/          products.ts、async-handler.ts
apps/api/test/                harness.ts + 6 个测试文件
scripts/backfill.mjs          ch06 的分批回填（幂等 + 可中断 + 进度守卫）
```

`products` 表现在 8 列：`id / sku / name / title / price_cents / stock / created_at / description`。
`name` 和 `title` 并存是**故意的**——expand 阶段不删任何东西。

`migrate.test.ts` 里断言迁移条数的那条**已改成对着 `allMigrations.length` 比**，
不再写死数字。以后加迁移不会再因为「条数变了」而红一次。

## 下一步：S4 做 ch07 事务

ch07 要处理「建订单同时动三张表」。`Db.transaction` 已经在 `sqlite.ts` 里实现好了，直接用。

**载体上要注意的**：`orders` 和 `order_items` 两张表建了但**没有接口**（ch04 只做了
products）。ch07 得先把建订单的路径写出来，代码量比 ch06 大。

订单状态机的取值域已被 `CHECK` 钉住（`pending` / `paid` / `shipped` / `completed` /
`cancelled`），但**转移规则还没实现**——那是 ch07 的核心内容。

## 硬约束

改动之前先看这几条，它们不随会话变化：

- zod 钉 `~3.25.76`，不升 v4
- 端口 3002，不复用 3001
- `config.ts` 只放代码真的读到的键
- 数据访问层不按实体建 repository
- 文档不写「待写 / 待补 / 还没写」，不写「我们只讲 X 不讲 Y」这类句子
- 文档里的每条命令标明是否改动数据
- `::: request` 容器里的响应必须实跑抓取，不能凭印象写
- **文档里举的每个例子都要实跑确认过**。会错和不会错的例子要分开写清楚
- **交接文档里的行为断言要带本会话跑出来的命令和输出**
- 每章收尾做变异测试，把挂掉的用例名写进 commit message
- 加测试文件后要改根 `package.json` 的 `test` 脚本（显式列文件名），
  并确认 `npm test` 的**测试条数涨了**。没涨就是没跑到
- **commit message 里不要出现双引号**——PowerShell 会把它截断，git 收到乱参数。
  写进文件用 `git commit -F 文件`，文件也**别放在仓库里**（会被 `git add -A` 带进去），
  放 `%TEMP%`

## 已经验过的

| 项 | 结果 |
| --- | --- |
| `npm run verify` | 退出 0（typecheck + 47 tests / 0 fail） |
| `npm test` | 47 tests / 17 suites / 0 fail |
| `node scripts/verify-tag.mjs v1.0` | 走完八步，导出目录里 35 tests 全跑，**本章验证命令 5/5**，退出 0 |
| `node scripts/verify-tag.mjs v1.1` | 同上，47 tests 全跑，**本章验证命令 4/4**，退出 0 |
| 对不存在的 tag 跑同一脚本 | 退出 1，不静默通过 |
| 对**没配本章检查**的 tag 跑 | 退出 1，打印「加一章就要在 CHAPTER_CHECKS 里补一条」 |
| 把 v1.0 的一条检查期望改错 | 只挂那一条，`1/5 条没过`，其余 4 条照常通过 |
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

> 本节每一条都附了**本会话跑出来的命令和实际输出**。要复现就直接复制命令跑一遍。
> 上一版这里只给结论不给命令，违反了本文档自己的规矩（见「硬约束」最后两条），
> 结果是下一个会话得重新推导一遍才能确认。新版补上命令。

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

`@types/node` 的 `sqlite.d.ts` 里也标着 `@default true`（`enableForeignKeyConstraints` 字段上方）。

**所以「SQLite 默认关外键」是错的**，会把读者引去查一个不存在的问题。

显式关掉之后，删父行会留下孤儿行**且不报错**：

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const b=new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
b.exec('CREATE TABLE p(id INTEGER PRIMARY KEY)');
b.exec('CREATE TABLE c(id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))');
b.prepare('INSERT INTO p VALUES (1)').run();
b.prepare('INSERT INTO c VALUES (1,1)').run();
b.exec('DELETE FROM p WHERE id=1');
console.log('子行还在:', b.prepare('SELECT COUNT(*) AS n FROM c').get().n);"
```

```
子行还在: 1
```

事务内设置静默无效：

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:',{enableForeignKeyConstraints:false});
d.prepare('PRAGMA foreign_keys = OFF').run();
d.exec('BEGIN');
d.prepare('PRAGMA foreign_keys = ON').run();
console.log('事务内设 ON 之后:', JSON.stringify(d.prepare('PRAGMA foreign_keys').get()));
d.exec('ROLLBACK');"
```

```
事务内设 ON 之后: {"foreign_keys":0}
```

开着的状态下，有子行时删父行 → `errcode: 787`（`SQLITE_CONSTRAINT_FOREIGNKEY`），ch04 的 409 就是从它翻译出来的。

### ADD COLUMN 的边界

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT)');
d.prepare('INSERT INTO t (title) VALUES (?)').run('有一条数据');
try { d.exec('ALTER TABLE t ADD COLUMN owner TEXT NOT NULL'); console.log('有行+无默认值: 成功'); }
catch(e){ console.log('有行+无默认值: 失败 ->', e.message); }
try { d.exec('ALTER TABLE t ADD COLUMN owner TEXT NOT NULL DEFAULT \'\'');
      console.log('有行+有默认值:', JSON.stringify(d.prepare('PRAGMA table_info(t)').all().map(r=>r.name))); }
catch(e){ console.log('有行+有默认值: 失败 ->', e.message); }
const e2=new DatabaseSync(':memory:');
e2.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT)');
e2.exec('ALTER TABLE t ADD COLUMN owner TEXT NOT NULL');
console.log('空表+无默认值: 成功');"
```

```
有行+无默认值: 失败 -> Cannot add a NOT NULL column with default value NULL
有行+有默认值: ["id","title","owner"]
空表+无默认值: 成功
```

**「能不能加」取决于表里有没有数据，不是语法允不允许。**

### CREATE TABLE IF NOT EXISTS 不管表长什么样

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('CREATE TABLE products (id INTEGER PRIMARY KEY, sku TEXT)');
d.prepare('INSERT INTO products (sku) VALUES (?)').run('OLD-1');
console.log('老库的列:', JSON.stringify(d.prepare('PRAGMA table_info(products)').all().map(r=>r.name)));
d.exec('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, sku TEXT, name TEXT, price_cents INTEGER)');
console.log('重跑之后:', JSON.stringify(d.prepare('PRAGMA table_info(products)').all().map(r=>r.name)));
console.log('表里的行:', JSON.stringify(d.prepare('SELECT * FROM products').all()));"
```

```
老库的列: ["id","sku"]
重跑之后: ["id","sku"]
表里的行: [{"id":1,"sku":"OLD-1"}]
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

两个推论：

- 「每个迁移一个事务」成立——执行到一半失败不会留下建了一半的表
- DDL 走 `prepare().all()` 正常，所以数据层只要 `query` / `one` / `transaction` 三个方法就够，**不需要第四个**

### 浮点：会错的

```bash
node -e "console.log('0.1+0.2  =', 0.1+0.2);
console.log('8.2*3    =', 8.2*3);
console.log('4.35*100 =', 4.35*100);
console.log('1.005*100=', 1.005*100);"
```

```
0.1+0.2  = 0.30000000000000004
8.2*3    = 24.599999999999998
4.35*100 = 434.99999999999994
1.005*100= 100.49999999999999
```

存进 SQLite 的 REAL 列也是同一个值：

```bash
node -e "const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(':memory:');
d.exec('CREATE TABLE t(v REAL)');
d.prepare('INSERT INTO t VALUES (?)').run(8.2*3);
console.log('REAL 列读回来:', d.prepare('SELECT v FROM t').get().v);"
```

```
REAL 列读回来: 24.599999999999998
```

### 浮点：不会错的，别拿去举例

```bash
node -e "console.log('0.999+1.5+0.501 =', 0.999+1.5+0.501);
console.log('19.99*3          =', 19.99*3);
console.log('9.99+0.01        =', 9.99+0.01);
console.log('29.9+10.1        =', 29.9+10.1);
console.log('1234.56+0.44     =', 1234.56+0.44);"
```

```
0.999+1.5+0.501 = 3
19.99*3          = 59.97
9.99+0.01        = 10
29.9+10.1        = 40
1234.56+0.44     = 1235
```

**这五个全是精确的。** S2 就因为随手挑了 `0.999 + 1.5 + 0.501` 当反例，测试直接挂了一条。
写教程或报告时最容易出的错就是「随手挑几个数」说明浮点有问题——挑到不会错的那组，整段话就废了。

### 没有 asyncHandler 会怎样（ch04 用）

**不是「请求挂住」，是整个进程退出。** 本会话实跑确认：

```bash
# 正常：包着 asyncHandler
curl -i --max-time 5 http://localhost:3002/api/products/1.5
```

```
HTTP/1.1 400 Bad Request
{"error":{"code":"INVALID_PARAM","message":"id 必须是正整数"}}
```

22 毫秒返回，服务继续跑。**把那一处的 `asyncHandler(...)` 拆掉，其余不动**，同一条命令：

```
HTTP 000  耗时 0.031s
```

`000` 是 curl 的说法：连接被关掉了，一个字节都没收到。随后 `curl /api/health` 也是 `000`，Node 进程已经不在了：

```
HttpError: id 必须是正整数
    at parseId (apps/api/src/routes/products.ts:54:11)
    at <anonymous> (apps/api/src/routes/products.ts:73:16)
  status: 400,
  code: 'INVALID_PARAM',
  fields: undefined
}

Node.js v24.16.0
```

**一条非法参数请求打死整个服务，当时在处理的所有请求一起死。** Express 4 不等 async 路由返回的 Promise，`throw` 变成 unhandled rejection，Node 15 之后默认让进程退出。

ch04 的计划里原本预测的是「请求挂住直到超时」。**实跑推翻了这个预测**，已按实跑结果写进文档。教训：隐性规则这一类，**不跑就没有准确描述**。

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
