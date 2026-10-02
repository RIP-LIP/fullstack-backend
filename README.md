# fullstack-backend

订单/库存领域的后端。Node + Express + TypeScript，正文在 [fullstack-handbook](https://github.com/RIP-LIP/fullstack-handbook) 的 `guide/deep/` 分组。

配套的入门项目是 [fullstack-todo-app](https://github.com/RIP-LIP/fullstack-todo-app)，一条任务清单从空目录做到可用应用。两个项目独立，端口不冲突。

## 环境要求

| 项 | 版本 | 说明 |
| --- | --- | --- |
| Node | >= 22 | 22.5 起才有内置的 `node:sqlite` |
| Docker | 任意近期版本 | 只有讲 PostgreSQL 那几章用得到 |

本机没装 PostgreSQL 也不用装，用 Docker 起一个。

## 跑起来

```bash
npm install
npm test          # 3 条集成测试
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

## 起数据库

当前基线还没有任何表，代码也不连数据库。compose 文件先摆在这儿，等讲 PostgreSQL 那章接上。

```bash
docker compose up -d        # 起库
docker compose ps           # 看到 healthy 才算好
docker compose down         # 停掉；加 -v 连数据卷一起删
```

`docker compose up -d` 不改你机器上任何已有容器的状态，只新建 `fullstack-backend-db` 这一个。

## 目录结构

```
apps/api/
  src/index.ts         入口，读端口、监听
  src/app.ts           Express 组装，导出以便测试
  src/config.ts        环境变量集中读
  src/errors.ts        统一错误形状
  test/api.test.ts     集成测试
packages/shared/       Zod schema 与共享类型
scripts/
  verify-tag.mjs       tag 级复现
docker-compose.yml     PostgreSQL
```

## tag 与章节的对应

每个 tag 都能被独立复现，指的是：导出这个 tag 的代码、装依赖、跑测试、起服务、健康检查通过。

| tag | 对应章节 | 内容 |
| --- | --- | --- |
| `v0.0` | 无 | 立项基线：能跑、能测、能复现 |
| `v1.0` | ch04 | 数据模型 |
| `v1.1` | ch05 | 迁移 |
| `v1.2` | ch06 | 零停机变更 |
| `v1.3` | ch07 | 事务 |
| `v1.4` | ch08 | 换 PostgreSQL |
| `v1.5` | ch09 | 幂等 |
| `v1.6` | ch10 | 认证与授权 |
| `v1.7` | ch11 | 错误契约 |
| `v1.8` | ch12 | 性能 |

`v0.0` 不对应任何一章，它代表「讲任何一章之前，仓库长这样」。

复现一个 tag：

```bash
node scripts/verify-tag.mjs v0.0
```

脚本会导出到临时目录、装依赖、跑测试、起服务探健康、然后清理。**会改动临时目录，也会在本机短暂占一个端口**，不碰你当前工作区。

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
