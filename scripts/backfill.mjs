/**
 * 分批回填：把 products.title 补上老数据里的 name。
 *
 * ch06 的 backfill 阶段。三个性质缺一不可：
 *
 *   幂等      —— WHERE 条件只看「还没补过的行」，跑两遍和跑一遍结果一样
 *   可中断    —— 一批一个事务，中途挂了只丢当前这一批，补过的不会回退
 *   进度可见  —— 每批报「还剩多少行」，不然你不知道它是在跑还是卡住了
 *
 * 用法：
 *   node scripts/backfill.mjs                 # 一批一批跑到补完
 *   node scripts/backfill.mjs --batch=20      # 每批 20 行
 *   node scripts/backfill.mjs --status        # 只看还剩多少，不改数据
 *
 * 刻意不提供「一次性 UPDATE 全表」这个选项。真实项目里那一行 SQL
 * 会锁表锁到语句结束，几百万行就是几分钟到几十分钟，期间所有写请求排队。
 * 这里的批大小是给教学用的，生产上按行宽和单行耗时调。
 *
 * ## 换库之后它还在，为什么
 *
 * PostgreSQL 那边是**一份基线**，建表时 title 就在，老数据一行都没有。
 * 所以这个脚本在换库之后跑起来会报「已经补完了」——那是正确的空操作，
 * 不是坏了。
 *
 * 留着它是因为两件事：
 * 1. ch06 那篇还在让读者跑它，删了文档就断了。
 * 2. **进度守卫这件事本身没有过期。** 它对任何批处理脚本都成立，
 *    而它是这个脚本唯一一条换库之后还完全成立的经验。
 *
 * 换库丢掉的是 SQLite 特有的那条：`db.exec()` 不接受绑定参数，
 * `?` 被当字面量，语句成功、0 行受影响、循环空转。
 * PostgreSQL 的 `client.query(text, values)` 总是接受参数，所以那条坑不存在了。
 * 换成另一条要小心的：**一批 ids 拼出来的 IN 列表要用真正的参数，
 * 不能拼进 SQL 字符串**。见下面 placeholdersFor 那个函数。
 */

import { Client } from 'pg'

const URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'

const args = process.argv.slice(2)
const batchArg = args.find((a) => a.startsWith('--batch='))
const BATCH = batchArg ? Number(batchArg.slice('--batch='.length)) : 100
const STATUS_ONLY = args.includes('--status')

if (!Number.isInteger(BATCH) || BATCH < 1) {
  console.error('--batch 必须是正整数')
  process.exit(1)
}

/**
 * 生成 n 个占位符：3 -> '$1,$2,$3'
 *
 * **不要把 id 拼进 SQL 字符串。** 那样做的话，
 * 一批数据的来源只要有一天不完全受控，它就是一条注入路径。
 * 这里 id 全都是刚查出来的整数，但「刚查出来的」不是安全保证。
 *
 * @param {number} n
 * @returns {string}
 */
function placeholdersFor(n) {
  return Array.from({ length: n }, (_, i) => `$${i + 1}`).join(',')
}

/**
 * @param {Client} client
 * @returns {Promise<number>}
 */
async function remaining(client) {
  const res = await client.query('SELECT COUNT(*)::int AS n FROM products WHERE title IS NULL')
  return res.rows[0].n
}

const client = new Client({ connectionString: URL })
try {
  await client.connect()
} catch (err) {
  console.error(`连不上数据库：${URL}`)
  console.error('先 docker compose up -d。')
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

// 回填之前先确认目标列在。不在的话说明基线没跑，
// 直接 UPDATE 会报 column does not exist，而那行报错不好看出是「顺序错了」。
const cols = await client.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name = 'products'",
)
const names = cols.rows.map((r) => r.column_name)
if (!names.includes('title')) {
  console.error('products 表里没有 title 列。先起一次后端让迁移跑完。')
  console.error(`实际列：${JSON.stringify(names)}`)
  await client.end()
  process.exit(1)
}

let total = await remaining(client)
console.log(`数据库：${URL}`)
console.log(`每批：${BATCH} 行`)
console.log(`待回填：${total} 行`)

if (STATUS_ONLY) {
  console.log(total === 0 ? '\n已经补完了。' : '\n还没补完，跑一次 node scripts/backfill.mjs')
  await client.end()
  process.exit(0)
}

let batch = 0
while (total > 0) {
  batch += 1

  // 一批一个事务。挂了只丢这一批，补过的行不受影响。
  await client.query('BEGIN')
  try {
    const picked = await client.query(
      'SELECT id FROM products WHERE title IS NULL ORDER BY id LIMIT $1',
      [BATCH],
    )
    const ids = picked.rows.map((r) => r.id)

    if (ids.length === 0) {
      await client.query('COMMIT')
      break
    }

    const result = await client.query(
      `UPDATE products SET title = name
        WHERE title IS NULL AND id IN (${placeholdersFor(ids.length)})`,
      ids,
    )

    await client.query('COMMIT')

    // **进度守卫：处理了行，但剩余数没降，就停下来报错。**
    // 批处理脚本最危险的失败不是报错，是「不报错也不推进」——
    // while 的条件一直成立，循环永远转下去，日志刷几千行也没人知道。
    // 所以每次批完都核对一次真的少了行，没少就当失败处理。
    const after = await remaining(client)
    if (after >= total) {
      console.error(
        `  第 ${batch} 批：语句报告改了 ${result.rowCount} 行，但待回填数仍是 ${total}，没有推进。`,
      )
      console.error('  停下来，不继续空转。')
      await client.end()
      process.exit(1)
    }

    total = after
    const done = await client.query('SELECT COUNT(*)::int AS n FROM products WHERE title IS NOT NULL')
    console.log(`  第 ${batch} 批：处理 ${ids.length} 行，累计已补 ${done.rows[0].n} 行，还剩 ${total} 行`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(`  第 ${batch} 批失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
    console.error('  补过的行还在，直接重跑就行，不用从头来。')
    await client.end()
    process.exit(1)
  }
}

const stillLeft = await remaining(client)
await client.end()

console.log(`\n回填完成，共 ${batch} 批。`)
console.log(`复检 title IS NULL 的行数：${stillLeft}`)
console.log(stillLeft === 0 ? '可以进 contract 阶段了。' : '还有没补完的，先别进 contract。')
