import { z } from 'zod'

export { z }

/**
 * 对外的错误响应体，全项目只有这一个形状：
 *   { "error": { "code": "VALIDATION_FAILED", "message": "...", "fields": {...} } }
 *
 * 有了它，前端只需要判断一个形状，不用为每种错误写一套解析。
 * 形状定死之后就不再改：改动会让所有调用方的错误处理同时失效。
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
 *
 * **title 和 name 都在收。** ch06 那一章在把 name 换成 title，
 * expand 阶段新旧两个键都得接受，contract 阶段才把 name 拿掉。
 * 现在是 expand，所以两个都在。
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
  title: z
    .string()
    .trim()
    .min(1, '标题不能为空')
    .max(200, '标题最多 200 个字符')
    .optional(),
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

/**
 * 对外返回的商品。字段名是驼峰，和数据库的 snake_case 不是一回事。
 *
 * **name 和 title 都在返回。** 正在把 name 换成 title，
 * expand 阶段两个键都得在，contract 阶段才拿掉 name。
 * 现在少返回一个，老版本调用方就少一个字段。
 */
export const Product = z.object({
  id: z.number().int(),
  sku: z.string(),
  name: z.string(),
  title: z.string(),
  priceCents: z.number().int(),
  stock: z.number().int(),
  createdAt: z.string(),
})

export type Product = z.infer<typeof Product>

/* ------------------------------------------------------------------ *
 * 订单
 * ------------------------------------------------------------------ */

/**
 * 订单状态。
 *
 * **这是状态机，不是枚举。** 五个值之间的合法转移只有五个方向的边，
 * 任意两个值之间都**不是**可以互转的——`cancelled` 之后不能再 `paid`。
 *
 * 值域由数据库的 CHECK 约束守着（001 迁移里那条 `status IN (...)`），
 * 但**转移规则数据库不管**：CHECK 只能检查这一列的值，
 * 不知道这一行之前是什么状态。所以转移必须由代码判断。
 * 完整的说明见 guide/deep/ch07。
 */
export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

/**
 * 建订单的入参。
 *
 * `items` 至少一项、最多 50 项。**上限是必要的**：不设上限的话，
 * 一个请求可以带一万项，事务体会跑很久，而事务期间整条数据库连接被别人排队等着
 * （见 db/index.ts 里 transaction 的注释）。
 *
 * 同一个 productId 出现两次是允许的，要不要合并是业务决定，
 * 这里不替调用方做——数据库的 order_items 每行一件，合并了数量对得上就行。
 */
export const CreateOrderInput = z.object({
  userId: z
    .number({ required_error: 'userId 不能为空', invalid_type_error: 'userId 必须是数字' })
    .int('userId 必须是整数')
    .min(1, 'userId 必须是正整数'),
  items: z
    .array(
      z.object({
        productId: z
          .number({ required_error: 'productId 不能为空', invalid_type_error: 'productId 必须是数字' })
          .int('productId 必须是整数')
          .min(1, 'productId 必须是正整数'),
        quantity: z
          .number({ required_error: '数量不能为空', invalid_type_error: '数量必须是数字' })
          .int('数量必须是整数')
          .min(1, '数量至少是 1')
          .max(999, '单个商品一次最多 999 件'),
      }),
    )
    .min(1, '订单至少要有一项')
    .max(50, '一个订单最多 50 项'),
})
export type CreateOrderInput = z.infer<typeof CreateOrderInput>

/** 状态转移的入参。 */
export const TransitionInput = z.object({
  to: z.enum(ORDER_STATUSES, {
    required_error: 'to 不能为空',
    invalid_type_error: `to 必须是 ${ORDER_STATUSES.join(' / ')} 之一`,
  }),
})
export type TransitionInput = z.infer<typeof TransitionInput>

/**
 * 订单明细。
 *
 * `unitPriceCents` 是**下单那一刻的价格快照**，不是商品现在的价格。
 * 商品改价之后，接口返回的这一项不会变——历史订单的金额必须是当时那个。
 * 反过来说，如果这里改成 join `products` 查现价，
 * 改一次价就会改掉所有历史订单的金额，而没有任何报错。
 */
export const OrderItem = z.object({
  productId: z.number().int(),
  quantity: z.number().int(),
  unitPriceCents: z.number().int(),
  /** 快照里的商品名。同样是下单那一刻的。 */
  productTitle: z.string(),
})
export type OrderItem = z.infer<typeof OrderItem>

/** 对外返回的订单。 */
export const Order = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  status: z.enum(ORDER_STATUSES),
  totalCents: z.number().int(),
  createdAt: z.string(),
  items: z.array(OrderItem),
})
export type Order = z.infer<typeof Order>
