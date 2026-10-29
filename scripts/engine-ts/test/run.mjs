/**
 * TS 引擎测试入口。
 *
 * 每个 *.test.ts 单独 bundle（避免全局 fetch mock 互相污染），
 * 再用 node --test 串行执行——全局 fetch 与 mock timers 都不适合并发。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE_DIR = 'scripts/engine-ts/test'
const OUT_DIR = 'scripts/engine-ts/.build/test'
mkdirSync(OUT_DIR, { recursive: true })

const entries = readdirSync(SOURCE_DIR)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join(SOURCE_DIR, name))
  .sort()

const args = [
  '--yes',
  'esbuild@0.25.0',
  ...entries,
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  `--outdir=${OUT_DIR}`,
  '--out-extension:.js=.mjs',
  '--log-level=warning'
]
execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' })

const built = readdirSync(OUT_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join(OUT_DIR, name))
  .sort()

execFileSync('node', ['--test', '--test-concurrency=1', ...built], { stdio: 'inherit' })
