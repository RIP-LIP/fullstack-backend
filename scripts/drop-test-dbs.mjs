/**
 * 清掉残留的测试库。
 *
 * ## 为什么需要它
 *
 * 测试库是一进程一个、跑完就删的。但**进程被强杀**的时候
 * （Ctrl+C、任务管理器、我自己掐掉一个卡死的测试），
 * `disposeTestDatabase()` 不会跑，那个库就留在那儿了。
 *
 * 留着不占多少空间，但每次列库都多几行看不懂的东西，
 * 而下一个会话很可能把它当成「有人的数据」不敢动。
 *
 * ## 它只删名字里有 _test 的库
 *
 * 开发库 `orders` 和它都叫得出来，所以这里按名字判：
 * **不含 `_test` 的一律不碰。** 判错的后果是数据没了。
 *
 * ## 别在测试跑着的时候执行
 *
 * 它会把正在跑的那个测试的库一起删掉。先确认没有 `npm test` 在跑。
 *
 * 用法：
 *   node scripts/drop-test-dbs.mjs          # 列出将要删的，不动手
 *   node scripts/drop-test-dbs.mjs --yes    # 真删
 */

const { Client } = await import('pg')

// 局部变量**不能叫 URL**：那会遮蔽全局的 URL 构造器，
// 下一行 `new URL(...)` 就报「不是构造函数」，运行时也一样炸。
// 这个坑本会话已经踩过两次了（reset-db.mjs 和这个文件），
// 所以在这个文件里再写一遍。
const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/orders'
const adminUrl = new URL(DB_URL)
adminUrl.pathname = '/postgres'

const dry = !process.argv.includes('--yes')

const admin = new Client({ connectionString: adminUrl.toString() })
await admin.connect()

try {
  const rows = await admin.query(
    `SELECT datname FROM pg_database
      WHERE datname LIKE '%\\_test%' ESCAPE '\\'
        AND datname <> 'postgres'
      ORDER BY datname`,
  )
  const names = rows.rows.map((r) => r.datname)

  if (names.length === 0) {
    console.log('没有残留的测试库。')
    process.exit(0)
  }

  console.log(`找到 ${names.length} 个测试库：`)
  for (const n of names) console.log(`  ${n}`)

  if (dry) {
    console.log('')
    console.log('以上只是列出来，没有删。确认了就加 --yes：')
    console.log('  node scripts/drop-test-dbs.mjs --yes')
    process.exit(0)
  }

  for (const n of names) {
    // WITH (FORCE)：被强杀的那个进程留下的连接可能还挂着，
    // 不 FORCE 的话 DROP 会因为有连接而失败。
    await admin.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`)
    console.log(`  已删除 ${n}`)
  }
  console.log(`\n清理完成，删了 ${names.length} 个。`)
} finally {
  await admin.end()
}
