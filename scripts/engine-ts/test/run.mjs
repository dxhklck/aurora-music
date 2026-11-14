/**
 * TS 引擎测试入口。
 *
 * 每个 *.test.ts 单独 bundle（避免全局 fetch mock 互相污染），
 * 再用 node --test 串行执行——全局 fetch 与 mock timers 都不适合并发。
 * 打包用本地 esbuild 的 JS API（不再经 npx 子进程，见 build.mjs 注释）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const SOURCE_DIR = 'scripts/engine-ts/test'
const OUT_DIR = 'scripts/engine-ts/.build/test'
mkdirSync(OUT_DIR, { recursive: true })

const entries = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join(SOURCE_DIR, name))
  .sort()

await build({
  entryPoints: entries,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: OUT_DIR,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning'
})

const built = readdirSync(OUT_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join(OUT_DIR, name))
  .sort()

execFileSync('node', ['--test', '--test-concurrency=1', ...built], { stdio: 'inherit' })
