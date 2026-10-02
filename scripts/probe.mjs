/**
 * 事务那一章的四个实验，外加一条只读查库命令。
 *
 * 每一个实验都在内存库里跑，**碰不到你的开发数据**；
 * `state` 那条只读开发库。
 *
 * ## 为什么这份脚本自己建表，不去 import 应用里的迁移
 *
 * `scripts/` 下的 .mjs 是 `node` 直接跑的，而迁移文件是 .ts，
 * 让一个 .mjs import 一个 .ts 会同时踩到两个坑：运行时要额外挂 loader，
 * 类型检查那边 scripts 项目的 allowImportingTsExtensions 是关着的。
 *
 * 所以这里的 DDL 是 `apps/api/src/db/migrations/001_init.ts` 的精简副本，
 * 只留本章要用的四张表和它们的列。**真实表结构以那个文件为准**，
 * 两边不一致的时候以迁移文件为准。
 *
 * 之所以不写成 `node -e` 一行命令：一行里既要写 SQL 的单引号又要写 JS 的引号，
 * PowerShell 和 bash 的转义规则还不一样，贴出来八成复制不跑。脚本能直接复制。
 *
 * 用法：
 *   node scripts/probe.mjs            全部跑一遍
 *   node scripts/probe.mjs notx       只跑「不用事务的半套数据」
 *   node scripts/probe.mjs rollback   空 ROLLBACK / COMMIT 之后的 ROLLBACK
 *   node scripts/probe.mjs nested     嵌套 BEGIN
 *   node scripts/probe.mjs check      CHECK 只管值域，不管转移
 *   node scripts/probe.mjs state      只读地打出四张表现在长什么样
 */

import { DatabaseSync } from 'node:sqlite'
import * as nodeFs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/* ------------------------------------------------------------------ *
 * 取值
 *
 * node:sqlite 的 get() 返回「可能根本不存在的行」。
 * 到处写 ?. 会把真正的空值问题藏起来，所以统一走下面两个函数：
 * 取不到就抛，抛出来你立刻知道是哪一步查空了。
 * ------------------------------------------------------------------ */

/**
 * @param {Record<string, unknown> | undefined} row
 * @param {string} key
 * @returns {number}
 */
function num(row, key) {
  if (row === undefined) throw new Error(`没有查到这一行（要读 ${key}）`)
  const v = row[key]
  if (typeof v !== 'number') throw new Error(`${key} 不是数字：${String(v)}`)
  return v
}

/**
 * @param {Record<string, unknown> | undefined} row
 * @param {string} key
 * @returns {string}
 */
function text(row, key) {
  if (row === undefined) throw new Error(`没有查到这一行（要读 ${key}）`)
  const v = row[key]
  if (v === undefined) throw new Error(`这一行没有 ${key} 这个字段`)
  return String(v)
}

/**
 * catch 里的 e 是 unknown，要读它的 message 得先收窄。
 *
 * @param {unknown} e
 * @returns {string}
 */
function messageOf(e) {
  return e instanceof Error ? e.message : String(e)
}

/* ------------------------------------------------------------------ *
 * 建表：001_init.ts 的精简副本
 * ------------------------------------------------------------------ */

/**
 * @param {DatabaseSync} d
 * @returns {void}
 */
function createSchema(d) {
  d.exec(`
    CREATE TABLE users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT    NOT NULL UNIQUE,
      created_at TEXT    NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sku         TEXT    NOT NULL UNIQUE,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      stock       INTEGER NOT NULL CHECK (stock >= 0),
      created_at  TEXT    NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      status      TEXT    NOT NULL CHECK (status IN ('pending', 'paid', 'shipped', 'completed', 'cancelled')),
      total_cents INTEGER NOT NULL,
      created_at  TEXT    NOT NULL
    )
  `)
  d.exec(`
    CREATE TABLE order_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id),
      product_id       INTEGER NOT NULL REFERENCES products(id),
      quantity         INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL
    )
  `)
}

const NOW = '2026-10-02T00:00:00.000Z'

/**
 * @param {DatabaseSync} d
 * @returns {number}
 */
function seedUser(d) {
  d.prepare('INSERT INTO users (email, created_at) VALUES (?, ?)').run('probe@example.test', NOW)
  return num(d.prepare('SELECT id FROM users WHERE email = ?').get('probe@example.test'), 'id')
}

/**
 * @param {DatabaseSync} d
 * @param {string} sku
 * @param {number} stock
 * @returns {number}
 */
function seedProduct(d, sku, stock) {
  d.prepare('INSERT INTO products (sku, price_cents, stock, created_at) VALUES (?,?,?,?)').run(sku, 100, stock, NOW)
  return num(d.prepare('SELECT id FROM products WHERE sku = ?').get(sku), 'id')
}

/* ------------------------------------------------------------------ *
 * notx：不用事务，三张表对不上
 * ------------------------------------------------------------------ */

/** @returns {void} */
function notx() {
  const d = new DatabaseSync(':memory:')
  createSchema(d)

  const userId = seedUser(d)
  const a = seedProduct(d, 'PROBE-A', 10)
  const b = seedProduct(d, 'PROBE-B', 1)

  // lastInsertRowid 的类型是 number | bigint，Number() 收一下
  const orderId = Number(
    d
      .prepare("INSERT INTO orders (user_id, status, total_cents, created_at) VALUES (?, 'pending', 0, ?)")
      .run(userId, NOW).lastInsertRowid,
  )
  console.log(`第 1 步：orders 建好了，id = ${orderId}`)

  // 一件一件处理，**这里没有事务**。
  // 顺序是「先扣库存，扣成功才写明细」——所以乙扣不动的时候，
  // 它那一行明细根本不会被写进去，订单就此缺一行。
  const items = [
    { productId: a, quantity: 3, label: '甲' },
    { productId: b, quantity: 99, label: '乙' },
  ]

  let step = 1
  for (const item of items) {
    const r = d
      .prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?')
      .run(item.quantity, item.productId, item.quantity)
    step += 1
    if (r.changes === 0) {
      console.log(`第 ${step} 步：${item.label}库存不足，changes = 0  <- 这一步失败了`)
      break
    }
    console.log(`第 ${step} 步：${item.label}的库存扣了 ${item.quantity}，changes = ${r.changes}`)

    d.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) VALUES (?,?,?,?)')
      .run(orderId, item.productId, item.quantity, 100)
    step += 1
    const lines = num(
      d.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(orderId),
      'n',
    )
    console.log(`第 ${step} 步：order_items 写了 ${lines} 行`)
  }

  console.log('')
  console.log('=== 现在库里是什么状态（只读）===')
  const order = d.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId)
  console.log(`订单 ${orderId} 存在: ${order !== undefined}`)
  const lines = num(d.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?').get(orderId), 'n')
  console.log(`它的明细行数: ${lines} （这一单要 ${items.length} 行）`)
  const stockA = num(d.prepare('SELECT stock FROM products WHERE id = ?').get(a), 'stock')
  console.log(`甲的库存: ${stockA} （下单前 10，这一单要买 3 件）`)
  console.log(`甲的库存和订单对得上吗: ${stockA === 7 ? '对得上' : '对不上'}`)

  d.close()
}

/* ------------------------------------------------------------------ *
 * rollback：回滚失败会顶替原始错误
 * ------------------------------------------------------------------ */

/** @returns {void} */
function rollback() {
  const d = new DatabaseSync(':memory:')

  d.exec('BEGIN')
  d.exec('ROLLBACK')
  try {
    d.exec('ROLLBACK')
    console.log('空 ROLLBACK: 没报错')
  } catch (e) {
    console.log('空 ROLLBACK ->', messageOf(e))
  }

  d.exec('BEGIN')
  d.exec('COMMIT')
  try {
    d.exec('ROLLBACK')
    console.log('COMMIT 后 ROLLBACK: 没报错')
  } catch (e) {
    console.log('COMMIT 后 ROLLBACK ->', messageOf(e))
  }

  d.close()
}

/* ------------------------------------------------------------------ *
 * nested：嵌套事务的报错来自 SQLite，不是代码
 * ------------------------------------------------------------------ */

/** @returns {void} */
function nested() {
  const d = new DatabaseSync(':memory:')
  d.exec('BEGIN')
  try {
    d.exec('BEGIN')
    console.log('嵌套 BEGIN: 没报错')
  } catch (e) {
    console.log('嵌套 BEGIN ->', messageOf(e))
  }
  d.close()
}

/* ------------------------------------------------------------------ *
 * check：CHECK 管得住值，管不住转移
 * ------------------------------------------------------------------ */

/** @returns {void} */
function check() {
  const d = new DatabaseSync(':memory:')
  createSchema(d)

  const userId = seedUser(d)
  for (const status of ['completed', 'pending', 'cancelled']) {
    d.prepare('INSERT INTO orders (user_id, status, total_cents, created_at) VALUES (?,?,0,?)').run(userId, status, NOW)
  }

  console.log('=== CHECK 只管值域，不管转移 ===')
  const cancelledId = num(d.prepare("SELECT id FROM orders WHERE status = 'cancelled'").get(), 'id')
  console.log(`造了一个 cancelled 的订单，id = ${cancelledId}`)
  const all = d
    .prepare('SELECT status FROM orders ORDER BY status')
    .all()
    .map((r) => ({ status: text(r, 'status') }))
  console.log(`库里所有合法值: ${JSON.stringify(all)}`)

  const moved = d.prepare('UPDATE orders SET status = ? WHERE id = ?').run('paid', cancelledId)
  console.log(`UPDATE 把它从 cancelled 改成 paid：changes = ${moved.changes}   <- 库接受了`)
  const after = text(d.prepare('SELECT status FROM orders WHERE id = ?').get(cancelledId), 'status')
  console.log(`现在它是什么状态: ${after}`)

  try {
    d.prepare('UPDATE orders SET status = ? WHERE id = ?').run('refunded', cancelledId)
    console.log('改成 refunded: 没报错')
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : '未知'
    console.log(`改成 refunded -> ${code} | CHECK 拦住了值域之外的`)
  }

  d.close()
}

/* ------------------------------------------------------------------ *
 * state：只读地把四张表现在长什么样打出来
 * ------------------------------------------------------------------ */

/**
 * 「查库确认」这一步不能靠猜。
 *
 * 本机不一定装了 sqlite3 命令行，所以这里给一条能直接复制的：
 * 它只读开发库（默认 apps/api/data/app.db），不写任何东西。
 * 想看别的库就带 DB_PATH。
 *
 * @returns {void}
 */
function state() {
  const file = process.env.DB_PATH ?? join(here, '..', 'apps', 'api', 'data', 'app.db')
  if (!nodeFs.existsSync(file)) {
    console.log(`还没有这个库：${file}`)
    console.log('先 npm run dev:api 跑一次，它会自动建库并跑迁移。')
    return
  }

  const d = new DatabaseSync(file, { readOnly: true })
  const tables = ['users', 'products', 'orders', 'order_items']

  /**
   * @param {string} t
   * @returns {number}
   */
  const count = (t) => num(d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get(), 'n')

  console.log(`库：${file}`)
  console.log(`表：${tables.map((t) => `${t} ${count(t)} 行`).join('，')}`)
  console.log('')
  console.log('--- products ---')
  for (const p of d.prepare('SELECT id, sku, title, price_cents, stock FROM products ORDER BY id').all()) {
    console.log(`  #${text(p, 'id')} ${text(p, 'sku')} ${text(p, 'title')} ${text(p, 'price_cents')}分 库存 ${text(p, 'stock')}`)
  }
  console.log('--- orders ---')
  for (const o of d.prepare('SELECT id, user_id, status, total_cents FROM orders ORDER BY id').all()) {
    console.log(`  #${text(o, 'id')} 用户 ${text(o, 'user_id')} ${text(o, 'status')} ${text(o, 'total_cents')}分`)
  }
  console.log('--- order_items ---')
  for (const i of d.prepare('SELECT id, order_id, product_id, quantity FROM order_items ORDER BY id').all()) {
    console.log(`  订单 ${text(i, 'order_id')} ← 商品 ${text(i, 'product_id')} × ${text(i, 'quantity')}`)
  }
  d.close()
}

/* ------------------------------------------------------------------ */

/** @type {Record<string, () => void>} */
const ALL = { notx, rollback, nested, check, state }

/**
 * @param {Record<string, () => void>} all
 * @param {string} name
 * @returns {() => void}
 */
function pick(all, name) {
  const fn = all[name]
  if (fn === undefined) {
    console.error(`没有这个实验：${name}`)
    console.error(`可选：${Object.keys(all).join(' / ')}，或者不带参数跑全部`)
    process.exit(1)
  }
  return fn
}

const which = process.argv[2]
for (const fn of which === undefined ? Object.values(ALL) : [pick(ALL, which)]) {
  fn()
  console.log('')
}
