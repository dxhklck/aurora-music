/**
 * 把 Windows 更新资产同步到 GitCode 的**公开资产仓库** `aurora_music_release`
 * （代码仓库 `aurora_music` 可以是私有的；GitHub Release 仍作备份）。
 *
 * 为什么单独一个仓库：GitCode 的资产下载口只认「仓库公开」——私有仓库时匿名下载
 * 一律 403，连 PRIVATE-TOKEN 头也无效（2026-10-31 实测三种令牌方式全 403）。
 * 而分发型客户端的更新源必须匿名可读，所以安装包与 latest.yml 拆出来。
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
import { createHash } from 'node:crypto'

// 双域名：api.gitcode.com 与 api.atomgit.com 同后端（官方说明数据互通）。
// GitHub Actions 的美国 runner 实测连不上 api.gitcode.com（fetch failed，疑似屏蔽海外云 IP），
// 备用域名多一条路；两个都失败时报错要带全原因。
const API_HOSTS = ['https://api.gitcode.com/api/v5', 'https://api.atomgit.com/api/v5']
const API = API_HOSTS[0]
// 默认投到**公开资产仓库**，不是代码仓库：私有仓库的 release 资产匿名下载 403，
// 而更新器必须匿名可读（详见 src/main/updater.ts 的 GITCODE_FEED 注释）。
const REPO = process.env.REPO || 'dxhklck/aurora_music_release'
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

async function apiOnce(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { 'PRIVATE-TOKEN': TOKEN, ...(init.headers ?? {}) }
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

/** API 调用：双域名各试一轮 + 每域名重试 2 次。网络层失败（fetch failed）与 5xx 都值得重试 */
async function api(pathname, init = {}) {
  let lastError
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 4000))
    const host = API_HOSTS[(attempt - 1) % API_HOSTS.length]
    try {
      return await apiOnce(pathname, init)
    } catch (error) {
      lastError = error
      const cause = error.cause ? `（${error.cause.code || error.cause.message}）` : ''
      console.log(`API 第 ${attempt} 次失败 [${host}]: ${String(error.message).slice(0, 100)}${cause}`)
    }
  }
  throw new Error(`API 连续 6 次失败 ${pathname}: ${lastError}`)
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

/** 删除旧附件记录：同 (tag, 文件名) 重复上传时，平台只会保留【第一次】的对象——
 *  后续 PUT 返回成功但下载内容不变（2026-10-30 实测：v1.3.6/latest.yml 传了 0.0.0
 *  再传 1.3.6，下载仍是 0.0.0）。所以「覆盖」必须先 DELETE 附件再重新上传。 */
async function deleteStaleAssets(tag, names, purgeAllAttach = false) {
  const rel = await api(`/repos/${REPO}/releases/tags/${tag}`)
  for (const asset of rel.assets ?? []) {
    if (asset.type !== 'attach') continue
    // 指针 release：清掉所有历史版本附件，只留本轮要传的三个
    if (!purgeAllAttach && !names.includes(asset.name)) continue
    const res = await fetch(`${API}/repos/${REPO}/releases/${tag}/attach_files/${asset.id}`, {
      method: 'DELETE',
      headers: { 'PRIVATE-TOKEN': TOKEN }
    })
    if (!res.ok && res.status !== 204) {
      throw new Error(`DELETE ${tag}/${asset.name}（id=${asset.id}）: HTTP ${res.status}`)
    }
    console.log(`已删除旧附件 ${tag}/${asset.name}（id=${asset.id}）`)
  }
}

/**
 * 清理指针 release 里「不属于本轮」的旧附件（上一版的 exe / blockmap / latest.yml）。
 * 只在全部上传与校验通过之后调用——顺序反了就会重演 v1.3.8 的事故：
 * 先把 stable 清空、再传 110MB 的 exe，一旦传输失败，主更新源直接变成空的。
 */
async function pruneOldAssets(tag, keep) {
  const rel = await api(`/repos/${REPO}/releases/tags/${tag}`)
  for (const asset of rel.assets ?? []) {
    if (asset.type !== 'attach' || keep.includes(asset.name)) continue
    const res = await fetch(`${API}/repos/${REPO}/releases/${tag}/attach_files/${asset.id}`, {
      method: 'DELETE',
      headers: { 'PRIVATE-TOKEN': TOKEN }
    })
    if (!res.ok && res.status !== 204) {
      throw new Error(`DELETE ${tag}/${asset.name}（id=${asset.id}）: HTTP ${res.status}`)
    }
    console.log(`已清理旧版本附件 ${tag}/${asset.name}`)
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

async function verify(tag, wanted, localFiles) {
  const rel = await api(`/repos/${REPO}/releases/tags/${tag}`)
  const names = (rel.assets ?? []).map((a) => a.name)
  const missing = wanted.filter((a) => !names.includes(a))
  if (missing.length) {
    fail(`::error::${tag} 回查缺失: ${missing.join(', ')}（资产列表: ${names.join(', ')}）`)
  }
  // 内容级校验：平台记录的 sha256 必须与本地文件一致——「同名覆盖」不生效的教训
  // 就是记录对但内容旧，只对名字发现不了
  for (const asset of rel.assets ?? []) {
    const absPath = localFiles.get(asset.name)
    if (!absPath || asset.type !== 'attach' || !asset.digest) continue
    const expect = 'sha256:' + createHash('sha256').update(await readFile(absPath)).digest('hex')
    if (asset.digest !== expect) {
      fail(`::error::${tag}/${asset.name} 内容校验失败：平台 ${asset.digest.slice(0, 20)}… ≠ 本地 ${expect.slice(0, 20)}…`)
    }
  }
}

// 顶层统一兜底：任何异常都必须带着原因进 ::error:: 注解——发布 job 没有日志权限，
// 注解是排障的唯一通道（v1.3.5 首跑就因未捕获异常静默退化为 exit 1 而无法定位）。
let assets
try {
  assets = fsSync.readdirSync(DIR).filter((name) => SYNC_FILES.some((re) => re.test(name)))
} catch (error) {
  fail(`::error::读取资产目录 ${DIR} 失败：${String(error).slice(0, 200)}`)
}
if (!assets.length) fail(`::error::${DIR} 下没有匹配的更新资产`)
console.log('待同步:', assets.join(', '))

try {
  await ensureRelease(TAG)
  await ensureRelease(POINTER_TAG, { pointer: true })

  // 带版本号的文件每次发版都是新名字，永远不会同名冲突；
  // 只有 latest.yml 是固定名，必须「先删旧记录再传」（重复 PUT 不会更新内容，
  // 见 deleteStaleAssets 的注释）。
  const versioned = assets.filter((name) => name !== 'latest.yml')
  const pointerFile = assets.filter((name) => name === 'latest.yml')

  // 版本 release：同名先删再传，保证重跑（比如重打 tag）时内容能刷新
  await deleteStaleAssets(TAG, assets, false)
  for (const name of [...versioned, ...pointerFile]) {
    await upload(TAG, name, path.join(DIR, name))
  }

  // 指针 release：先传新版本的安装包/差量包，此时旧 latest.yml 与旧 exe 都还在，
  // 更新器仍然可用；最后才替换 latest.yml，全部校验通过后再清理旧版本附件。
  for (const name of versioned) {
    await upload(POINTER_TAG, name, path.join(DIR, name))
  }
  if (pointerFile.length) {
    await deleteStaleAssets(POINTER_TAG, pointerFile, false)
    await upload(POINTER_TAG, pointerFile[0], path.join(DIR, pointerFile[0]))
  }

  const localFiles = new Map(assets.map((name) => [name, path.join(DIR, name)]))
  await verify(TAG, assets, localFiles)
  await verify(POINTER_TAG, assets, localFiles)
  await pruneOldAssets(POINTER_TAG, assets)
  console.log('GitCode 同步完成')
} catch (error) {
  fail(`::error::GitCode 同步失败：${String(error).slice(0, 500)}`)
}
