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

/**
 * 新建商品的入参。
 *
 * 价格叫 priceCents 而不是 price：名字里带上单位，是为了让「这里能不能用小数」
 * 这个问题在读代码时就有答案。数据库存整数分，接口也收整数分，
 * 中间没有任何一处出现过浮点数，所以不存在「四舍五入在哪一步做」的问题。
 *
 * 每个字段的两种消息都要写：required_error 管「这个键根本没给」，
 * min/max 管「给了但不合法」。只写后者的话，缺字段的请求会返回
 * zod 默认的英文 'Required'，和其他字段的中文提示混在一个响应里。
 *
 * 校验和数据库约束是两层，不是重复：
 *   - zod 拦住的是「请求不合规」，能指出是哪个字段、为什么
 *   - CHECK 约束拦住的是「不管从哪个口子写进来的数据都必须合法」
 * 绕过接口直接改库时，只有后者还在。所以两道都要。
 */
export const CreateProductInput = z.object({
  sku: z
    .string({ required_error: 'SKU 不能为空' })
    .trim()
    .min(1, 'SKU 不能为空')
    .max(64, 'SKU 最多 64 个字符'),
  name: z
    .string({ required_error: '名称不能为空' })
    .trim()
    .min(1, '名称不能为空')
    .max(200, '名称最多 200 个字符'),
  priceCents: z
    .number({ required_error: '价格不能为空', invalid_type_error: '价格必须是数字' })
    .int('价格必须是以分计的整数，不能是小数')
    .min(0, '价格不能是负数'),
  stock: z
    .number({ required_error: '库存不能为空', invalid_type_error: '库存必须是数字' })
    .int('库存必须是非负整数')
    .min(0, '库存不能是负数'),
})

export type CreateProductInput = z.infer<typeof CreateProductInput>

/** 对外返回的商品。字段名是驼峰，和数据库的 snake_case 不是一回事。 */
export const Product = z.object({
  id: z.number().int(),
  sku: z.string(),
  name: z.string(),
  priceCents: z.number().int(),
  stock: z.number().int(),
  createdAt: z.string(),
})

export type Product = z.infer<typeof Product>
