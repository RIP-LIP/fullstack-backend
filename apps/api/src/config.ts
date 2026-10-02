/**
 * 环境变量集中读这一处。
 *
 * 只放当前代码真的读到的键。计划里的 DATABASE_URL 等到 ch08 换成
 * PostgreSQL 时再加——放进来没人读，就是一份会腐烂的配置。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 端口用 3002，不是 3001。fullstack-todo-app 占着 3001，两个服务要能同时起。
 */
export const PORT = Number(process.env.PORT ?? 3002)

/**
 * 数据库文件位置。默认落在 apps/api/data/ 下，该目录不进版本库。
 *
 * 这个环境变量是给测试用的：测试指向 mkdtemp 出来的临时文件，
 * 所以跑测试不会碰到你开发库里已有的数据。不设就用默认位置。
 */
export const DB_PATH = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve(here, '../data/app.db')
