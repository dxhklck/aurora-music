#!/usr/bin/env node
/**
 * 发版后核对：一条命令确认「GitHub 发了」和「主更新源也指过去了」。
 *
 * ## 为什么需要它
 *
 * 发一次版有两个彼此独立的结果：GitHub Release 建好了，以及 GitCode 的
 * `stable` 指针覆盖成新版本。第二个**经常失败**——GitHub 的美国 runner 到
 * `api.gitcode.com` 实测 `fetch failed`，而工作流里那两步是
 * `continue-on-error: true`，所以 CI 照样显示绿色，只在注解里留一行 error。
 *
 * 结果是「CI 全绿 ≠ 主更新源更新」：v1.3.11 与 v1.3.12 都因此让 `stable`
 * 停在上一版。这个脚本把那套手工核对（docs/update-feed-setup.md 第四节）
 * 变成一条命令 + 非零退出，好让 `npm run dist` 或发版流程能卡住。
 *
 * 必须在**能同时到达两边**的机器上跑（作者本机）。放进 CI 是自欺：那个 runner
 * 到 GitCode 本来就通不了，检查必然和同步步骤一起失败。
 *
 * ## 用法
 *
 *   npm run release:verify                 # 核对 package.json 里的版本
 *   npm run release:verify -- 1.3.12       # 核对指定版本
 *   npm run release:verify -- --proxy=http://127.0.0.1:10808
 *   npm run release:verify -- --deep       # 额外整包下载比对 sha512（约 110MB）
 *
 * 代理只作用于 GitHub 请求；GitCode 一律直连（国内本来就快，走代理反而慢）。
 * 没给 --proxy 时读环境变量 AURORA_PROXY。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'dxhklck/aurora-music'
const GITCODE_REPO = 'dxhklck/aurora_music_release'
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

const argv = process.argv.slice(2)
const flags = argv.filter((item) => item.startsWith('--'))
const positional = argv.filter((item) => !item.startsWith('--'))

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = (positional[0] || pkg.version).replace(/^v/, '')
const wantTag = `v${version}`
const deep = flags.includes('--deep')
const proxyFlag = flags.find((item) => item.startsWith('--proxy='))
const githubProxy = (proxyFlag ? proxyFlag.slice('--proxy='.length) : process.env.AURORA_PROXY || '').trim()

/**
 * 状态码标记。两个坑都踩过了：
 * - 不能含换行：Windows 上传参时换行会被吞，标记串就再也找不到；
 * - 不能以 `@` 开头：curl 会把 `-w @xxx` 当成「从文件读取格式」，直接报错。
 */
const HTTP_MARK = 'HTTP_CODE='

/** 用 curl 而不是 fetch：Node 的 fetch 不认 HTTP_PROXY，而这里必须能分别控制两边走不走代理 */
function curl(url, { proxy = '', range = null, timeout = 45 } = {}) {
  const args = ['-sS', '-L', '--max-time', String(timeout)]
  if (proxy) args.push('-x', proxy)
  else args.push('--noproxy', '*')
  if (range) {
    args.push('-r', range, '-o', NULL_DEVICE, '-w', '%{http_code}')
  } else {
    args.push('-w', `${HTTP_MARK}%{http_code}`)
  }
  args.push(url)
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', timeout: (timeout + 15) * 1000 })
    if (range) return { status: Number(out.trim()) || 0, body: '' }
    const at = out.lastIndexOf(HTTP_MARK)
    if (at < 0) return { status: 0, body: out, error: '读不到 HTTP 状态码' }
    return { status: Number(out.slice(at + HTTP_MARK.length).trim()) || 0, body: out.slice(0, at) }
  } catch (error) {
    const detail = error?.stderr ? String(error.stderr).trim().slice(0, 120) : error?.message || 'curl 调用失败'
    return { status: 0, body: '', error: detail }
  }
}

function ymlValue(text, key) {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(text)
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : ''
}

/** 下载到文件（不经过字符串，避免二进制被 UTF-8 解码损坏）；返回 HTTP 状态码 */
function downloadTo(url, filePath, timeout = 600) {
  try {
    const out = execFileSync(
      'curl',
      ['-sS', '-L', '--noproxy', '*', '--max-time', String(timeout), '-o', filePath, '-w', '%{http_code}', url],
      { encoding: 'utf8', timeout: (timeout + 30) * 1000 }
    )
    return Number(out.trim()) || 0
  } catch {
    return 0
  }
}

const GH_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const GH_YML = `https://github.com/${REPO}/releases/latest/download/latest.yml`
const GC_YML = `https://gitcode.com/${GITCODE_REPO}/releases/download/stable/latest.yml`
const GC_BASE = `https://gitcode.com/${GITCODE_REPO}/releases/download/stable`

const checks = []
function record(name, ok, detail) {
  checks.push({ name, ok, detail })
}

// 1) GitHub Release 的 tag
const ghApi = curl(GH_LATEST_API, { proxy: githubProxy })
if (ghApi.status !== 200) {
  record('GitHub releases/latest 可访问', false, ghApi.error || `HTTP ${ghApi.status}`)
} else {
  let tag = ''
  try {
    tag = JSON.parse(ghApi.body).tag_name || ''
  } catch {
    /* 落到下面的 FAIL */
  }
  record('GitHub release 的 tag', tag === wantTag, tag ? `${tag}（期望 ${wantTag}）` : '返回里没有 tag_name')
}

// 2) GitHub latest.yml
const ghYml = curl(GH_YML, { proxy: githubProxy })
const ghVersion = ghYml.status === 200 ? ymlValue(ghYml.body, 'version') : ''
record(
  'GitHub latest.yml 的 version',
  ghVersion === version,
  ghYml.status !== 200 ? ghYml.error || `HTTP ${ghYml.status}` : ghVersion || '清单里没有 version'
)

// 3) GitCode stable latest.yml（主更新源）
const gcYml = curl(GC_YML)
const gcVersion = gcYml.status === 200 ? ymlValue(gcYml.body, 'version') : ''
record(
  'GitCode latest.yml 的 version',
  gcVersion === version,
  gcYml.status !== 200 ? gcYml.error || `HTTP ${gcYml.status}` : `${gcVersion || '清单里没有 version'}（期望 ${version}）`
)

// 4) 两源的安装包文件名必须逐字一致：
//    latest.yml 里的 url 是更新器拼下载地址的唯一依据，两源不同就是有一边 404。
const ghFile = ghYml.status === 200 ? ymlValue(ghYml.body, 'path') || ymlValue(ghYml.body, 'url') : ''
const gcFile = gcYml.status === 200 ? ymlValue(gcYml.body, 'path') || ymlValue(gcYml.body, 'url') : ''
record(
  '两源的安装包文件名一致',
  Boolean(ghFile) && ghFile === gcFile,
  ghFile || gcFile ? `GitHub=${ghFile || '?'} · GitCode=${gcFile || '?'}` : '两源都读不到文件名'
)

// 5) 主源的安装包必须能匿名下载（HEAD 会被 WAF 拦 401，必须用 Range GET）
const assetName = gcFile || ghFile || `Aurora-Music-${version}-x64.exe`
const gcAsset = curl(`${GC_BASE}/${encodeURIComponent(assetName)}`, { range: '0-1023' })
record(
  'GitCode 安装包可匿名 Range 下载',
  gcAsset.status === 206 || gcAsset.status === 200,
  gcAsset.error || `HTTP ${gcAsset.status}`
)

// 6) --deep：整包下载比对 sha512（默认不做，110MB 要十几秒）
if (deep && gcYml.status === 200) {
  const wantSha = ymlValue(gcYml.body, 'sha512')
  const wantSize = Number(ymlValue(gcYml.body, 'size')) || 0
  const dir = join(ROOT, 'artifacts')
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'release-verify.tmp')
  const status = downloadTo(`${GC_BASE}/${encodeURIComponent(assetName)}`, tmp)
  if (status !== 200) {
    rmSync(tmp, { force: true })
    record('GitCode 安装包整包 sha512', false, `HTTP ${status}`)
  } else {
    const bytes = statSync(tmp).size
    const sha = createHash('sha512').update(readFileSync(tmp)).digest('base64')
    rmSync(tmp, { force: true })
    const sizeOk = !wantSize || bytes === wantSize
    record(
      'GitCode 安装包整包 sha512',
      sha === wantSha && sizeOk,
      `${bytes} B · ${sha === wantSha ? '摘要一致' : '摘要不一致'}`
    )
  }
}

// ── 输出 ────────────────────────────────────────────────
const width = Math.max(...checks.map((item) => item.name.length), 8)
console.log(`\nAurora Music 发布核对 · v${version}${githubProxy ? `（GitHub 走代理 ${githubProxy}）` : '（GitHub 直连）'}\n`)
for (const item of checks) {
  console.log(`  ${item.ok ? 'OK  ' : 'FAIL'}  ${item.name.padEnd(width)}  ${item.detail}`)
}

const failed = checks.filter((item) => !item.ok)
if (!failed.length) {
  console.log(`\n结论：GitHub 与主更新源都已指向 v${version}。\n`)
  process.exit(0)
}

console.log(`\n结论：${failed.length} 项不通过。`)
if (failed.some((item) => item.name.startsWith('GitCode'))) {
  console.log('主更新源没跟上时，本机补跑（需要 .env.local 里的 GITCODE_TOKEN）：')
  console.log('  1. 从 GitHub Release 取回 latest.yml + exe + blockmap 到 artifacts/（走代理快 8 倍）')
  console.log(`  2. REPO=${GITCODE_REPO} TAG=${wantTag} FILES_DIR=artifacts node scripts/publish-gitcode.mjs`)
  console.log('  3. 重新执行 npm run release:verify')
  console.log('细节见 docs/update-feed-setup.md「本机补跑」。\n')
}
process.exit(1)
