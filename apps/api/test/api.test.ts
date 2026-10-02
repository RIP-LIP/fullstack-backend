import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness } from './harness.ts'
import type { Harness } from './harness.ts'
import type { HealthResponse, ApiError } from '@fullstack/shared'

/**
 * 接口的通用约定。
 *
 * 这些断言与业务无关，任何加了新接口的项目都该继续成立：
 * 成功返回 JSON、未知路径 404、坏请求体 400。
 * 里面刻意不放任何「某个资源怎样怎样」的用例——那些在各自的测试文件里。
 *
 * 跑法：在仓库根目录 npm test
 */

let h: Harness

before(async () => {
  h = await startHarness()
})

after(async () => {
  await h.close()
})

describe('健康检查', () => {
  test('GET /api/health 返回 200 和约定的形状', async () => {
    const res = await fetch(`${h.baseUrl}/api/health`)

    assert.equal(res.status, 200, `健康检查应返回 200，实际 ${res.status}`)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)

    const body = (await res.json()) as HealthResponse
    assert.equal(body.ok, true)
    assert.equal(body.service, 'api')
  })
})

describe('错误形状', () => {
  test('未知路由返回 404，且 body 是 { error: { code, message } }', async () => {
    const res = await fetch(`${h.baseUrl}/api/does-not-exist`)

    assert.equal(res.status, 404, `未知路由应返回 404，实际 ${res.status}`)

    const body = (await res.json()) as ApiError
    assert.equal(body.error.code, 'NOT_FOUND')
    assert.equal(typeof body.error.message, 'string')
    assert.ok(body.error.message.includes('/api/does-not-exist'), '报错信息里应带上出问题的路径')
  })

  test('请求体不是合法 JSON 时返回 400 而不是 500', async () => {
    const res = await fetch(`${h.baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ 这不是 JSON',
    })

    // 这一条是三句断言里最值钱的一句。body 解析失败是客户端的问题，
    // 漏了它就会返回 500，客户端看到 500 会以为服务端挂了，
    // 真正的原因在自己写坏的请求体上。
    assert.equal(res.status, 400, `坏 JSON 应返回 400，实际 ${res.status}`)

    const body = (await res.json()) as ApiError
    assert.equal(body.error.code, 'INVALID_JSON')
  })
})
