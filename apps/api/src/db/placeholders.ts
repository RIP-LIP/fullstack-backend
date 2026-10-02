/**
 * SQL 占位符改写：`?` → `$1`、`$2`……
 *
 * ## 为什么要做这一层
 *
 * 业务代码里写的是 `WHERE id = ?`，而 `pg` 只认 `WHERE id = $1`。
 * 两个选择：把全项目的 SQL 逐处改成 `$1`，或者在这里改写。
 * 选后者，是为了让 `routes/` 一个字都不用动——这正是上一层存在的理由。
 *
 * ## 它是便利层，不是 SQL 解析器
 *
 * 逐字符扫描，跳过五类区域：单引号字符串、双引号标识符、`--` 行注释、
 * 块注释、PostgreSQL 的 dollar-quoting。区域里的问号原样保留，
 * 区域外的问号依次变成 `$1`、`$2`……
 *
 * ## 它的边界写在明处
 *
 * **一旦出现扫描器覆盖不到的语法，改写就会静默错位。**
 * 错位的症状是「参数绑到了别的列上」——语句照样成功，值全错，
 * 比直接报错难查得多。所以 `placeholder.test.ts` 那十几条不是装饰，
 * 是这道闸的本体。少一条就是多一类静默错误。
 *
 * ## 为什么单独一个文件
 *
 * 因为它是纯函数。留在 `db/postgres.ts` 里的话，
 * 测试它就必须先连上数据库——而一个纯字符串函数的单元测试
 * 不该有任何前置条件。
 */

/**
 * 把 SQL 里的 `?` 依次改写成 `$1`、`$2`……
 *
 * @param sql 原始 SQL
 * @returns 占位符已改写的 SQL
 */
export function toPlaceholders(sql: string): string {
  let out = ''
  let i = 0
  let n = 0

  while (i < sql.length) {
    const c = sql[i] as string

    if (c === "'") {
      const end = skipQuoted(sql, i, "'")
      out += sql.slice(i, end)
      i = end
      continue
    }

    if (c === '"') {
      const end = skipQuoted(sql, i, '"')
      out += sql.slice(i, end)
      i = end
      continue
    }

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const end = nl === -1 ? sql.length : nl
      out += sql.slice(i, end)
      i = end
      continue
    }

    if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const end = close === -1 ? sql.length : close + 2
      out += sql.slice(i, end)
      i = end
      continue
    }

    const tag = matchDollarTag(sql, i)
    if (tag !== null) {
      const close = sql.indexOf(tag, i + tag.length)
      const end = close === -1 ? sql.length : close + tag.length
      out += sql.slice(i, end)
      i = end
      continue
    }

    if (c === '?') {
      n += 1
      out += `$${n}`
      i += 1
      continue
    }

    out += c
    i += 1
  }

  return out
}

/**
 * 从 start（引号本身的位置）开始跳过一个带引号的文本，
 * 返回收尾引号之后的位置。找不到收尾引号就返回串尾。
 */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      // 两个连着的引号是转义，不是结束
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return sql.length
}

/**
 * 当前位置是不是 dollar-quoting 的开始标签。
 * 是就返回完整的标签（含两端的 $），不是就返回 null。
 *
 * 标签是 `$$` 或 `$名字$`，名字以字母或下划线开头。
 * 所以 `$1` 不会被误判成标签——它没有收尾的那个 `$`。
 */
function matchDollarTag(sql: string, i: number): string | null {
  if (sql[i] !== '$') return null
  const m = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
  return m === null ? null : m[0]
}
