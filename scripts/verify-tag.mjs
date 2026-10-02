/**
 * tag 复现脚本。
 *
 * 每个 tag 都要能被别人独立跑起来。「跑通了」这句话没有证据，
 * 所以这个脚本把复现拆成几步会失败的检查：
 *
 *   1. tag 存在吗
 *   2. 导出到临时目录
 *   3. 装依赖（有 lock 走 npm ci，没有走 npm install）
 *   4. 跑测试
 *   5. 起服务，轮询 /api/health
 *   6. 响应体形状对吗
 *   7. 收尾：关服务、删临时目录
 *
 * 任何一步失败都退出 1。故意不吞错误——一个静默通过的复现脚本
 * 比没有脚本更危险。
 *
 * 跑法：node scripts/verify-tag.mjs v1.0
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

/** 起服务最多等这么久。超时和「服务挂了」要分得开，所以记了 startedAt。 */
const HEALTH_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 300

const tag = process.argv[2]
if (!tag) {
  console.error('用法：node scripts/verify-tag.mjs <tag>')
  console.error('例如：node scripts/verify-tag.mjs v0.0')
  process.exit(1)
}

let workDir = ''
let server = null

try {
  step(`确认 tag ${tag} 存在`)
  try {
    execFileSync('git', ['rev-parse', '--verify', `${tag}^{commit}`], { cwd: repoRoot, stdio: 'pipe' })
  } catch {
    fail(`tag ${tag} 不存在。先打 tag 再验证，或者检查名字拼错了。`)
  }

  step('导出到临时目录')
  workDir = mkdtempSync(join(tmpdir(), `verify-${tag}-`))
  // 用 git archive 而不是 git clone：clone 会带上 .git，测的就不是「这个 tag 的代码」
  // 而是「这个仓库现在的状态」。archive 只导出被提交过的文件。
  const archivePath = join(workDir, 'src.tar')
  execFileSync('git', ['archive', '--format=tar', '-o', archivePath, tag], { cwd: repoRoot, stdio: 'pipe' })
  execFileSync('tar', ['-xf', archivePath, '-C', workDir], { stdio: 'pipe' })
  rmSync(archivePath, { force: true })

  if (!existsSync(join(workDir, 'package.json'))) {
    fail('导出结果里没有 package.json。这个 tag 可能导出的是空目录。')
  }
  console.log(`   临时目录：${workDir}`)

  step('安装依赖')
  // 有 lock 就走 npm ci，因为它严格按 lock 装，能顺带发现 lock 和 package.json 不同步
  const hasLock = existsSync(join(workDir, 'package-lock.json'))
  console.log(`   执行：${hasLock ? 'npm ci' : 'npm install'}`)
  const install = npmArgs(hasLock ? ['ci'] : ['install'])
  execFileSync(install.cmd, install.args, { cwd: workDir, stdio: 'inherit' })

  step('跑测试')
  const test = npmArgs(['test'])
  execFileSync(test.cmd, test.args, { cwd: workDir, stdio: 'inherit' })

  step('起服务并等健康检查通过')
  // 自己找一个空端口，不用 3002——那可能正被你自己开着的服务占着，
  // 于是脚本测的是一个没起来的服务，health 探不通，报错还指向别处。
  const port = await findFreePort()
  console.log(`   用端口 ${port}`)

  server = spawn(process.execPath, [join(workDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'apps/api/src/index.ts'], {
    cwd: workDir,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stdout.on('data', (d) => process.stdout.write(`   [服务] ${d}`))
  server.stderr.on('data', (d) => process.stderr.write(`   [服务] ${d}`))

  let exited = null
  server.on('exit', (code) => { exited = code })

  const health = await waitForHealth(port)
  if (health === null) {
    const why = exited !== null ? `服务已退出（退出码 ${exited}）` : `${HEALTH_TIMEOUT_MS / 1000} 秒内没有响应`
    fail(`健康检查没通过：${why}`)
  }

  step('检查响应体形状')
  if (health.body.ok !== true || health.body.service !== 'api') {
    fail(`健康检查返回了预期外的形状：${JSON.stringify(health.body)}`)
  }
  console.log(`   拿到 ${JSON.stringify(health.body)}`)

  console.log(`\n${tag} 复现通过。`)
  process.exitCode = 0
} catch (err) {
  if (err instanceof Error && err.message === 'FAIL') {
    process.exitCode = 1
  } else {
    console.error('\n复现过程中出错：', err)
    process.exitCode = 1
  }
} finally {
  step('收尾')
  if (server !== null && server.exitCode === null) {
    // Windows 上要杀整个进程组，tsx 会 fork 出真正的 node 进程，
    // 只 kill 父进程的话子进程会变孤儿，继续占着端口。
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch { /* 已经退出了 */ }
    } else {
      server.kill('SIGTERM')
    }
  }
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true })
    console.log(`   已删除临时目录 ${workDir}`)
  }
}

function step(msg) {
  console.log(`\n▸ ${msg}`)
}

/**
 * 跑 npm 的正确姿势：绕过 .cmd，直接用 node 跑 npm 的 JS 入口。
 *
 * 两条弯路都踩过：
 * 1. spawn('npm', { shell: true }) —— 能跑通，但 Node 会报 DEP0190：
 *    参数不经转义只做拼接，路径里有空格或特殊字符时行为不可预期。
 * 2. spawn('npm.cmd') —— Windows 上 Node 24 直接报 EINVAL。
 *    这是 CVE-2024-27980 的修复：新版 Node 拒绝不经 shell 执行 .cmd / .bat。
 *
 * 入口路径从当前 node.exe 推出来，所以不用猜 npm 装在哪。
 */
function npmArgs(args) {
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCli)) {
    fail(`找不到 npm 的入口 ${npmCli}。这个脚本需要用 node 自带的 npm 跑。`)
  }
  return { cmd: process.execPath, args: [npmCli, ...args] }
}

function fail(msg) {
  console.error(`\n失败：${msg}`)
  const e = new Error('FAIL')
  throw e
}

/** 让系统分配一个端口再立刻放掉。拿到的是当时确定空闲的端口。 */
function findFreePort() {
  return new Promise((res, rej) => {
    import('node:net').then(({ createServer }) => {
      const srv = createServer()
      srv.unref()
      srv.on('error', rej)
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address()
        srv.close(() => res(port))
      })
    })
  })
}

/**
 * 轮询到健康检查通过为止。
 * 不用固定 sleep：固定 sleep 有两种失败模式——睡太久白等，
 * 睡太短服务还没起来就报「挂了」。轮询把两种都消掉。
 */
async function waitForHealth(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  const url = `http://127.0.0.1:${port}/api/health`
  let lastError = '没有发出过请求'

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      const body = await res.json()
      if (res.status === 200) return { status: res.status, body }
      lastError = `状态码 ${res.status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  console.error(`   最后一次失败原因：${lastError}`)
  return null
}
