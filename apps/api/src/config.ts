/**
 * 环境变量集中读这一处。
 *
 * 只放当前代码真的用到的键。计划里的 DATABASE_URL 等到 ch08 换成
 * PostgreSQL 时再加——放进来没人读，就是一份会腐烂的配置。
 */

/**
 * 端口用 3002，不是 3001。fullstack-todo-app 占着 3001，两个服务要能同时起。
 */
export const PORT = Number(process.env.PORT ?? 3002)
