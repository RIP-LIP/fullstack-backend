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
 *   node scripts/backfill.mjs --batch=5       # 每批 5 行，中途 Ctrl+C 也不会坏
 *   node scripts/backfill.mjs --status        # 只看还剩多少，不改数据
 *
 * 刻意不提供「一次性 UPDATE 全表」这个选项。真实项目里那一行 SQL
 * 会锁表锁到语句结束，几百万行就是几分钟到几十分钟，期间所有写请求排队。
 * 这里的批大小是给教学用的，生产上按行宽和单行耗时调。
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : join(repoRoot, 'apps', 'api', 'data', 'app.db')

const args = process.argv.slice(2)
const batchArg = args.find((a) => a.startsWith('--batch='))
const BATCH = batchArg ? Number(batchArg.slice('--batch='.length)) : 100
const STATUS_ONLY = args.includes('--status')

if (!Number.isInteger(BATCH) || BATCH < 1) {
  console.error('--batch 必须是正整数')
  process.exit(1)
}

if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}\n先起一次后端，让迁移把表建出来。`)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: STATUS_ONLY })

// 回填之前先确认目标列在。不在的话说明 003 迁移没跑，
// 直接 UPDATE 会报 no such column，而那行报错不好看出是「顺序错了」。
if (!STATUS_ONLY) {
  const cols = db.prepare('PRAGMA table_info(products)').all().map((r) => r.name)
  if (!cols.includes('title')) {
    console.error('products 表里没有 title 列。003 迁移没跑？先起一次后端。')
    console.error(`实际列：${JSON.stringify(cols)}`)
    db.close()
    process.exit(1)
  }
}

const remaining = () => Number(db.prepare('SELECT COUNT(*) AS n FROM products WHERE title IS NULL').get()?.n ?? 0)

let total = remaining()
console.log(`数据库：${dbPath}`)
console.log(`每批：${BATCH} 行`)
console.log(`待回填：${total} 行`)

if (STATUS_ONLY) {
  console.log(total === 0 ? '\n已经补完了。' : '\n还没补完，跑一次 node scripts/backfill.mjs')
  db.close()
  process.exit(0)
}

let batch = 0
while (total > 0) {
  batch++

  // 一批一个事务。挂了只丢这一批，补过的行不受影响。
  db.exec('BEGIN')
  try {
    const ids = db
      .prepare('SELECT id FROM products WHERE title IS NULL ORDER BY id LIMIT ?')
      .all(BATCH)
      .map((r) => r.id)

    if (ids.length === 0) {
      db.exec('COMMIT')
      break
    }

    // **必须用 prepare().run(...ids)，不能用 db.exec()。**
    // exec() 不接受绑定参数，`?` 会被当成字面量：语句能跑通，
    // 但 `id IN (NULL, NULL, NULL)` 匹配不到任何行，0 行受影响。
    // 症状是「每批都处理 10 行，还剩 23 行」——不动，还一直转。
    const placeholders = ids.map(() => '?').join(',')
    const result = db
      .prepare(`UPDATE products SET title = name WHERE title IS NULL AND id IN (${placeholders})`)
      .run(...ids.map((id) => Number(id)))

    db.exec('COMMIT')

    // **进度守卫：处理了行，但剩余数没降，就停下来报错。**
    // 批处理脚本最危险的失败不是报错，是「不报错也不推进」——
    // while 的条件一直成立，循环永远转下去，日志刷几千行也没人知道。
    // 所以每次批完都核对一次真的少了行，没少就当失败处理。
    const after = remaining()
    if (after >= total) {
      console.error(`  第 ${batch} 批：语句报告改了 ${result.changes} 行，但待回填数仍是 ${total}，没有推进。`)
      console.error('  停下来，不继续空转。')
      db.close()
      process.exit(1)
    }

    total = after
    const done = db.prepare('SELECT COUNT(*) AS n FROM products WHERE title IS NOT NULL').get()?.n ?? 0
    console.log(`  第 ${batch} 批：处理 ${ids.length} 行，累计已补 ${Number(done)} 行，还剩 ${total} 行`)
  } catch (err) {
    db.exec('ROLLBACK')
    console.error(`  第 ${batch} 批失败，已回滚：${err instanceof Error ? err.message : String(err)}`)
    console.error('  补过的行还在，直接重跑就行，不用从头来。')
    db.close()
    process.exit(1)
  }
}

const stillLeft = remaining()
db.close()

console.log(`\n回填完成，共 ${batch} 批。`)
console.log(`复检 title IS NULL 的行数：${stillLeft}`)
console.log(stillLeft === 0 ? '可以进 contract 阶段了。' : '还有没补完的，先别进 contract。')
