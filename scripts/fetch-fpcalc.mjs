#!/usr/bin/env node
/**
 * 打包前补齐「当前平台」的 fpcalc。
 *
 * 为什么不入库：macOS 版是 universal 二进制（5.2MB），Linux 5.2MB，三平台加起来 15MB。
 * 而每个安装包只需要自己那一份，所以放到构建脚本里按需下载。Windows 版仍随仓库走
 * （4MB，开发模式与自检都要用，且 Windows 是主发布平台）。
 *
 * 用法：
 *   node scripts/fetch-fpcalc.mjs             # 已存在就跳过
 *   node scripts/fetch-fpcalc.mjs --force     # 强制重下
 *   node scripts/fetch-fpcalc.mjs --strict    # 失败时退出码 1（CI / npm run dist）
 *
 * 默认宽松（mac/Linux 下载不到时继续打包，应用侧会返回 binary-missing），
 * 但**严谨的打包链必须传 --strict**：否则三个下载源全挂也会静默产出缺组件的安装包。
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const VERSION = '1.6.2'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const force = process.argv.includes('--force')
const strict = process.argv.includes('--strict')

/** 平台 → [release 资产名, 目标子目录] */
function target() {
  const { platform, arch } = process
  if (platform === 'win32') return null // 已随仓库提供
  if (platform === 'darwin') {
    // universal 一个二进制覆盖 x64 与 arm64
    return { asset: `chromaprint-fpcalc-${VERSION}-macos-universal.tar.gz`, dir: 'darwin' }
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { asset: `chromaprint-fpcalc-${VERSION}-linux-arm64.tar.gz`, dir: 'linux-arm64' }
    return { asset: `chromaprint-fpcalc-${VERSION}-linux-x86_64.tar.gz`, dir: 'linux-x64' }
  }
  return null
}

const plan = target()
if (!plan) {
  if (process.platform === 'win32') {
    // Windows 分支是 no-op，若 exe 没入库，CI 会照样产出一个没有识别功能的安装包。
    // 这里必须拦住，不能只看「打包成功」。
    const exe = join(ROOT, 'resources', 'bin', 'fpcalc.exe')
    if (!existsSync(exe)) {
      console.error('[fpcalc] 缺少 resources/bin/fpcalc.exe：Windows 版随仓库提供，请先把它加入版本库')
      process.exit(1)
    }
    console.log(`[fpcalc] Windows 版随仓库提供：${exe}`)
  } else {
    console.log(`[fpcalc] ${process.platform}/${process.arch} 不受支持，跳过`)
  }
  process.exit(0)
}

const dest = join(ROOT, 'resources', 'bin', plan.dir, 'fpcalc')
if (existsSync(dest) && !force) {
  console.log(`[fpcalc] 已存在，跳过：${dest}`)
  process.exit(0)
}

const url = `https://github.com/acoustid/chromaprint/releases/download/v${VERSION}/${plan.asset}`
// 国内直连 objects.githubusercontent.com 经常只有几 KB/s，走应用自身更新器用的镜像兜底
const sources = [url, `https://ghfast.top/${url}`, `https://gh-proxy.com/${url}`]

/** 抛错而不是 process.exit：try 里直接退出会跳过 finally 的临时目录清理 */
function fail(message) {
  throw new Error(message)
}

async function download(target_url) {
  const res = await fetch(target_url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length < 500_000) throw new Error(`文件过小（${buffer.length}B），可能是错误页`)
  return buffer
}

/** 二进制头校验：避免把 HTML 错误页当成可执行文件打进包里 */
function looksLikeBinary(file) {
  const head = readFileSync(file).subarray(0, 4)
  const isElf = head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
  const isMachO =
    head.readUInt32BE(0) === 0xcafebabe ||
    head.readUInt32BE(0) === 0xfeedface ||
    head.readUInt32BE(0) === 0xfeedfacf
  return isElf || isMachO
}

let archive = null
for (const source of sources) {
  try {
    process.stdout.write(`[fpcalc] 下载 ${basename(source)} … `)
    archive = await download(source)
    console.log(`${Math.round(archive.length / 1024)}KB`)
    break
  } catch (error) {
    console.log(`失败（${error.message}）`)
  }
}
if (!archive) {
  console.error('[fpcalc] 三个下载源都不可用')
  if (strict) process.exit(1)
  console.error('[fpcalc] 继续打包，但安装包里不会带识别组件')
  process.exit(0)
}

const work = mkdtempSync(join(tmpdir(), 'aurora-fpcalc-'))
try {
  const file = join(work, plan.asset)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(file, archive)
  // 用相对文件名 + cwd：绝对路径在 Windows 的 Git Bash tar 里会被当成「远程主机 C:」
  const untar = spawnSync('tar', ['-xzf', plan.asset], { cwd: work, encoding: 'utf8' })
  if (untar.status !== 0) fail(`解压失败：${untar.stderr?.slice(0, 200) || untar.status}`)

  const found = join(work, plan.asset.replace(/\.tar\.gz$/, ''), 'fpcalc')
  if (!existsSync(found)) fail('压缩包里没有 fpcalc')
  if (!looksLikeBinary(found)) fail('解出来的文件不像可执行文件，已放弃')

  mkdirSync(join(ROOT, 'resources', 'bin', plan.dir), { recursive: true })
  copyFileSync(found, dest)
  chmodSync(dest, 0o755)
  console.log(`[fpcalc] 已放到 ${dest}（${Math.round(statSync(dest).size / 1024 / 1024)}MB）`)
} catch (error) {
  console.error(`[fpcalc] ${error instanceof Error ? error.message : String(error)}`)
  if (strict) process.exitCode = 1
  else console.error('[fpcalc] 继续打包，但安装包里不会带识别组件')
} finally {
  rmSync(work, { recursive: true, force: true })
}
