import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toPlaceholders } from '../src/db/placeholders.ts'

/**
 * 占位符改写器的测试。
 *
 * 这个函数错的时候**不报错**。参数会绑到别的列上，语句照样成功，
 * 值全是错的。所以它的测试不是「测一下意思对不对」，
 * 是把每一类「问号不该被改」的区域都钉住。
 *
 * 少一条就是多一类静默错误。改这个文件之前先看下面每条注释。
 */

describe('最基本的形状', () => {
  test('一个问号变成 $1', () => {
    assert.equal(toPlaceholders('SELECT * FROM t WHERE a = ?'), 'SELECT * FROM t WHERE a = $1')
  })

  test('问号按出现顺序编号', () => {
    assert.equal(
      toPlaceholders('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?'),
      'SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3',
    )
  })

  test('没有问号就原样返回', () => {
    const sql = 'SELECT count(*) FROM t WHERE a = 1'
    assert.equal(toPlaceholders(sql), sql)
  })

  test('空串不炸', () => {
    assert.equal(toPlaceholders(''), '')
  })
})

describe('问号在字符串里：不能改', () => {
  test('单引号字面量里的问号原样保留', () => {
    assert.equal(
      toPlaceholders("SELECT '?' AS q, a FROM t WHERE b = ?"),
      "SELECT '?' AS q, a FROM t WHERE b = $1",
    )
  })

  test('一串里多个问号，只有字符串外面的那个被编号', () => {
    assert.equal(
      toPlaceholders("SELECT '?a?', b FROM t WHERE c = ? AND d = ?"),
      "SELECT '?a?', b FROM t WHERE c = $1 AND d = $2",
    )
  })

  // '' 是一个转义后的单引号，不是字符串的结束。
  // 扫描器如果在这里停下，后面的问号就会被错误地编号。
  test('转义的单引号不会提前结束字符串', () => {
    assert.equal(
      toPlaceholders("SELECT 'it''s ? here' AS q FROM t WHERE a = ?"),
      "SELECT 'it''s ? here' AS q FROM t WHERE a = $1",
    )
  })
})

describe('问号在标识符里：不能改', () => {
  test('双引号包起来的列名里的问号原样保留', () => {
    assert.equal(
      toPlaceholders('SELECT "we?ird" FROM t WHERE a = ?'),
      'SELECT "we?ird" FROM t WHERE a = $1',
    )
  })
})

describe('问号在注释里：不能改', () => {
  test('行注释里的问号原样保留', () => {
    assert.equal(
      toPlaceholders('SELECT a -- 真的吗?\nFROM t WHERE b = ?'),
      'SELECT a -- 真的吗?\nFROM t WHERE b = $1',
    )
  })

  test('块注释里的问号原样保留', () => {
    assert.equal(
      toPlaceholders('SELECT a /* 真的吗? */ FROM t WHERE b = ?'),
      'SELECT a /* 真的吗? */ FROM t WHERE b = $1',
    )
  })

  test('注释在末尾也没有问号时不会越界', () => {
    assert.equal(toPlaceholders('SELECT a -- 收尾'), 'SELECT a -- 收尾')
  })

  test('块注释没有收尾时不会越界', () => {
    assert.equal(toPlaceholders('SELECT a /* 没关'), 'SELECT a /* 没关')
  })
})

describe('问号在 dollar-quoting 里：不能改', () => {
  // PostgreSQL 的 dollar-quoting 里面是任意文本，可能是函数体，
  // 里面出现问号完全正常。这是这一层最容易被漏掉的一类。
  test('匿名标签 $$ 里的问号原样保留', () => {
    assert.equal(
      toPlaceholders('SELECT $$a?b$$ AS body FROM t WHERE x = ?'),
      'SELECT $$a?b$$ AS body FROM t WHERE x = $1',
    )
  })

  test('带名字的 $tag$ 里的问号原样保留', () => {
    assert.equal(
      toPlaceholders('SELECT $fn$a?b$fn$ AS body FROM t WHERE x = ?'),
      'SELECT $fn$a?b$fn$ AS body FROM t WHERE x = $1',
    )
  })

  test('带名字的标签里可以有多行', () => {
    assert.equal(
      toPlaceholders('SELECT $fn$\n  -- ?\n  a?b\n$fn$ AS body FROM t WHERE x = ?'),
      'SELECT $fn$\n  -- ?\n  a?b\n$fn$ AS body FROM t WHERE x = $1',
    )
  })
})

describe('改写不能碰已经写好的 SQL', () => {
  // 调用方要是自己写了 $1，这一段必须原样过去，不能被当成标签吃掉。
  test('已经是 $1 的语句不会被当成 dollar-quoting 标签', () => {
    assert.equal(
      toPlaceholders('SELECT * FROM t WHERE a = $1 AND b = $2'),
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    )
  })

  test('混合：本来就有的 $1 之后，问号接着从 $1 重新数', () => {
    // 这不是「接着数成 $2」——改写器只数它自己产生的那些。
    // 真出现这种混写就是 bug，测试让它挂在明面上。
    assert.equal(
      toPlaceholders('SELECT * FROM t WHERE a = $1 AND b = ?'),
      'SELECT * FROM t WHERE a = $1 AND b = $1',
    )
  })
})
