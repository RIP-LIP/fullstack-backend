import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { checksumOf } from '../src/db/migrate.ts'
import { sqliteMigrations } from '../src/db/migrations/sqlite/index.ts'

/**
 * SQLite 那三个迁移是**冻结**的，这个文件就是「冻结」两个字的执行者。
 *
 * ## 为什么需要它
 *
 * 换到 PostgreSQL 之后，`migrations/sqlite/` 里的三个文件不参与任何运行路径。
 * 一份不参与运行的东西，最容易被当成「反正没人用，改一下没关系」。
 * 注释写一百遍「不许改」也拦不住一次顺手编辑——
 * 所以这里把三个 `up` 函数的指纹写死。
 *
 * 改动其中任何一个 `up` 的内容（哪怕只是加一行注释进去），
 * 这三条测试立刻挂，并告诉你是哪个版本对不上了。
 *
 * ## 为什么留着一份死代码是划算的
 *
 * 因为 `001_init.ts` 里的 `AUTOINCREMENT` 在 PostgreSQL 里根本不存在。
 * **它是「不能把老迁移翻译一遍」这件事的第一手证据**，
 * 比任何一句原则性的说明都有用——因为读者可以自己去看那四个关键字。
 *
 * ## 这些数字是哪来的
 *
 * 换库那一刻算出来的。`checksumOf` 算的是 `up` 函数本身的源码，
 * 所以移动文件、改 import 路径都不会影响它；只有改 `up` 的内容才会。
 */
const FROZEN: ReadonlyArray<{ version: number; name: string; checksum: string }> = [
  {
    version: 1,
    name: 'init',
    checksum: 'e982f89164819e45b6d00a5fb90841f698ba165196d129d56e056e2017f4da72',
  },
  {
    version: 2,
    name: 'add_product_description',
    checksum: '617c8f22f981a47bf314da654fdcb226e70a1e1e543f689a03743cbd39b69830',
  },
  {
    version: 3,
    name: 'add_product_title',
    checksum: 'fa89e16b79cd85792c7f8fd1b000123e64202171f74b510a5f7433400dd480c9',
  },
]

describe('历史迁移不许改', () => {
  test('清单本身没被动过（还是那三个）', () => {
    assert.equal(sqliteMigrations.length, FROZEN.length)
  })

  for (const frozen of FROZEN) {
    test(`${frozen.version}_${frozen.name} 的内容没被改过`, () => {
      const m = sqliteMigrations.find((x) => x.version === frozen.version)
      assert.ok(m !== undefined, `找不到版本 ${frozen.version}`)
      assert.equal(m.name, frozen.name, `版本 ${frozen.version} 的名字变了`)
      assert.equal(
        checksumOf(m),
        frozen.checksum,
        [
          `迁移 ${frozen.version}_${frozen.name} 被改过了。`,
          '',
          '这三个文件是冻结的历史：所有跑过 v1.3 之前版本的库，',
          '它们的 schema_migrations 里记的就是这三个指纹。',
          '改动会让那些库在下一次启动时直接抛错退出。',
          '',
          '确实需要新改动的话，写一个新版本的迁移，不要回头改旧的。',
        ].join('\n'),
      )
    })
  }
})

describe('这就是「不能把老迁移翻译一遍」的原因', () => {
  // 这条测试存在的意义不是断言代码，而是**逼着读者去看那四个关键字**。
  // 断言只是把它固定下来，防止哪天有人「顺手」把 AUTOINCREMENT 改成
  // IDENTITY 让它能在 PostgreSQL 里跑——那正是不能做的事。
  test('001 里用的是 AUTOINCREMENT，而 PostgreSQL 没有这个关键字', async () => {
    const { m001 } = await import('../src/db/migrations/sqlite/001_init.ts')
    const source = m001.up.toString()
    const count = source.split('AUTOINCREMENT').length - 1

    assert.equal(count, 4, '四张表各有一个主键，所以是四处')
  })
})
