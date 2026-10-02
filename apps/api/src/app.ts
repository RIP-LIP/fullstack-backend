import express from 'express'
import type { HealthResponse } from '@fullstack/shared'
import { toApiError } from './errors.ts'

/**
 * 组装 Express 应用，导出 app 本身。
 *
 * 拆成 app.ts 和 index.ts 是为了让接口能写测试：
 * 测试里 import app，绑一个临时端口，不用真的占用 3002。
 */
export function createApp() {
  const app = express()

  app.use(express.json())

  // 健康检查：用来确认后端还活着，以及链路是否通。
  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = { ok: true, service: 'api' }
    res.json(body)
  })

  // 404：路由没匹配到任何路径。
  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: `没有这个接口：${req.method} ${req.path}` },
    })
  })

  // 错误处理必须放在最后。Express 靠四个参数识别错误中间件，
  // 少一个参数就当普通中间件处理了，错误会直接掉进默认处理器。
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, body } = toApiError(err)
    res.status(status).json(body)
  })

  return app
}
