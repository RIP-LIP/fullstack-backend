import type { OrderStatus } from '@fullstack/shared'

/**
 * 订单状态机。
 *
 * ## 为什么它是一个单独的文件
 *
 * 规则写在路由里，测试就只能靠发请求来碰。而状态机是纯逻辑——
 * 二十来条转移规则，一秒钟能跑几千遍。放在这里可以被直接断言，
 * 不用起服务、不用造订单、不用管事务。
 *
 * ## 为什么数据库的 CHECK 不够
 *
 * `001_init.ts` 里那条 `CHECK (status IN (...))` 只检查**这一列的值**，
 * 它不知道这一行之前是什么状态。所以下面这个在库里是合法的：
 *
 *   一个 cancelled 的订单，直接 UPDATE 成 paid —— 库会照收不误
 *
 * 实测输出见 guide/deep/ch07。值域和转移是两件事，
 * 值域能交给数据库，转移只能交给代码。
 */

/**
 * 转移表。键是当前状态，值是允许到达的状态。
 *
 * 这张表是唯一的真相源。加一条边是改这里，
 * 改完之后接口会立刻按新规则拒绝旧转移——不需要改别的地方。
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // 下单后可以付款，也可以直接取消
  pending: ['paid', 'cancelled'],
  // 付款后可以发货。付款之后还允许取消（退款场景）
  paid: ['shipped', 'cancelled'],
  // 发货之后不能取消，只能确认收货
  shipped: ['completed'],
  // 终态
  completed: [],
  // 终态。取消之后不能再回到 paid
  cancelled: [],
}

/**
 * 这次转移合不合法。
 *
 * 单独抽一个函数是为了让调用处能写清楚「为什么」：
 * 非法时要报错，而报什么错、说哪句话，应该由这里决定，
 * 不该散在路由的 if 里。
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** 从当前状态能到达哪些状态。错误提示里要列出来。 */
export function allowedFrom(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[from]
}

/** 终态没有出边，单独给一个判断，路由里判断「能不能改」时更好读。 */
export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/** 全部状态，写给文档和测试用。 */
export const ALL_STATUSES = Object.keys(TRANSITIONS) as OrderStatus[]
