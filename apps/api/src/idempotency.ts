import { createHash } from 'node:crypto'
import type { Db } from './db/index.ts'
import { isConstraint } from './errors.ts'

/**
 * 幂等：一个请求来了两次，只做一次。
 *
 * ## 它和并发是两件事
 *
 * 上一篇挡的是「两个**不同**的请求同时改一行」——锁和隔离级别管这个。
 * 这一章挡的是「同一个请求被送进来两次」——两个请求的内容完全一样，
 * 数据库看不出它们是一个意图还是两个意图。
 *
 * 机制也不一样：并发靠**锁**，重复靠**唯一约束**。
 * 唯一约束是原子的，锁不是——所以裁判必须是它。
 *
 * ## 为什么不是「先查再插」
 *
 * 先 SELECT 看这个键在不在，不在就 INSERT——两个并发请求会同时查到「不在」，
 * 然后同时 INSERT，第二个撞唯一键。窗口就在那两条语句之间。
 *
 * **先插，让唯一约束去撞。** 撞到了就是「有人比我先」，这是原子的判断，
 * 没有窗口。
 *
 * ## 一个必须处理的后果
 *
 * 键先插进去了，然后干活。**干活失败时这个键不能留着**——
 * 否则它会永远停在「进行中」，而客户端重试永远拿不到结果。
 * 所以失败路径上要把键删掉，让下一次重试能重新开始。
 *
 * 这就是这一章最容易漏的一处：幂等不只是「重复时不重复做」，
 * 还得管住「失败时不留下半截状态」——和事务那一章同一个道理。
 */

/** 幂等键放在这个请求头里。 */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key'

/**
 * 请求内容的指纹。
 *
 * 同一个键配**不同内容**要报错，而不是返回上一次的结果——
 * 那说明客户端把两个不同的意图用同一个键发过来了，
 * 而幂等的定义是「同一个意图重发多次」，不是「不管发什么都返回上次那个」。
 *
 * 为什么要先规范化再算：JSON 的键顺序不影响语义，
 * 但直接对原始字符串算哈希的话，键顺序一变哈希就变，
 * 同一份内容会被判成不同。所以按键名排序再拼。
 *
 * @param payload 请求体
 * @returns 十六进制的 sha256
 */
export function requestHash(payload: unknown): string {
  return createHash('sha256').update(canonicalize(payload)).digest('hex')
}

/**
 * 把一个 JSON 值变成「键有序」的字符串。
 *
 * 只处理 JSON 能有的类型：对象、数组、字符串、数字、布尔、null。
 * 数组**不排序**——`[1, 2]` 和 `[2, 1]` 语义不同，排序会把它变成同一个。
 *
 * @param value
 * @returns 规范化后的字符串
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts: string[] = []
  for (const k of keys) {
    if (obj[k] === undefined) continue // undefined 不会出现在 JSON 里
    parts.push(`${JSON.stringify(k)}:${canonicalize(obj[k])}`)
  }
  return `{${parts.join(',')}}`
}

/** 幂等键表里的一行。 */
type KeyRow = {
  key: string
  request_hash: string
  order_id: number | null
}

export type IdempotencyVerdict =
  /** 抢到了，这个请求是第一次，正要干活。 */
  | { kind: 'claimed' }
  /** 同一个键、同一份内容、已经干完了：重放之前那笔。 */
  | { kind: 'replay'; orderId: number }
  /** 同一个键、不同的内容。 */
  | { kind: 'mismatch' }
  /** 同一个键、同一份内容，但第一个请求还在跑。 */
  | { kind: 'in_progress' }

/**
 * 试着占住这个键。
 *
 * 成功返回 `claimed`，失败（唯一约束撞了）就去看那一行现在是什么状态。
 * 三种失败各有各的处理方式，所以要把它们分开返回而不是只说「失败了」。
 *
 * @param db 数据层
 * @param key 幂等键
 * @param hash 请求内容的指纹
 * @returns 这一趟该怎么走
 */
export async function claim(
  db: Db,
  key: string,
  hash: string,
): Promise<IdempotencyVerdict> {
  try {
    // 这一条**不在事务里**：它必须立刻提交，
    // 这样并发的第二个请求马上就能看到这一行（order_id 还是空的），
    // 从而知道「有人在处理」而不是傻等。
    await db.query(
      'INSERT INTO idempotency_keys (key, request_hash, order_id, created_at) VALUES (?, ?, NULL, ?)',
      [key, hash, new Date().toISOString()],
    )
    return { kind: 'claimed' }
  } catch (err) {
    // 撞唯一键是**预期内**的，不是故障。所以在这里消化掉，不往上抛。
    if (!isConstraint(err, 'unique')) throw err

    const row = await db.one<KeyRow>('SELECT key, request_hash, order_id FROM idempotency_keys WHERE key = ?', [
      key,
    ])

    // 理论上不该为空：刚撞的键就是这一行。真为空说明它在我们两条语句之间
    // 被删了（有人清了过期键）。当成「没抢到」是最安全的处理。
    if (row === undefined) return { kind: 'in_progress' }

    if (row.request_hash !== hash) return { kind: 'mismatch' }
    if (row.order_id !== null) return { kind: 'replay', orderId: row.order_id }
    return { kind: 'in_progress' }
  }
}

/**
 * 活干完了，把订单号回填进那一行。
 *
 * **回填和建订单必须在同一个事务里。** 分开写的话，
 * 中间那一小段时间里订单已经存在、键却还是空的，
 * 并发的重放会拿到「进行中」而不是「已完成」——
 * 明明已经做完了，客户端却被告知再等等。
 *
 * @param tx 建订单用的那个事务
 * @param key
 * @param orderId
 */
export async function complete(tx: Db, key: string, orderId: number): Promise<void> {
  await tx.query('UPDATE idempotency_keys SET order_id = ? WHERE key = ?', [orderId, key])
}

/**
 * 活干失败了，把键还回去。
 *
 * 不还的话这个键会永远停在「进行中」，而客户端的重试永远拿不到结果——
 * 一次失败把这次意图彻底废了。
 *
 * 已经在事务里回滚的失败不会走到这里（那条路是抛出去的）。
 * 走到这里的都是「订单没建成、但键插进去了」。
 *
 * @param db
 * @param key
 */
export async function release(db: Db, key: string): Promise<void> {
  // 失败不抛：还键是善后，不是主流程。抛出去会盖掉真正的错误。
  await db.query('DELETE FROM idempotency_keys WHERE key = ? AND order_id IS NULL', [key]).catch(() => {})
}

/**
 * 回收「卡在进行中」的孤儿键。
 *
 * ## 为什么需要它
 *
 * `release` 只在 catch 里跑。进程如果在这两步之间被 SIGKILL 或 OOM 杀掉——
 * `claim` 的 INSERT 已经提交了，订单事务还没提交——`release` 永远等不到。
 * 那一行就停在 `order_id IS NULL`，之后每次同键重试都返回
 * `IDEMPOTENT_REQUEST_IN_PROGRESS`，**这次意图永久报废**。
 *
 * 这不是理论问题：部署、回滚、机器重启都会走到它。
 *
 * ## 回收条件为什么是这两个
 *
 * - `order_id IS NULL`：已完成的那一行**绝不能删**。删了的话下一次重放
 *   会重新执行一遍，订单建两笔、库存扣两次——正好是这一整章在防的事。
 * - 超过 TTL：刚 claim 成功的键也是 NULL，删了就等于没有幂等。
 *   TTL 必须比「一次请求的最长处理时间」长得多。
 *
 * ## 和索引的关系
 *
 * `002_idempotency_keys.ts` 建了 `idx_idempotency_keys_created_at`，
 * 注释写着「过期清理要用这个」。在这个函数出现之前，**那是一个死索引**——
 * 建它的理由还不存在。
 *
 * ## 谁来调
 *
 * 本项目**没有定时任务**，也不打算为了这一件事引入一个。
 * 所以它是一个导出函数，由外部决定调用时机——生产环境挂个 cron，
 * 测试里直接调。放在这里是因为「哪些行可以安全删」这个判断
 * 和 claim / complete / release 是同一套语义，不该散在两个地方。
 *
 * @param db
 * @param ttlMs 判定为「卡住」的时间。默认 10 分钟。
 * @returns 删掉了几行
 */
export async function reclaimStale(
  db: Db,
  ttlMs: number = 10 * 60 * 1000,
): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs).toISOString()
  const deleted = await db.query<{ key: string }>(
    'DELETE FROM idempotency_keys WHERE order_id IS NULL AND created_at < ? RETURNING key',
    [cutoff],
  )
  return deleted.length
}
