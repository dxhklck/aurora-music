/**
 * 把验证脚本打成可执行 ESM。
 *
 * 用 npx 拉固定版本的 esbuild：项目本身不依赖 esbuild（electron-vite 内部有，
 * 但没有提升到顶层），而为了两个验证脚本往 dependencies 里塞一个打包器不值当。
 * 首次运行需要网络，之后走 npx 缓存。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

const OUT = 'scripts/engine-ts/.build'
mkdirSync(OUT, { recursive: true })

const args = [
  '--yes',
  'esbuild@0.25.0',
  'scripts/engine-ts/run.ts',
  'scripts/engine-ts/e2e.ts',
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node22',
  `--outdir=${OUT}`,
  '--out-extension:.js=.mjs',
  '--log-level=warning'
]

execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' })
console.log(`已生成 ${OUT}/{run,e2e}.mjs`)
