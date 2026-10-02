import { z } from 'zod'

export { z }

/**
 * 对外的错误响应体，全项目只有这一个形状：
 *   { "error": { "code": "VALIDATION_FAILED", "message": "...", "fields": {...} } }
 *
 * 有了它，前端只需要判断一个形状。ch11 会把「为什么不能只用 HTTP 状态码」
 * 讲透，这里先把形状定死，后面 9 章都不许改。
 */
export interface ApiError {
  error: {
    code: string
    message: string
    fields?: Record<string, string>
  }
}

/**
 * 健康检查的响应体。声明成 interface 而不是随手 json()，
 * 是为了让「返回给调用方的形状」在代码里有唯一出处。
 */
export interface HealthResponse {
  ok: boolean
  service: string
}
