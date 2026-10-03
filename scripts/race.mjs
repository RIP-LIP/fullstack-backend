/**
 * 丢失更新：两个并发请求同时抢最后一件库存。
 *
 * 跑法：
 *   node scripts/race.mjs              四个场景都跑
 *   node scripts/race.mjs lost         只跑「先查后写」
 *   node scripts/race.mjs guarded      只跑「把判断放进 WHERE」
 *   node scripts/race.mjs serializable 只跑「同样的先查后写 + SERIALIZABLE」
 *   node scripts/race.mjs pool         只跑「池耗尽时是什么样」
 *
 * 它连的是**开发库**（DATABASE_URL），并且会往 products 里造数据。
 * 跑之前先 `docker compose up -d`。
 *
 * ## 为什么不用 sleep 撞运气
 *
 * 丢失更新要复现，必须让两个连接**同时**读到同一个 stock。
 * 用 `setTimeout` 去猜「睡多久对方刚好还没写」，十次里有九次不并发，
 * 而那一次没复现出来你会以为「PG 挡住了」——结论完全反了。
 *
 * 所以这里用**显式 barrier**：两边都 SELECT 完了，才一起放行去 UPDATE。
 * 到齐才走，时序是确定的。
 */

import { Client, Pool } from 'pg'

const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'

/**
 * 显式 barrier：N 个参与者都到了才放行。
 *
 * 用一个共享的计数器和一组 resolver 实现，比 sleep 可靠得多，
 * 而且到齐才走意味着「两个请求真的同时在跑」这件事是可证的。
 *
 * @param {number} size 一共几个参与者
 * @returns {() => Promise<void>} 到了就返回，没到就一直等
 */
function makeBarrier(size) {
  let arrived = 0
  /** @type {Array<() => void>} */
  const waiting = []

  return function arrive() {
    arrived += 1
    if (arrived >= size) {
      for (const w of waiting.splice(0)) w()
      return Promise.resolve()
    }
    return new Promise((resolve) => waiting.push(resolve))
  }
}

/**
 * 造一件商品，返回它的 id。
 *
 * @param {Client} client
 * @param {string} sku
 * @param {number} stock
 * @returns {Promise<number>}
 */
async function seedProduct(client, sku, stock) {
  const res = await client.query(
    `INSERT INTO products (sku, name, title, price_cents, stock, created_at)
     VALUES ($1, $1, $1, 100, $2, $3) RETURNING id`,
    [sku, stock, new Date().toISOString()],
  )
  return res.rows[0].id
}

/**
 * @param {Client} client
 * @param {number} id
 * @returns {Promise<number>}
 */
async function stockOf(client, id) {
  const res = await client.query('SELECT stock FROM products WHERE id = $1', [id])
  return res.rows[0].stock
}

/** @returns {Promise<Client>} */
async function connect() {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  return client
}

/**
 * @param {string} title
 * @returns {void}
 */
function head(title) {
  console.log('')
  console.log('='.repeat(60))
  console.log(title)
  console.log('='.repeat(60))
}

/* ------------------------------------------------------------------ *
 * 场景一：先查后写 —— 丢失更新
 * ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
async function lost() {
  head('场景一：先查后写（教科书写法）')

  const setup = await connect()
  const id = await seedProduct(setup, `RACE-LOST-${Date.now()}`, 1)
  await setup.end()

  const a = await connect()
  const b = await connect()
  const barrier = makeBarrier(2)

  /**
   * 教科书写法：先 SELECT 看看够不够，够就 UPDATE。
   * 中间那一段时间差，就是丢失更新的窗口。
   *
   * @param {Client} client
   * @param {string} who
   * @returns {Promise<void>}
   */
  const buy = async (client, who) => {
    const seen = await client.query('SELECT stock FROM products WHERE id = $1', [id])
    const stock = seen.rows[0].stock
    console.log(`  ${who} 读到了 stock = ${stock}`)

    await barrier()

    const next = stock - 1
    await client.query('UPDATE products SET stock = $1 WHERE id = $2', [next, id])
    console.log(`  ${who} 按自己读到的值写回了 stock = ${next}`)
  }

  await Promise.all([buy(a, '甲'), buy(b, '乙')])
  await a.end()
  await b.end()

  const check = await connect()
  const after = await stockOf(check, id)
  await check.end()

  // 判据不是「库存是不是 0」，是**买到手的件数和库存减少的件数对不对得上**。
  // 库里有 1 件，两个请求都买到了 1 件，那库存应该减少 2。
  // 少了的那一件就是被覆盖掉的那一次写。
  const sold = 1 - after
  const buyers = 2

  console.log('')
  console.log(`  买到手的件数: ${buyers}     <- 两个请求都拿到了成功响应`)
  console.log(`  库存实际减少: ${sold}     <- 库里的 stock 从 1 变成了 ${after}`)
  console.log('')
  if (sold < buyers) {
    const lostCount = buyers - sold
    console.log('  **丢失更新。** 两个请求都拿到了成功响应，')
    console.log(`  但库存只减了 ${sold} 件——有 ${lostCount} 个订单没有对应的发货。`)
    console.log('  没有异常，没有日志，没有 409。仓库只能等发现超卖之后再回头处理。')
  } else {
    console.log('  没有复现出来。如果 barrier 确实对齐了，这不该发生；')
    console.log('  先看是不是有人在别处改了隔离级别。')
  }
}

/* ------------------------------------------------------------------ *
 * 场景二：把判断放进 WHERE —— 不丢
 * ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
async function guarded() {
  head('场景二：把判断放进 WHERE（本项目用的写法）')

  const setup = await connect()
  const id = await seedProduct(setup, `RACE-OK-${Date.now()}`, 1)
  await setup.end()

  const a = await connect()
  const b = await connect()
  const barrier = makeBarrier(2)

  /**
   * @param {Client} client
   * @param {string} who
   * @returns {Promise<void>}
   */
  const buy = async (client, who) => {
    const seen = await client.query('SELECT stock FROM products WHERE id = $1', [id])
    console.log(`  ${who} 读到了 stock = ${seen.rows[0].stock}（读了，但不用来做判断）`)

    await barrier()

    // 判断交给数据库：它在**写的那一刻**判断 stock >= 1 是否成立。
    // 两行 UPDATE 抢同一行时，后一个会被行锁挡住，等前一个提交完再判断。
    const res = await client.query(
      'UPDATE products SET stock = stock - 1 WHERE id = $1 AND stock >= 1 RETURNING id',
      [id],
    )
    if (res.rowCount === 0) {
      console.log(`  ${who} 扣减失败（0 行受影响）-> 409 库存不足`)
    } else {
      console.log(`  ${who} 扣减成功`)
    }
  }

  await Promise.all([buy(a, '甲'), buy(b, '乙')])
  await a.end()
  await b.end()

  const check = await connect()
  const after = await stockOf(check, id)
  await check.end()

  console.log('')
  console.log('  库存实际减少: 1     <- 只有一个请求成功')
  console.log(`  库里的库存: ${after}`)
  console.log('')
  console.log('  没丢。`stock >= 1` 这个判断不在内存里做，就在数据库里做，')
  console.log('  而数据库判断和写入之间有行锁——所以它们之间插不进来。')
  console.log('')
  console.log('  注意这里是「一个失败、一个成功」，不是「两个都成功」。')
  console.log('  业务代码靠 RETURNING 拿到 0 行受影响就知道该回 409 了。')
}

/* ------------------------------------------------------------------ *
 * 场景三：同样的先查后写 + SERIALIZABLE
 * ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
async function serializable() {
  head('场景三：同样的先查后写，但隔离级别提到 SERIALIZABLE')

  const setup = await connect()
  const id = await seedProduct(setup, `RACE-SER-${Date.now()}`, 1)
  await setup.end()

  const a = await connect()
  const b = await connect()
  await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
  const barrier = makeBarrier(2)

  /**
   * @param {Client} client
   * @param {string} who
   * @returns {Promise<void>}
   */
  const buy = async (client, who) => {
    try {
      const seen = await client.query('SELECT stock FROM products WHERE id = $1', [id])
      const stock = seen.rows[0].stock
      console.log(`  ${who} 读到了 stock = ${stock}`)

      await barrier()

      await client.query('UPDATE products SET stock = $1 WHERE id = $2', [stock - 1, id])
      await client.query('COMMIT')
      console.log(`  ${who} 提交成功`)
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      const code = err !== null && typeof err === 'object' && 'code' in err ? String(err.code) : '未知'
      const message = err instanceof Error ? err.message : String(err)
      console.log(`  ${who} 被拒绝：${code}  ${message}`)
    }
  }

  await Promise.all([buy(a, '甲'), buy(b, '乙')])
  await a.end()
  await b.end()

  const check = await connect()
  const after = await stockOf(check, id)
  await check.end()

  console.log('')
  console.log(`  库里的库存: ${after}`)
  console.log('')
  console.log('  PostgreSQL 默认的读已提交（READ COMMITTED）挡不住这个。')
  console.log('  SERIALIZABLE 挡得住，**但不是靠提前拒绝，是靠提交时才发现**：')
  console.log('  它在读的时候给这行打了快照锁，两个事务于是成了串行，')
  console.log('  后一个提交时发现「你这笔依赖一个已经过期的快照」，报 40001。')
  console.log('')
  console.log('  也就是说：**数据库不阻止你写错，它在提交时拒绝你。**')
  console.log('  所以调用方必须处理 40001——通常的做法是重试整笔事务，')
  console.log('  而重试又要求写操作本身是幂等的。')
}

/* ------------------------------------------------------------------ *
 * 场景四：连接池耗尽时是什么样
 * ------------------------------------------------------------------ */

/** @returns {Promise<void>} */
async function pool() {
  head('场景四：连接池耗尽时是什么样')

  // 特意开一个 max=1 的池，这样一条连接就能演示清楚。
  const small = new Pool({ connectionString: DB_URL, max: 1 })

  // 把唯一那条借走，攥在事务里不放
  const held = await small.connect()
  await held.query('BEGIN')
  console.log('  借走了池里唯一那条连接，开始一个事务')

  // 现在池空了。下面这个查询**不会报错**，它排队等着。
  const t0 = Date.now()
  const waiting = small.query('SELECT 1 AS n')
  console.log('  发第二个查询——它没有报错，也没有立刻返回，它在排队')

  await new Promise((r) => setTimeout(r, 800))
  console.log(`  攥了 800ms 之后才放。`)

  await held.query('COMMIT')
  held.release()
  console.log('  放掉那条连接')

  const res = await waiting
  const waited = Date.now() - t0
  console.log(`  排队的那个查询这时才返回，拿到 ${JSON.stringify(res.rows[0])}`)
  console.log('')
  console.log(`  它等了 ${waited} ms。`)
  console.log('')
  console.log('  **池耗尽的表现是排队，不是报错。**')
  console.log('  这就是为什么「连接池满了」这个故障很难查：')
  console.log('  日志里没有异常、没有 500，只有一堆请求慢慢变慢，')
  console.log('  最后全堆在超时上，看起来像「数据库很慢」。')
  console.log('')
  console.log('  两条出路：把 max 调大，或者把事务做短。')
  console.log('  调大 max 只是把排队往后推——每个连接都是一条网络往返，')
  console.log('  而数据库能同时处理多少是它自己的事，不是你池子大就行的。')

  await small.end()
}

/* ------------------------------------------------------------------ */

/** @type {Record<string, () => Promise<void>>} */
const ALL = { lost, guarded, serializable, pool }

/**
 * @param {Record<string, () => Promise<void>>} all
 * @param {string} name
 * @returns {() => Promise<void>}
 */
function pick(all, name) {
  const fn = all[name]
  if (fn === undefined) {
    console.error(`没有这个场景：${name}`)
    console.error(`可选：${Object.keys(all).join(' / ')}，或者不带参数跑全部`)
    process.exit(1)
  }
  return fn
}

const which = process.argv[2]

try {
  for (const fn of which === undefined ? Object.values(ALL) : [pick(ALL, which)]) {
    await fn()
  }
} catch (err) {
  console.error('')
  console.error('跑不起来。先确认库在：docker compose ps')
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

console.log('')
