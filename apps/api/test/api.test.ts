/**
 * 接口的集成测试。
 *
 * 三个设计点，是为了不把你正在写的东西弄脏：
 * 1. 临时端口。listen(0) 让系统随便给一个空端口，不用真的占用 3002。
 *    这样你可以一边跑测试一边跑 npm run dev。
 * 2. 动态 import。ESM 的 import 会被提升到文件顶，createApp 必须在 before 里 await 进来。
 * 3. 无数据库。项目基线还没有任何表，这三条只验「服务能起来、错误形状对」。
 *    接入数据层之后（ch04）再补库相关的用例。
 *
 * 跑法：在仓库根目录 npm test
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { HealthResponse } from '@fullstack/shared'
import type { ApiError } from '@fullstack/shared'

let baseUrl = ''
let server: Server

before(async () => {
  const { createApp } = await import('../src/app.ts')
  const app = createApp()

  server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))

  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('拿不到监听地址，测试无法继续')
  }
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

describe('健康检查', () => {
  test('GET /api/health 返回 200 和约定的形状', async () => {
    const res = await fetch(`${baseUrl}/api/health`)

    assert.equal(res.status, 200, `健康检查应返回 200，实际 ${res.status}`)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)

    const body = (await res.json()) as HealthResponse
    assert.equal(body.ok, true)
    assert.equal(body.service, 'api')
  })
})

describe('错误形状', () => {
  test('未知路由返回 404，且 body 是 { error: { code, message } }', async () => {
    const res = await fetch(`${baseUrl}/api/does-not-exist`)

    assert.equal(res.status, 404, `未知路由应返回 404，实际 ${res.status}`)

    const body = (await res.json()) as ApiError
    assert.equal(body.error.code, 'NOT_FOUND')
    assert.equal(typeof body.error.message, 'string')
    assert.ok(body.error.message.includes('/api/does-not-exist'), '报错信息里应带上出问题的路径')
  })

  test('请求体不是合法 JSON 时返回 400 而不是 500', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
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
