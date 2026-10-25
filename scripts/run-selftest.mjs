#!/usr/bin/env node
/**
 * 跨平台运行 Electron 自检 / 截图。
 *
 * 存在的理由：
 * 1. 有些终端会继承 ELECTRON_RUN_AS_NODE=1，导致 Electron 以纯 Node 模式启动
 *    （然后报 `protocol is undefined`）。这里显式剔除。
 * 2. 不同平台的可执行文件路径不同，脚本里统一处理，避免文档里写死 .exe。
 *
 * 用法：
 *   node scripts/run-selftest.mjs                    # 集成自检
 *   node scripts/run-selftest.mjs --capture out.png  # 截图
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function electronBinary() {
  const base = join(root, 'node_modules', 'electron', 'dist')
  const candidates =
    process.platform === 'win32'
      ? [join(base, 'electron.exe')]
      : process.platform === 'darwin'
        ? [join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
        : [join(base, 'electron')]
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    console.error('[selftest] 找不到 Electron 可执行文件，先执行 npm install')
    process.exit(2)
  }
  return found
}

const entry = join(root, 'out', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error('[selftest] 找不到构建产物 out/main/index.js，先执行 npm run build')
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let extra = []
const captureIndex = args.indexOf('--capture')
if (captureIndex >= 0) {
  env.AURORA_CAPTURE = resolve(args[captureIndex + 1] ?? join(root, 'docs', 'shots', 'capture.png'))
  extra = args.filter((_, index) => index !== captureIndex && index !== captureIndex + 1)
} else {
  env.AURORA_SELFTEST = '1'
}

const child = spawn(electronBinary(), [entry, ...extra], { cwd: root, env, stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))
