/**
 * 把验证脚本打成可执行 ESM。
 *
 * 直接用本地 esbuild 的 JS API（devDependency）：原先经 `npx esbuild` 子进程
 * 打包，Windows 上 npx 是 .cmd 必须开 shell:true（DEP0190 弃用），还引入
 * 首次运行的网络依赖。JS API 两者皆无。
 */
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const OUT = 'scripts/engine-ts/.build'
mkdirSync(OUT, { recursive: true })

await build({
  entryPoints: ['scripts/engine-ts/run.ts', 'scripts/engine-ts/e2e.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outdir: OUT,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning'
})
console.log(`已生成 ${OUT}/{run,e2e}.mjs`)
