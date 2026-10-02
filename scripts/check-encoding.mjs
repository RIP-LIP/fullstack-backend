/**
 * 乱码检查。
 *
 * 找的是 Unicode 的替换字符 U+FFFD：它在原文里表示「这里本来有个字符，
 * 但按错误的编码解不出来了」。它不影响编译，也不影响测试，
 * 所以没有任何现有检查会拦它。
 *
 * 为什么值得单独查一个：中文正文里夹一个坏字符不影响任何自动检查，
 * 读的人也可能滑过去。但它会**传播**——一段被污染的注释被复制到
 * 另一个文件时，污染跟着走，最后出现在读者屏幕上。
 *
 * 这个文件本身用转义写法构造待查字符，不用字面量，
 * 否则它会把自己也报上来。
 *
 * 范围只扫代码和文档，不扫 node_modules 和数据目录。
 *
 * 用法：node scripts/check-encoding.mjs
 * 退出码：0 干净；1 有乱码（并逐条打印文件与行号）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

/** 损坏字符。用转义写，免得这个文件自己命中自己。 */
const MOJIBAKE = '\uFFFD'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist'])
const SCAN_EXT = /\.(ts|mts|js|mjs|json|md|yml|yaml)$/

/** @type {{ file: string, line: number, text: string }[]} */
const found = []

/**
 * @param {string} dir
 * @returns {void}
 */
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!SCAN_EXT.test(entry)) continue

    const lines = readFileSync(full, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes(MOJIBAKE)) {
        found.push({ file: relative(root, full), line: i + 1, text: line.trim() })
      }
    })
  }
}

walk(root)

if (found.length === 0) {
  console.log('没有发现乱码。')
  process.exit(0)
}

console.error(`\n发现 ${found.length} 处乱码（U+FFFD）：\n`)
for (const f of found) {
  console.error(`  ${f.file}:${f.line}`)
  console.error(`      ${f.text}\n`)
}
process.exit(1)
