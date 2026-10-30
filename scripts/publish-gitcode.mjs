/**
 * 把 Windows 更新资产同步到 GitCode（主更新源，GitHub 为备份）。
 *
 * GitCode 侧维护两类 release（2026-10-30 实测结论，见 docs/update-feed-setup.md）：
 *   1. 版本 release（tag=vX.Y.Z）：存放该版本三件套，供人下载；
 *   2. 指针 release（tag=stable）：同样放三件套，每次发版【覆盖】——
 *      同名附件重复 PUT 是覆盖而不是新增（副本数不变，实测），所以无需删除重建。
 *      应用更新器固定拉 releases/download/stable/<file>。
 * 不要用 tag 名 latest（会被解析成「当前 API latest」），
 * 也不要依赖 /releases/latest/download/ 别名（返回网页 HTML 而非文件）。
 *
 * 流程（官方 API）：
 *   1. GET /releases/tags/<tag> 看 release 是否存在，不存在则 POST 创建；
 *   2. 每个文件：GET /releases/<tag>/upload_url?file_name=… 拿预签名 OBS 地址；
 *   3. 按返回的 headers 原样 PUT 文件字节（对象存储回调自动登记附件）。
 *
 * 环境变量：GITCODE_TOKEN（私人令牌，repo+api 权限）、TAG、
 *          FILES_DIR（资产目录，默认 artifacts）。REPO 有默认值。
 * 失败抛非零退出码并输出 ::error::（发布 job 没有管理员日志权限，注解是唯一排障通道）。
 */

import fsSync from 'node:fs'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const API = 'https://api.gitcode.com/api/v5'
const REPO = process.env.REPO || 'dxhklck/aurora_music'
const TAG = process.env.TAG
const TOKEN = process.env.GITCODE_TOKEN
const DIR = process.env.FILES_DIR || 'artifacts'
/** 指针 release：更新器固定从这里拉（见 src/main/updater.ts 的 GITCODE_FEED） */
const POINTER_TAG = 'stable'

if (!TOKEN) fail('::error::缺 GITCODE_TOKEN 环境变量（GitHub Secrets 里配置 GitCode 私人令牌）')
if (!TAG) fail('::error::缺 TAG 环境变量')

/** 同步的文件：更新链路三件套；exe 用通配，名字随版本变 */
const SYNC_FILES = [
  /Aurora-Music-[\d.]+-x64\.exe$/,
  /Aurora-Music-[\d.]+-x64\.exe\.blockmap$/,
  /^latest\.yml$/
]

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { 'PRIVATE-TOKEN': TOKEN, ...(init.headers ?? {}) }
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function ensureRelease(tag, { pointer = false } = {}) {
  try {
    await api(`/repos/${REPO}/releases/tags/${tag}`)
    console.log(`release ${tag} 已存在`)
    return
  } catch {
    const body = pointer
      ? {
          tag_name: tag,
          name: '更新指针（勿下载）',
          body: '自动更新固定指向这里；内容随每个版本由 CI 覆盖，请从版本 release 下载安装包。',
          release_status: 'pre'
        }
      : {
          tag_name: tag,
          name: TAG,
          body: `Aurora Music ${TAG}\n\n详见 GitHub Release：https://github.com/dxhklck/aurora-music/releases/tag/${TAG}`,
          release_status: 'latest'
        }
    await api(`/repos/${REPO}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    console.log(`release ${tag} 已创建`)
  }
}

async function uploadOnce(tag, file, absPath) {
  const up = await api(`/repos/${REPO}/releases/${tag}/upload_url?file_name=${encodeURIComponent(file)}`)
  const body = new Uint8Array(await readFile(absPath))
  const res = await fetch(up.url, { method: 'PUT', headers: up.headers, body })
  if (!res.ok) {
    throw new Error(`PUT ${tag}/${file}: HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200))
  }
  return body.length
}

/** 单文件重试：110MB 的 exe 跨洋直传华为 OBS 偶发中断（v1.3.5 首跑的疑似死因），重试 2 次 */
async function upload(tag, file, absPath) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const size = await uploadOnce(tag, file, absPath)
      console.log(`已上传 ${tag}/${file}（${(size / 1048576).toFixed(1)} MB）${attempt > 1 ? `，第 ${attempt} 次尝试成功` : ''}`)
      return
    } catch (error) {
      lastError = error
      console.log(`上传 ${tag}/${file} 第 ${attempt} 次失败：${String(error).slice(0, 120)}`)
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 5000 * attempt))
    }
  }
  throw lastError
}

async function verify(tag, wanted) {
  const rel = await api(`/repos/${REPO}/releases/tags/${tag}`)
  const names = (rel.assets ?? []).map((a) => a.name)
  const missing = wanted.filter((a) => !names.includes(a))
  if (missing.length) {
    fail(`::error::${tag} 回查缺失: ${missing.join(', ')}（资产列表: ${names.join(', ')}）`)
  }
}

const assets = fsSync.readdirSync(DIR).filter((name) => SYNC_FILES.some((re) => re.test(name)))
if (!assets.length) fail(`::error::${DIR} 下没有匹配的更新资产`)
console.log('待同步:', assets.join(', '))

// 顶层统一兜底：任何异常都必须带着原因进 ::error:: 注解——发布 job 没有日志权限，
// 注解是排障的唯一通道（v1.3.5 首跑就因未捕获 401 静默退化为 exit 1 而无法定位）。
try {
  await ensureRelease(TAG)
  await ensureRelease(POINTER_TAG, { pointer: true })

  // 版本 release 与指针 release 各放一份；同名重复上传是覆盖，重跑安全
  for (const name of assets) {
    const absPath = path.join(DIR, name)
    await upload(TAG, name, absPath)
    await upload(POINTER_TAG, name, absPath)
  }

  await verify(TAG, assets)
  await verify(POINTER_TAG, assets)
  console.log('GitCode 同步完成')
} catch (error) {
  fail(`::error::GitCode 同步失败：${String(error).slice(0, 500)}`)
}
