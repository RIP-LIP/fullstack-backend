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

/**
 * 数据库约束的种类。
 *
 * 「约束冲突」不是一种错误，是一族。翻成接口语义码时必须区分：
 * 外键冲突说的是「这个商品还被别人引用」，唯一键冲突说的是
 * 「这个 SKU 已经有人占了」，给客户端的提示和该怎么处理完全不同。
 * 一律当成 500 的话，客户端只会得到一句「服务端出错了」，
 * 而真正的原因全在服务端日志里——排查成本全压在一个人身上。
 */
export type ConstraintKind =
  | 'foreignkey' // 外键：引用了不存在的行，或删了还被引用的行
  | 'unique' // 唯一键：sku / email 重复
  | 'check' // CHECK：值不在允许范围内
  | 'notnull' // NOT NULL：必填列写成了空
  | 'primarykey' // 主键冲突
  | 'other' // 是约束错误，但属于上面没列出的扩展码

/**
 * 判断一个异常是不是某一类数据库约束冲突。
 *
 * node:sqlite 抛出的错误带 code: 'ERR_SQLITE_ERROR' 和一个 errcode。
 * errcode 是 SQLite 的「扩展结果码」：低 8 位是主码，
 * 高位是具体是哪一条约束。所以先判主码是不是 19（SQLITE_CONSTRAINT），
 * 再看完整值是哪一种。
 *
 * 判错的后果分两向：
 *   - 漏判：约束冲突掉进 500 兜底，客户端以为服务端挂了
 *   - 误判：普通 SQL 错误被当成 400，客户端以为自己写错了请求，
 *            于是换个参数重试同一个错误，掩盖了真实故障
 */
export function isConstraint(err: unknown, kind: ConstraintKind): boolean {
  return constraintKind(err) === kind
}

/** 取出约束种类，不是约束错误就返回 null。 */
export function constraintKind(err: unknown): ConstraintKind | null {
  if (typeof err !== 'object' || err === null) return null

  const e = err as { code?: unknown; errcode?: unknown }
  if (e.code !== 'ERR_SQLITE_ERROR') return null
  if (typeof e.errcode !== 'number') return null

  // 主码 19 = SQLITE_CONSTRAINT。高位才是具体种类。
  if ((e.errcode & 0xff) !== 19) return null

  switch (e.errcode) {
    case 787: // SQLITE_CONSTRAINT_FOREIGNKEY
      return 'foreignkey'
    case 2067: // SQLITE_CONSTRAINT_UNIQUE
      return 'unique'
    case 275: // SQLITE_CONSTRAINT_CHECK
      return 'check'
    case 1299: // SQLITE_CONSTRAINT_NOTNULL
      return 'notnull'
    case 1555: // SQLITE_CONSTRAINT_PRIMARYKEY
      return 'primarykey'
    default:
      return 'other'
  }
}
