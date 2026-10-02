import type { ApiError } from '@fullstack/shared'

/**
 * 所有对外的错误响应都在这一个形状里：
 *   { "error": { "code": "VALIDATION_FAILED", "message": "...", "fields": {...} } }
 *
 * 有了它，前端只需要判断一个形状，不用为每种错误写一套解析。
 * 业务代码要报错就 throw new HttpError(...)，由 toApiError 统一转换。
 */

export class HttpError extends Error {
  status: number
  code: string
  fields?: Record<string, string>

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message)
    this.status = status
    this.code = code
    this.fields = fields
  }
}

/** 把任何异常转成统一形状的响应体 */
export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } },
    }
  }

  // body-parser 在请求体不是合法 JSON 时抛的错。这是客户端把 JSON 写坏了，
  // 不是服务端出故障，所以是 400 不是 500。漏掉这一条的后果很具体：
  // 客户端会拿到 500，误以为是服务端挂了，真正的原因在自己手上。
  if (isBadJson(err)) {
    return {
      status: 400,
      body: { error: { code: 'INVALID_JSON', message: '请求体不是合法的 JSON' } },
    }
  }

  // 没被显式处理的东西一律当 500，并且不把内部细节丢给客户端。
  console.error('[api] 未处理的异常:', err)
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: '服务端出错了，请看服务端日志' } },
  }
}

/** body-parser 的解析错误带 type: 'entity.parse.failed'，靠这个特征识别 */
function isBadJson(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed'
}
