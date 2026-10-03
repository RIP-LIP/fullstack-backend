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
  | 'unique' // 唯一键：sku / email 重复，**以及主键冲突**
  | 'check' // CHECK：值不在允许范围内
  | 'notnull' // NOT NULL：必填列写成了空
  | 'outofrange' // 22003：数字超出列的类型范围
  | 'other' // 是约束错误，但属于上面没列出的那一类里的其他码

/**
 * 判断一个异常是不是某一类数据库约束冲突。
 *
 * ## 换库前后判的东西完全变了
 *
 * `node:sqlite` 抛出的错误带 `code: 'ERR_SQLITE_ERROR'` 和一个数字 `errcode`。
 * 那个数字是 SQLite 的「扩展结果码」：低 8 位是主码，
 * 高位是具体是哪一条约束。所以先判主码是不是 19（SQLITE_CONSTRAINT），
 * 再看完整值是哪一种。
 *
 * `pg` 抛出的错误上 `code` **就是 SQLSTATE**，一个五字符的字符串。
 * 没有主码 / 扩展码那套位运算，查表就行。
 *
 * 换句话说：**这一段是「换库要动的东西」的第一份账单**，
 * 而且它不在 `db/` 目录里——它在接口层。
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

  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return null

  // **这一类不在 23 里面，但同样是「客户端传错了」。**
  // 22003 numeric_value_out_of_range：往 int4 列里写了一个超出范围的数。
  // 漏掉它的话，客户端传一个超大价格会拿到 500「服务端出错了」，
  // 而原因完全在它自己手上——这正是上面说的「误判成服务端故障」。
  // 所以在 23 那一整类之前先单独接住它。
  if (code === '22003') return 'outofrange'

  // SQLSTATE 的类（class）是前两位。23 是 integrity_constraint_violation，
  // 所有完整性约束失败都在这一类里，剩下的两位才区分是哪一条。
  if (!code.startsWith('23')) return null

  switch (code) {
    case '23503': // foreign_key_violation
      return 'foreignkey'
    case '23505': // unique_violation
      // **主键冲突也走这一条。** SQLite 能靠 1555 把主键单独分出来，
      // PostgreSQL 做不到——它只给 unique_violation。
      // 要区分就得看 `err.constraint`（约束名）。本项目不需要，所以不查。
      return 'unique'
    case '23514': // check_violation
      return 'check'
    case '23502': // not_null_violation
      return 'notnull'
    default:
      // 23506 integrity_constraint_violation、23512 duplicate_database 等
      return 'other'
  }
}
