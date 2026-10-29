import { existsSync } from 'node:fs'
import { readFile, stat, mkdir, copyFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { providers } from './providers'
import { extractQQUin, getProviderCookies, setProviderCookies } from './providers/cookies'
import { catalog } from './services/catalog'
import { downloads } from './services/download'
import { library } from './services/library'
import { settings } from './services/settings'
import { cancelQrLogin, pollQrLogin, startQrLogin } from './services/qrlogin'
import { musicdl } from './engine/musicdl'
import type { DownloadTask, Song } from '@shared/types'

/**
 * 无界面集成自检。
 *
 * 覆盖四条链路：音源（搜索/取址/歌词）→ 下载（本地复制 / HTTP / 引擎）→
 * 落库（sidecar + 索引）→ 引擎（进程、搜索、取址）。
 *
 * 用法：AURORA_SELFTEST=1 electron out/main/index.js
 * 退出码：0 全部通过；1 有关键项失败。
 *
 * 网络相关项标记为 warn：平台接口随时可能变更或限流，不该让自检在没网时红灯，
 * 但一定要打印出来，方便判断「是代码坏了还是平台变了」。
 */

interface CheckResult {
  name: string
  ok: boolean
  critical: boolean
  detail: string
  ms: number
}

const results: CheckResult[] = []

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

async function check(name: string, critical: boolean, fn: () => Promise<string>): Promise<void> {
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, critical, detail, ms: Date.now() - started })
    log(`  PASS  ${name} — ${detail}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, critical, detail: message, ms: Date.now() - started })
    log(`  ${critical ? 'FAIL' : 'WARN'}  ${name} — ${message}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** 轮询等待任务进入终态 */
async function waitForTask(id: string, timeoutMs = 90_000): Promise<DownloadTask> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = downloads.list().find((item) => item.id === id)
    if (task && (task.status === 'done' || task.status === 'error' || task.status === 'canceled')) {
      return task
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const latest = downloads.list().find((item) => item.id === id)
  throw new Error(`任务超时（${latest?.status ?? 'unknown'} ${latest?.received ?? 0}B）`)
}

export async function runSelfTest(): Promise<number> {
  // 每次自检用独立的下载目录：否则上一轮留下的同名文件会让 enqueue 直接返回
  // 「已完成」，把这一轮真正要验证的下载/打标签链路跳过去。
  const runDir = join(app.getPath('temp'), 'aurora-selftest', `run-${Date.now()}`)
  await settings.set({ downloadDir: runDir })
  downloads.clearFinished()

  log('\n=== Aurora 集成自检 ===')
  log(`平台：${process.platform} · 下载目录：${settings.get().downloadDir}`)

  // ------------------------------------------------------------------ 音源
  log('\n[1/4] 音源层')
  let demoSong: Song | null = null

  await check('demo 搜索', true, async () => {
    const page = await providers.get('demo').search({ keyword: '', page: 1, limit: 10 })
    assert(page.items.length > 0, '内置演示音源没有返回曲目')
    demoSong = page.items[0]
    return `${page.items.length} 首，首曲《${page.items[0].name}》`
  })

  await check('demo 取播放地址', true, async () => {
    assert(demoSong, '缺少上一步的曲目')
    const stream = await providers.get('demo').resolveStream(demoSong, 'high')
    assert(stream.url.startsWith('muse://local'), `地址异常：${stream.url.slice(0, 40)}`)
    return `${stream.label} ${stream.format}`
  })

  await check('netease 搜索', false, async () => {
    const page = await providers.get('netease').search({ keyword: '稻香', page: 1, limit: 5 })
    assert(page.items.length > 0, '搜索结果为空（接口可能变更或被限流）')
    return `${page.items.length} 首，首曲《${page.items[0].name}》`
  })

  await check('netease 取播放地址', false, async () => {
    const page = await providers.get('netease').search({ keyword: '稻香', page: 1, limit: 3 })
    const song = page.items.find((item) => item.streamable !== false) ?? page.items[0]
    assert(song, '没有可测试的曲目')
    const stream = await providers.get('netease').resolveStream(song, 'high')
    assert(stream.directUrl, '直连地址缺失（下载会退化成代理地址，Node 无法 fetch）')
    return `${stream.label} → ${stream.directUrl!.slice(0, 60)}`
  })

  // 取址要三趟往返（取 URL → probe → 嗅探封装），缓存没命中就意味着上一首/循环播放
  // 每次都要重付一遍。用对象同一性判定，不依赖耗时，不会在慢机器上抖动。
  await check('取址缓存命中（同曲二次取址不再打上游）', false, async () => {
    const page = await providers.get('netease').search({ keyword: '晴天', page: 1, limit: 1 })
    const song = page.items[0]
    assert(song, '没有可测试的曲目')
    const first = await catalog.resolveTrack(song, false)
    const second = await catalog.resolveTrack(song, false)
    assert(first.stream === second.stream, '二次取址没有复用缓存结果')
    return `命中缓存，复用 ${first.stream.label}`
  })

  await check('netease 歌词', false, async () => {
    const page = await providers.get('netease').search({ keyword: '稻香', page: 1, limit: 1 })
    const song = page.items[0]
    assert(song, '没有可测试的曲目')
    const lyric = await catalog.lyric(song)
    assert(lyric && (lyric.lines.length || lyric.plain), '歌词为空')
    const words = lyric.lines.filter((line) => line.words?.length).length
    return `${lyric.lines.length} 行（${words} 行带字时间轴）/ ${lyric.source}`
  })

  await check('Cookie 登录态链路', false, async () => {
    // 填一段假 Cookie：验证设置→运行时仓库即时生效、uin 解析正确，
    // 且带 Cookie 的 QQ 歌词在拿不到 QRC 时优雅回落 LRC（不断链）。
    // 真实 QRC 逐字歌词需要用户自己的登录态，自检不内置账号，只验证链路。
    const before = settings.get()
    try {
      await settings.set({ qqCookie: 'uin=o0123456789; qm_keyst=FAKE; qqmusic_key=FAKE' })
      setProviderCookies({ qq: settings.get().qqCookie })
      assert(Boolean(getProviderCookies().qq), 'Cookie 没有进入运行时仓库')
      assert(extractQQUin() === '0123456789', `uin 解析错误：${extractQQUin()}`)
      const page = await providers.get('qq').search({ keyword: '稻香', page: 1, limit: 1 })
      const song = page.items[0]
      assert(song, '没有可测试的曲目')
      const lyric = await catalog.lyric(song)
      assert(lyric && (lyric.lines.length || lyric.plain), '带 Cookie 时歌词链路断裂')
      return `Cookie 已生效（uin 解析正确），歌词回落 ${lyric.source}`
    } finally {
      setProviderCookies({ qq: before.qqCookie })
      await settings.set({ qqCookie: before.qqCookie })
    }
  })

  // 扫码登录：真实创建二维码并轮询一轮（不实际扫码，验证到「等待扫码」即说明链路通）
  await check('扫码登录：QQ/网易云二维码创建与轮询', false, async () => {
    const results: string[] = []
    for (const platform of ['qq', 'netease'] as const) {
      const created = await startQrLogin(platform)
      assert(
        created.qrImage.startsWith('data:image/png;base64,'),
        `${platform} 二维码不是 PNG dataURL`
      )
      assert(created.expiresAt > Date.now(), `${platform} 过期时间异常`)
      const state = await pollQrLogin()
      assert(
        state.phase === 'pending' || state.phase === 'scanned',
        `${platform} 轮询状态异常：${state.phase} ${state.message}`
      )
      cancelQrLogin()
      results.push(`${platform}: ${state.phase}`)
    }
    return results.join(' / ')
  })

  // ------------------------------------------------------------------ 下载
  log('\n[2/4] 下载链路')
  await check('本地源下载（分块复制 + sidecar + 落库）', true, async () => {
    assert(demoSong, '缺少演示曲目')
    const task = downloads.enqueue(demoSong)
    const done = await waitForTask(task.id)
    assert(done.status === 'done', `状态 ${done.status}：${done.error ?? ''}`)
    assert(done.filePath && existsSync(done.filePath), '文件不存在')
    const size = (await stat(done.filePath)).size
    assert(size > 1000, `文件过小：${size}B`)
    const lrc = done.filePath.replace(/\.[^.]+$/, '.lrc')
    const meta = done.filePath.replace(/\.[^.]+$/, '.meta.json')
    assert(existsSync(lrc), '歌词 sidecar 缺失')
    assert(existsSync(meta), '元数据 sidecar 缺失')
    const record = library.findById(task.id)
    assert(record, '未登记进本地库')
    return `${(size / 1024).toFixed(0)}KB · ${record.ext} · 标签=${done.tagged ? '已写' : '跳过'}`
  })

  await check('下载队列落盘与恢复', true, async () => {
    await downloads.flush()
    const file = join(app.getPath('userData'), 'downloads.json')
    assert(existsSync(file), '队列文件未生成')
    const parsed = JSON.parse(await readFile(file, 'utf8')) as DownloadTask[]
    assert(Array.isArray(parsed) && parsed.length > 0, '队列文件为空')
    assert(
      parsed.some((item) => item.status === 'done'),
      '已完成任务没有持久化'
    )
    return `${parsed.length} 条记录`
  })

  await check('本地音源回放已下载文件', true, async () => {
    const page = await providers.get('local').search({ keyword: '', page: 1, limit: 5 })
    assert(page.items.length > 0, '本地库为空')
    const stream = await providers.get('local').resolveStream(page.items[0], 'high')
    assert(stream.url.startsWith('muse://local'), '本地地址异常')
    return `《${page.items[0].name}》${stream.label}`
  })

  await check('本地目录导入扫描', true, async () => {
    // 造一个「歌手 - 歌名.wav」的临时目录（含一层子目录，验证递归）。
    // demo 音频路径与 index.ts 的 resolveDemoDir 一样要多候选探测（getAppPath 因启动方式而异）
    const demoCandidates = [
      join(app.getAppPath(), 'resources', 'demo', 'neon.wav'),
      join(__dirname, '../../resources/demo', 'neon.wav'),
      join(process.cwd(), 'resources', 'demo', 'neon.wav')
    ]
    const demoWav = demoCandidates.find((path) => existsSync(path))
    assert(demoWav, '演示音频缺失')
    const importDir = join(app.getPath('temp'), 'aurora-selftest', 'music-import')
    // 自检目录跨轮复用：先清掉上一轮的残留，保证「新增 > 0」可重复断言
    await rm(importDir, { recursive: true, force: true })
    await library.remove(`local:${join(importDir, '子目录', '测试歌手 - 自检导入曲目.wav')}`)
    const subDir = join(importDir, '子目录')
    await mkdir(subDir, { recursive: true })
    const target = join(subDir, '测试歌手 - 自检导入曲目.wav')
    await copyFile(demoWav, target)
    assert(existsSync(target), '测试文件没有准备好')
    await settings.set({ musicDirs: [importDir] })
    library.setScanDirs([settings.get().downloadDir, importDir])
    const added = await library.scanLocalDirs()
    assert(added > 0, '没有扫描到导入的文件')
    const record = library.list().find((item) => item.id === `local:${target}`)
    assert(record, '导入的文件没有登记进库')
    assert(record.song.name === '自检导入曲目', `文件名解析错误：${record.song.name}`)
    assert(record.song.artists[0] === '测试歌手', `歌手解析错误：${record.song.artists[0]}`)
    const again = await library.scanLocalDirs()
    assert(again === 0, `重复扫描不幂等：又新增 ${again} 首`)
    return `新增 ${added} 首，曲名/歌手解析正确，重复扫描幂等`
  })

  await check('HTTP 直连下载（原生音源）', false, async () => {
    const page = await providers.get('netease').search({ keyword: '稻香', page: 1, limit: 3 })
    const song = page.items.find((item) => item.streamable !== false) ?? page.items[0]
    assert(song, '没有可下载的曲目')
    const task = downloads.enqueue(song)
    const done = await waitForTask(task.id, 120_000)
    assert(done.status === 'done', `${done.status}：${done.error ?? ''}`)
    assert(done.transport === 'http', `传输方式 ${done.transport}`)
    assert(done.filePath && existsSync(done.filePath), '文件不存在')
    return `${done.song.name} · ${(done.total / 1024 / 1024).toFixed(1)}MB · ${done.tagged ? '已写标签' : '未写标签'}`
  })

  // ------------------------------------------------------------------ 引擎
  log('\n[3/4] musicdl 引擎')
  await check('引擎启动', false, async () => {
    const status = await musicdl.restart()
    assert(status.ready, status.error || '引擎未就绪')
    assert(status.runtime, '运行时信息缺失')
    return `${status.runtime.label} · 运行时 ${status.runtime.version} · ${status.runtime.sources} 个音源`
  })

  // 各平台 CDN 的可达性因网络环境差异很大（例如酷狗在部分网络下 TLS 直接失败），
  // 依次尝试多个源，拿到第一个能用的即可，避免自检被单个平台的地域限制卡住。
  let enginePick: { platform: string; song: Song } | null = null

  await check('引擎搜索', false, async () => {
    const platforms = ['mdl-migu', 'mdl-kugou', 'mdl-qianqian', 'mdl-bodian', 'mdl-jamendo']
    const tried: string[] = []
    for (const platform of platforms) {
      try {
        const page = await catalog.search({ platform, keyword: '稻香', page: 1, limit: 3 })
        if (!page.items.length) {
          tried.push(`${platform}:空`)
          continue
        }
        const first = page.items[0]
        assert(first.extra?.token, '缺少 token，无法取址')
        enginePick = { platform, song: first }
        return `${platform} → ${page.items.length} 首，首曲《${first.name}》${first.qualityLabel ?? ''}`
      } catch (error) {
        tried.push(`${platform}:${(error as Error).message.slice(0, 40)}`)
      }
    }
    throw new Error(`所有候选音源都不可用（${tried.join(' / ')}）`)
  })

  await check('引擎流式搜索（边解析边返回）', false, async () => {
    assert(enginePick, '没有可用的引擎曲目')
    // 换个关键词避开缓存，否则拿到的是一次性返回的旧结果
    const marks: number[] = []
    const started = Date.now()
    const page = await catalog.search({
      platform: enginePick.platform,
      keyword: '夜曲',
      page: 1,
      limit: 6,
      onPartial: () => marks.push(Date.now() - started)
    })
    assert(page.items.length > 0, '没有搜索结果')
    assert(marks.length > 0, '没有收到任何增量结果')
    assert(marks[0] < Date.now() - started, '增量结果没有早于整体完成')
    return `首批 ${marks[0]}ms，共 ${marks.length} 批，合计 ${page.items.length} 首`
  })

  await check('引擎取址 + 代理地址', false, async () => {
    assert(enginePick, '没有可用的引擎曲目')
    const resolved = await catalog.resolveTrack(enginePick.song, false)
    assert(resolved.stream.url.startsWith('muse://'), '播放地址不是代理地址')
    assert(resolved.stream.directUrl?.startsWith('http'), '缺少直连地址')
    return `${resolved.stream.label} · ${resolved.stream.format}`
  })

  await check('引擎音源下载', false, async () => {
    assert(enginePick, '没有可用的引擎曲目')
    const task = downloads.enqueue(enginePick.song)
    const done = await waitForTask(task.id, 180_000)
    assert(done.status === 'done', `${done.status}：${done.error ?? ''}`)
    assert(done.filePath && existsSync(done.filePath), '文件不存在')
    return `《${done.song.name}》${(done.total / 1024 / 1024).toFixed(1)}MB · ${done.transport} · 标签=${
      done.tagged ? '已写' : '未写'
    }`
  })

  // ------------------------------------------------------------------ 汇总
  log('\n[4/4] 汇总')
  const failedCritical = results.filter((item) => !item.ok && item.critical)
  const warned = results.filter((item) => !item.ok && !item.critical)
  const passed = results.filter((item) => item.ok)

  log(
    `  通过 ${passed.length} / 共 ${results.length}，关键失败 ${failedCritical.length}，告警 ${warned.length}`
  )
  if (warned.length) {
    log('  告警项（多为平台限流/接口变更，不影响本地功能）：')
    for (const item of warned) log(`    - ${item.name}：${item.detail}`)
  }
  if (failedCritical.length) {
    log('  关键失败：')
    for (const item of failedCritical) log(`    - ${item.name}：${item.detail}`)
  }
  log('=== 自检结束 ===\n')

  return failedCritical.length ? 1 : 0
}
