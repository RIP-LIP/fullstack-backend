/**
 * 环境变量集中读这一处。
 *
 * 只放当前代码真的读到的键。放进来没人读，就是一份会腐烂的配置。
 */

/**
 * 端口用 3002，不是 3001。fullstack-todo-app 占着 3001，两个服务要能同时起。
 */
export const PORT = Number(process.env.PORT ?? 3002)

/**
 * PostgreSQL 连接串。
 *
 * 默认值指向 `docker compose up -d` 起出来的那个容器。
 * 换过端口或密码就传 DATABASE_URL 进来。
 *
 * **测试用的那个库名必须以 `_test` 结尾**，这是 `db/postgres.ts` 里的
 * 安全闸会检查的东西：测试永远不该碰到开发库，而「靠记得别连错」
 * 显然靠不住。
 */
export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'

/**
 * 连接池大小，按「同时最多有几个请求在跑」定。
 *
 * 每一个连接都是一条到数据库的网络往返，机器有多少核跟它没关系，
 * 所以别按 CPU 核数去设。10 对这个项目绰绰有余。
 */
export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX ?? 10)
