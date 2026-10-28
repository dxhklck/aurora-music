/**
 * 移动端 API 桥（Capacitor WebView）。
 *
 * 实现与 preload 相同的 AuroraApi 接口：桌面逻辑在 Electron 主进程，
 * 移动端把「纯 fetch 的音源适配器」直接搬进 WebView（netease/qq/kuwo
 * 均为 HTTP 实现，WebView fetch + CapacitorHttp 原生通道可用），
 * 持久化用 localStorage（后续 Cookie 类敏感项换 EncryptedSharedPreferences，C8）。
 *
 * 本期范围（C1 里程碑）：
 *   ✅ 音源列表 / 搜索 / 榜单 / 歌词 / 换源取址（netease + qq + kuwo）
 *   ✅ 设置持久化、歌单与收藏、登录态 Cookie 生效
 *   ⏳ 播放与封面依赖 muse:// 代理，待 C2 本地媒体服务接通
 *   ⏳ musicdl 引擎走 Chaquopy 原生（C4）；下载 / 本地库（C5/C7）；
 *      登录原生件（C6，weapi 的 node:crypto 依赖无法进 WebView）
 */

import type {
  AppSettings,
  CellphoneLoginArgs,
  CellphoneLoginResult,
  ChartSummary,
  DownloadTask,
  LibraryTrack,
  Lyric,
  NeteaseAccountInfo,
  Playlist,
  ProviderInfo,
  ResolvedTrack,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { FAVORITES_ID } from '@shared/types'
import { parseLrc } from '@shared/lyric'
import type { AuroraApi, SearchArgs } from '@shared/api'
import type { Quality } from '@shared/types'
import { Directory, Filesystem } from '@capacitor/filesystem'
// Buffer 垫片必须最先执行：音源适配器模块顶层就有 Buffer.from（qrc.ts 的 QRC_KEY）
import './buffer-shim'
import './abort-shim'
import type { MusicProvider, SearchArgs as ProviderSearchArgs } from '../../../main/providers/types'
import { MUSICDL_SOURCES, type SourceSpec } from '../../../main/providers/musicdl-sources'
import { md5Hex, wapiBody } from './weapi'

/* ------------------------------------------------------------------ *
 * C6：网易云手机号登录（纯 TS weapi，见 bridge/weapi.ts）
 * ------------------------------------------------------------------ */

const NETEASE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * 请求超时信号：手动 AbortController 实现。
 * 不能用 AbortSignal.timeout()——那是 Chrome 103+ 的 API，老 WebView（Android 9
 * 内核）上直接 TypeError，所有请求在发出前就炸掉（登录全挂的真凶）。
 */
function timeoutSignal(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), ms)
  return { signal: controller.signal, done: () => window.clearTimeout(timer) }
}

async function wapiPost(
  path: string,
  data: Record<string, unknown>
): Promise<{ json: Record<string, unknown> | null; cookieText: string }> {
  const body = await wapiBody(data)
  const timeout = timeoutSignal(15_000)
  let res: Response
  try {
    res = await fetch(`https://music.163.com${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com/',
        'User-Agent': NETEASE_UA
      },
      body: new URLSearchParams(body).toString(),
      signal: timeout.signal
    })
  } finally {
    timeout.done()
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  // CapacitorHttp 会把重复的 Set-Cookie 合并进一个响应头，正则按名取值不受合并影响
  const cookieText = res.headers.get('set-cookie') ?? ''
  return { json, cookieText }
}

function extractCookieValue(text: string, name: string): string {
  return new RegExp(`${name}=([^;,\\s]+)`).exec(text)?.[1] ?? ''
}

function loginErrorMessage(json: Record<string, unknown> | null, fallback: string): string {
  if (!json) return fallback
  const message = typeof json.message === 'string' ? json.message : ''
  if (message) return message
  const data = json.data as { msg?: string } | undefined
  if (data?.msg) return data.msg
  return `操作失败（code ${String(json.code ?? '未知')}）`
}

async function neteaseSendCaptcha(phone: string, countrycode: string): Promise<{ ok: boolean; message: string }> {
  if (!/^1\d{10}$/.test(phone.trim())) return { ok: false, message: '手机号格式不对' }
  // 注意是过去式 sent，/send 会返回「接口未找到」
  const { json } = await wapiPost('/weapi/sms/captcha/sent?csrf_token=', {
    cellphone: phone.trim(),
    ctcode: countrycode,
    captcha: ''
  })
  if (json?.code === 200) return { ok: true, message: '验证码已发送，注意查收短信' }
  return { ok: false, message: loginErrorMessage(json, '验证码发送失败') }
}

async function neteaseCellphoneLogin(args: CellphoneLoginArgs): Promise<CellphoneLoginResult> {
  const phone = args.phone.trim()
  const countrycode = args.countrycode || '86'
  if (!/^1\d{10}$/.test(phone)) return { ok: false, message: '手机号格式不对' }

  const byPassword = Boolean(args.password)
  if (!byPassword && !args.captcha) return { ok: false, message: '请输入验证码' }
  if (byPassword && (args.password ?? '').length < 6) return { ok: false, message: '密码太短' }

  // 验证码登录走 /w/login/cellphone，密码登录走 /login/cellphone（密码 md5）
  const path = byPassword ? '/weapi/login/cellphone' : '/weapi/w/login/cellphone'
  const data: Record<string, unknown> = { phone, countrycode, rememberLogin: 'true' }
  if (byPassword) data.password = md5Hex(args.password ?? '')
  else data.captcha = args.captcha

  const { json, cookieText } = await wapiPost(path, data)
  if (json?.code !== 200) return { ok: false, message: loginErrorMessage(json, '登录失败') }

  // Cookie 优先取 Set-Cookie（干净），退回响应体里的 cookie 字符串
  const musicU = extractCookieValue(cookieText, 'MUSIC_U')
  const csrf = extractCookieValue(cookieText, '__csrf')
  let cookie = ''
  if (musicU) {
    const parts = [`MUSIC_U=${musicU}`]
    if (csrf) parts.push(`__csrf=${csrf}`)
    parts.push('__remember_me=true')
    cookie = parts.join('; ')
  } else if (typeof json.cookie === 'string' && json.cookie.includes('MUSIC_U=')) {
    cookie = json.cookie
  }
  if (!cookie) return { ok: false, message: '登录成功但未拿到登录态，请重试' }

  const profile = json.profile as Record<string, unknown> | undefined
  const account = json.account as { id?: number } | undefined
  const info: NeteaseAccountInfo = {
    userId: Number(account?.id ?? profile?.userId ?? 0),
    nickname: typeof profile?.nickname === 'string' ? profile.nickname : '',
    avatarUrl: typeof profile?.avatarUrl === 'string' ? profile.avatarUrl : '',
    vipType: Number(profile?.vipType ?? 0)
  }
  // 落库 + 适配器即时生效（同进程，不需要 IPC 广播）
  settingsCache = { ...settingsCache, neteaseCookie: cookie, neteaseAccount: info }
  setProviderCookies({ qq: settingsCache.qqCookie, netease: cookie })
  persistSettings()
  broadcastSettings()
  return { ok: true, account: info }
}
import { ProviderError } from '../../../main/providers/types'
import { NeteaseProvider } from '../../../main/providers/netease'
import { QQProvider } from '../../../main/providers/qq'
import { KuwoProvider } from '../../../main/providers/kuwo'
import { setProviderCookies } from '../../../main/providers/cookies'
import { setMediaUrlRewriter, mediaUrl, localUrl } from '../../../main/media'

/* ------------------------------------------------------------------ *
 * C2 本地媒体代理 + C3 原生媒体面板（Capacitor 插件 AuroraMedia）
 * ------------------------------------------------------------------ */

type AuroraMediaPlugin = {
  proxyPort?: () => Promise<{ port: number }>
  session?: (info: Record<string, unknown>) => unknown
  /** C5：原生流式下载（HttpURLConnection 直写应用专属目录，边下边落盘） */
  download?: (args: { id: string; url: string; rel: string }) => Promise<{
    ok: boolean
    received?: number
    filePath?: string
    error?: string
  }>
  /** C6：应用内 WebView 登录（QQ 音乐），成功回传整段 Cookie */
  webLogin?: (args: { url: string; platform?: 'qq' | 'netease' }) => Promise<{ ok: boolean }>
  /** 查询原生 WebLoginActivity 落盘的登录态（轮询用，无 Cookie 时 cookie 为空串） */
  webLoginState?: () => Promise<{ cookie: string; ts?: number; error?: string }>
  downloadCancel?: (args: { id: string }) => Promise<unknown>
  /** 事件负载按监听名收窄（control: action；downloadProgress: id/received/total/done） */
  addListener?: (
    event: string,
    cb: (e: {
      action?: string
      id?: string
      received?: number
      total?: number
      done?: boolean
      error?: string
    }) => void
  ) => unknown
}

function auroraMediaPlugin(): AuroraMediaPlugin | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  return (cap?.Plugins?.AuroraMedia as AuroraMediaPlugin) ?? null
}

/**
 * C2：向原生层要代理端口，把 muse:// 改写为 http://127.0.0.1:<port>/media?u=&r=。
 * 代理不可用时静默跳过（播放不可用但应用不崩）。
 */
async function initMediaProxy(): Promise<void> {
  const media = auroraMediaPlugin()
  if (!media?.proxyPort) return
  try {
    const { port } = await media.proxyPort()
    const base = `http://127.0.0.1:${port}`
    setMediaUrlRewriter((url) =>
      url
        .replace('muse://media/?', `${base}/media?`)
        .replace('muse://local/?p=', `${base}/local?p=`)
    )
  } catch {
    /* 原生代理启动失败：保持 muse:// 原样 */
  }
}

/* ------------------------------------------------------------------ *
 * 音源注册（只注册 WebView 可用的原生适配器）
 * ------------------------------------------------------------------ */

const registry = new Map<string, MusicProvider>()

function register(provider: MusicProvider): void {
  registry.set(provider.info.id, provider)
}

register(new NeteaseProvider())
register(new QQProvider())
register(new KuwoProvider())

function getProvider(id: string): MusicProvider {
  const provider = registry.get(id)
  if (!provider) throw new ProviderError('unsupported', `未知音源：${id}`, id)
  return provider
}

/* ------------------------------------------------------------------ *
 * C4：musicdl 引擎（Chaquopy 原生承载，Kotlin 插件 AuroraEngine）
 * ------------------------------------------------------------------ */

interface EngineItem {
  id: string
  token: string
  name: string
  singers: string
  album: string
  ext: string
  durationMs: number
  sizeBytes: number
  bitrate: number
  coverUrl: string
  hasUrl: boolean
  protocol: string
}

type AuroraEnginePlugin = {
  status?: () => Promise<{ ready: boolean; runtime?: string; error?: string }>
  request?: (args: { payload: string }) => Promise<{ response: string }>
}

function enginePlugin(): AuroraEnginePlugin | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  return (cap?.Plugins?.AuroraEngine as AuroraEnginePlugin) ?? null
}

let engineStatusPromise: Promise<{ ready: boolean; runtime?: string; error?: string }> | null = null

function engineStatusOnce(): Promise<{ ready: boolean; runtime?: string; error?: string }> {
  engineStatusPromise ??=
    enginePlugin()?.status?.() ?? Promise.resolve({ ready: false, error: '引擎插件不可用' })
  return engineStatusPromise
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 引擎命令异构返回（search/resolve/lyric），按调用点收窄
async function engineRequest(cmd: string, params: unknown): Promise<any> {
  const plugin = enginePlugin()
  if (!plugin?.request) throw new ProviderError('unsupported', '引擎插件不可用', 'musicdl')
  const { response } = await plugin.request({ payload: JSON.stringify({ cmd, params }) })
  const frame = JSON.parse(response) as {
    ok: boolean
    result?: unknown
    error?: { code?: string; message?: string }
  }
  if (!frame.ok) {
    throw new ProviderError(
      (frame.error?.code as ProviderError['code']) ?? 'network',
      frame.error?.message ?? '引擎调用失败',
      'musicdl'
    )
  }
  return frame.result
}

const LOSSLESS_EXT = new Set(['flac', 'wav', 'ape', 'alac', 'dsf', 'dff', 'wv', 'tta'])
const NULLISH_TEXT = new Set(['null', 'none', 'nil', 'undefined', 'n/a', 'na'])

function cleanEngineText(value: string): string {
  const text = (value ?? '').trim()
  return NULLISH_TEXT.has(text.toLowerCase()) ? '' : text
}

function splitEngineArtists(singers: string): string[] {
  return cleanEngineText(singers)
    .split(/[/、,&;]| feat\.? | ft\.? /i)
    .map((item) => cleanEngineText(item))
    .filter(Boolean)
}

function engineQualityOf(ext: string, bitrate: number): Quality {
  if (LOSSLESS_EXT.has(ext)) return 'lossless'
  if (bitrate >= 256_000 || bitrate >= 256) return 'high'
  return 'standard'
}

function engineLabelOf(ext: string, bitrate: number): string {
  const kbps = bitrate > 10_000 ? Math.round(bitrate / 1000) : Math.round(bitrate)
  if (LOSSLESS_EXT.has(ext)) return `${ext.toUpperCase()} 无损`
  if (kbps > 0) return `${kbps}k ${ext.toUpperCase()}`
  return ext.toUpperCase()
}

class EngineProvider implements MusicProvider {
  readonly info: ProviderInfo

  constructor(private readonly spec: SourceSpec) {
    this.info = {
      id: `mdl-${spec.key}`,
      name: spec.name,
      short: spec.short,
      color: spec.color,
      gradient: spec.gradient,
      capabilities: { search: true, charts: false, stream: true, lyric: true },
      description: spec.description,
      note: spec.note ?? '由 musicdl 引擎提供（Chaquopy 原生承载）'
    }
  }

  async search(args: ProviderSearchArgs): Promise<SearchPage> {
    // 引擎每个结果都要解析真实地址，一页 10 条约 5-10 秒，强制收敛到 10（与桌面一致）
    const page = (await engineRequest('search', {
      source: this.spec.key,
      keyword: args.keyword.trim(),
      page: args.page ?? 1,
      limit: Math.min(args.limit ?? 10, 10)
    })) as { items: EngineItem[]; total: number; page: number; hasMore: boolean; cost?: number }
    return {
      items: page.items.map((item) => this.toSong(item)),
      total: page.total,
      page: page.page,
      hasMore: page.hasMore,
      cost: page.cost
    }
  }

  charts(): Promise<ChartSummary[]> {
    return Promise.resolve([])
  }

  chartDetail(): Promise<SearchPage> {
    return Promise.reject(new ProviderError('unsupported', '引擎音源无榜单', this.info.id))
  }

  private queryOf(song: Song): Record<string, unknown> {
    return {
      source: this.spec.key,
      token: typeof song.extra?.token === 'string' ? song.extra.token : undefined,
      name: song.name,
      artists: song.artists.join('/'),
      durationMs: song.duration,
      keyword: `${song.name} ${song.artists[0] ?? ''}`.trim()
    }
  }

  async resolveStream(song: Song, _quality: Quality): Promise<StreamInfo> {
    const resolved = (await engineRequest('resolve', this.queryOf(song))) as {
      url: string
      headers: Record<string, string>
      ext: string
      bitrate: number
      protocol: string
    }
    const format = (resolved.ext || 'mp3').toLowerCase()
    return {
      url: mediaUrl(resolved.url, this.spec.referer),
      directUrl: resolved.url,
      headers: resolved.headers ?? {},
      protocol: resolved.protocol === 'HLS' ? 'hls' : 'http',
      quality: engineQualityOf(format, resolved.bitrate),
      label: engineLabelOf(format, resolved.bitrate),
      format,
      expiresAt: Date.now() + 8 * 60_000
    }
  }

  async lyric(song: Song): Promise<Lyric | null> {
    try {
      const { lyric } = (await engineRequest('lyric', this.queryOf(song))) as { lyric: string }
      if (!lyric?.trim()) return null
      const parsed = parseLrc(lyric)
      if (parsed.lines.length) {
        return { lines: parsed.lines, offset: parsed.offset, translated: false, source: this.info.name }
      }
      return { lines: [], offset: 0, translated: false, source: this.info.name, plain: lyric }
    } catch {
      return null // 歌词失败不影响播放，上层走 LRCLIB 兜底
    }
  }

  private toSong(item: EngineItem): Song {
    return {
      id: item.id,
      platform: this.info.id,
      name: item.name,
      artists: splitEngineArtists(item.singers),
      album: cleanEngineText(item.album),
      coverUrl: item.coverUrl ? mediaUrl(item.coverUrl, this.spec.referer) : null,
      duration: item.durationMs,
      fileSize: item.sizeBytes || undefined,
      qualityLabel: item.ext ? engineLabelOf(item.ext, item.bitrate) : undefined,
      qualityMax: item.ext ? engineQualityOf(item.ext, item.bitrate) : undefined,
      streamable: item.hasUrl,
      extra: { token: item.token, ext: item.ext, protocol: item.protocol, engine: this.spec.key }
    }
  }
}

/** 引擎音源注册开关（设置 engineEnabled 变化时增删，重启兜底） */
function setEngineProviders(enabled: boolean): void {
  for (const spec of MUSICDL_SOURCES) {
    const id = `mdl-${spec.key}`
    if (enabled) {
      if (!registry.has(id)) registry.set(id, new EngineProvider(spec))
    } else {
      registry.delete(id)
    }
  }
}

/* ------------------------------------------------------------------ *
 * C5：下载服务（fetch 流经本地代理 → Filesystem 分块落盘）
 * C7-lite：本地库（下载完成即入库，localStorage 记录 + /local 代理播放）
 * 注：C7 的 MediaStore 全盘扫描仍属后续工作，这里先承载「已下载曲目」
 * ------------------------------------------------------------------ */

const LIBRARY_KEY = 'aurora.library'

function loadLibrary(): LibraryTrack[] {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY)
    return raw ? (JSON.parse(raw) as LibraryTrack[]) : []
  } catch {
    return []
  }
}

let libraryCache = loadLibrary()

function persistLibrary(): LibraryTrack[] {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(libraryCache))
  return libraryCache
}

function bytesToBase64Local(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

class LocalProvider implements MusicProvider {
  readonly info: ProviderInfo = {
    id: 'local',
    name: '本地音乐',
    short: '本地',
    color: '#3fb6ff',
    gradient: ['#4facfe', '#0f3f66'],
    capabilities: { search: true, charts: false, stream: true, lyric: true },
    description: '已下载到本地的曲目，离线可播'
  }

  async search(args: ProviderSearchArgs): Promise<SearchPage> {
    const key = args.keyword.trim().toLowerCase()
    const matched = key
      ? libraryCache.filter(
          (item) =>
            item.song.name.toLowerCase().includes(key) ||
            item.song.album.toLowerCase().includes(key) ||
            item.song.artists.join(' ').toLowerCase().includes(key)
        )
      : libraryCache
    const start = (args.page - 1) * args.limit
    return {
      items: matched.slice(start, start + args.limit).map((item) => ({
        ...item.song,
        id: item.id,
        platform: 'local',
        qualityLabel: item.qualityLabel ?? item.ext.toUpperCase(),
        extra: { ...(item.song.extra ?? {}), filePath: item.filePath }
      })),
      total: matched.length,
      page: args.page,
      hasMore: start + args.limit < matched.length
    }
  }

  charts(): Promise<ChartSummary[]> {
    return Promise.resolve([])
  }

  chartDetail(): Promise<SearchPage> {
    return Promise.reject(new ProviderError('unsupported', '本地音乐无榜单', 'local'))
  }

  async resolveStream(song: Song, _quality: Quality): Promise<StreamInfo> {
    const record = libraryCache.find((item) => item.id === song.id)
    const filePath = record?.filePath ?? String(song.extra?.filePath ?? '')
    if (!filePath) throw new ProviderError('empty', '本地文件记录不存在', 'local')
    return {
      url: localUrl(filePath),
      quality: 'lossless',
      label: record?.qualityLabel ?? '本地文件',
      format: record?.ext ?? 'mp3',
      expiresAt: Number.MAX_SAFE_INTEGER
    }
  }

  lyric(): Promise<null> {
    return Promise.resolve(null)
  }
}

register(new LocalProvider())

/* ---------------- 下载队列 ---------------- */

const downloadTasks = new Map<string, DownloadTask>()
const downloadControllers = new Map<string, AbortController>()
const downloadQueue: string[] = []
/** 任务开始下载的时间（速度计算基准；任务模型无此字段，桌面版在主进程自持） */
const downloadStartAt = new Map<string, number>()

function emitDownloads(): void {
  const list = [...downloadTasks.values()].map((task) => ({ ...task }))
  for (const listener of downloadProgressListeners) listener(list)
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
}

/* 原生下载进度事件：Kotlin 侧边下边发，这里只更新任务模型与节流广播 */
let downloadProgressBound = false

function bindNativeDownloadProgress(): void {
  const plugin = auroraMediaPlugin()
  if (!plugin?.addListener || downloadProgressBound) return
  downloadProgressBound = true
  plugin.addListener('downloadProgress', (event: {
    id?: string
    received?: number
    total?: number
    done?: boolean
    error?: string
  }) => {
    const task = event.id ? downloadTasks.get(event.id) : undefined
    if (!task || task.status !== 'downloading') return
    if (typeof event.total === 'number' && event.total > 0) task.total = event.total
    if (typeof event.received === 'number') {
      task.received = event.received
      task.progress = task.total ? Math.min(task.received / task.total, 1) : -1
      const startedAt = downloadStartAt.get(event.id ?? '') ?? task.createdAt
      const elapsed = (Date.now() - startedAt) / 1000
      if (elapsed > 0.5) task.speed = Math.round(task.received / elapsed)
    }
    emitThrottled(task.id)
  })
}

let lastEmitAt = 0

function emitThrottled(_id: string): void {
  const now = Date.now()
  if (now - lastEmitAt < 400) return
  lastEmitAt = now
  emitDownloads()
}

async function runDownloadTask(id: string): Promise<void> {
  const task = downloadTasks.get(id)
  if (!task) return
  task.status = 'downloading'
  task.attempt += 1
  downloadStartAt.set(id, Date.now())
  emitDownloads()
  const controller = new AbortController()
  downloadControllers.set(id, controller)
  const native = auroraMediaPlugin()
  try {
    // 音源解析（不走自动换源，失败直接报错由用户重试）
    const stream = await getProvider(task.song.platform).resolveStream(task.song, settingsCache.quality)
    const filename = sanitizeFilename(
      `${task.song.name} - ${task.song.artists[0] ?? '未知歌手'}.${stream.format || 'mp3'}`
    )
    const relPath = `Aurora/${filename}`
    let absPath = ''

    let received = 0
    if (native?.download) {
      // 主路径：原生 HttpURLConnection 流式写盘，进度经 downloadProgress 事件回推。
      // 只传相对路径，由原生解析到应用专属目录（免存储权限、路径确定）；
      // 不走 WebView fetch——CapacitorHttp 接管后响应全量缓冲，大文件内存爆、进度/取消全失效。
      const result = await native.download({ id, url: stream.url, rel: relPath })
      received = result.received ?? 0
      if (!result.ok) throw new Error(result.error ?? '下载失败')
      absPath = result.filePath ?? ''
      task.total = task.total || received
    } else {
      // 兜底：fetch 流式读取（无原生插件的环境，如纯 Web 调试）
      await Filesystem.writeFile({ path: relPath, data: '', directory: Directory.Documents, recursive: true })
      const res = await fetch(stream.url, { signal: controller.signal })
      if (!res.ok) throw new Error(`下载源返回 ${res.status}`)
      task.total = Number(res.headers.get('content-length') || 0)
      emitDownloads()
      const reader = res.body?.getReader()
      if (!reader) throw new Error('环境不支持流式读取')
      let lastEmit = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value?.length) {
          received += value.length
          await Filesystem.appendFile({
            path: relPath,
            data: bytesToBase64Local(value),
            directory: Directory.Documents
          })
          task.received = received
          task.progress = task.total ? Math.min(received / task.total, 1) : -1
          const elapsed = (Date.now() - (downloadStartAt.get(id) ?? Date.now())) / 1000
          if (elapsed > 0.5) task.speed = Math.round(received / elapsed)
          const now = Date.now()
          if (now - lastEmit > 400) {
            lastEmit = now
            emitDownloads()
          }
        }
      }
    }
    if (task.total && received < task.total) throw new Error(`下载不完整（${received}/${task.total}）`)
    if (!absPath) throw new Error('未获得下载文件路径')

    task.status = 'done'
    task.progress = 1
    task.received = received
    task.total = task.total || received
    task.filePath = absPath
    task.finishedAt = Date.now()
    task.tagged = false

    // 入本地库（C7-lite）：下次启动离线可播
    libraryCache = [
      {
        id: `${task.song.platform}:${task.song.id}`,
        song: task.song,
        filePath: task.filePath,
        fileName: filename,
        size: received,
        ext: stream.format || 'mp3',
        qualityLabel: stream.label,
        downloadedAt: Date.now()
      },
      ...libraryCache.filter((item) => item.id !== `${task.song.platform}:${task.song.id}`)
    ]
    persistLibrary()
  } catch (error) {
    // cancelDownload 可能在外部已把状态改成 canceled（TS 看不到跨协程写入，走 map 重新读）
    if (downloadTasks.get(id)?.status === 'canceled') return
    task.status = 'error'
    task.error = error instanceof Error ? error.message : String(error)
    task.finishedAt = Date.now()
  } finally {
    downloadControllers.delete(id)
    downloadStartAt.delete(id)
    emitDownloads()
  }
}

function pumpDownloadQueue(): void {
  const concurrency = Math.max(1, settingsCache.downloadConcurrency || 2)
  const active = [...downloadTasks.values()].filter((task) => task.status === 'downloading').length
  let slots = concurrency - active
  while (slots > 0 && downloadQueue.length) {
    const id = downloadQueue.shift() as string
    const task = downloadTasks.get(id)
    if (!task || task.status !== 'queued') continue
    void runDownloadTask(id)
    slots -= 1
  }
}

/* ------------------------------------------------------------------ *
 * 设置持久化（localStorage）
 * ------------------------------------------------------------------ */

const SETTINGS_KEY = 'aurora.settings'
const PLAYLISTS_KEY = 'aurora.playlists'

const DEFAULT_SETTINGS: AppSettings = {
  // 桌面默认 demo 音源不在移动端注册表里，默认落到网易云
  platform: 'netease',
  quality: 'high',
  volume: 0.75,
  playMode: 'loop',
  downloadDir: '',
  musicDirs: [],
  searchLimit: 30,
  autoSwitchSource: true,
  desktopLyricLocked: false,
  desktopLyricMode: 'mini',
  nowPlayingStyle: 'vinyl',
  playerTheme: 'aurora',
  themeMode: 'dark',
  downloadConcurrency: 2,
  downloadRetries: 3,
  writeTags: true,
  // 引擎音源默认开启：移动端匿名搜索/下载的主要通路（Chaquopy 引擎随包内置）。
  // 此前默认 false 且设置未持久化时模块初始化即跳过注册，表现为「下载无反应」。
  engineEnabled: true,
  closeToTray: true,
  pythonPath: '',
  qqCookie: '',
  neteaseCookie: '',
  neteaseAccount: null,
  miniMode: false,
  windowBounds: {}
}

let settingsCache: AppSettings = loadSettings()

/* C8：敏感字段不再明文进 localStorage，改存原生 EncryptedSharedPreferences */
const SECURE_KEYS = ['qqCookie', 'neteaseCookie', 'neteaseAccount'] as const

function securePlugin(): {
  secureSet?: (args: { key: string; value: string }) => Promise<unknown>
  secureGet?: (args: { key: string }) => Promise<{ value: string | null }>
} | null {
  return auroraMediaPlugin() as never
}

/** 启动时从加密存储恢复 Cookie/账号（异步，恢复完成广播刷新 UI） */
async function loadSecrets(): Promise<void> {
  const p = securePlugin()
  if (!p?.secureGet) return
  try {
    for (const key of SECURE_KEYS) {
      const { value } = await p.secureGet({ key })
      if (value == null) continue
      if (key === 'neteaseAccount') {
        try {
          settingsCache.neteaseAccount = JSON.parse(value) as AppSettings['neteaseAccount']
        } catch {
          /* 坏数据忽略 */
        }
      } else {
        settingsCache[key] = value
      }
    }
    if (settingsCache.qqCookie || settingsCache.neteaseCookie) {
      setProviderCookies({ qq: settingsCache.qqCookie, netease: settingsCache.neteaseCookie })
    }
  } catch {
    /* 加密存储不可用时保持现状 */
  } finally {
    // 无论是否恢复到凭据都广播一次：监听者（设置页账号卡片）可能晚于本次恢复才挂上，
    // 由 getSettings 快照兜底之外再补一次推送
    broadcastSettings()
  }
}

function persistSecrets(): void {
  const p = securePlugin()
  if (!p?.secureSet) return
  for (const key of SECURE_KEYS) {
    const value = settingsCache[key]
    const text = key === 'neteaseAccount' ? JSON.stringify(value ?? null) : String(value ?? '')
    void p.secureSet({ key, value: text })
  }
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function persistSettings(): AppSettings {
  // 敏感字段剥离后才落 localStorage（C8），明文不再落盘
  const plain = { ...settingsCache } as Record<string, unknown>
  for (const key of SECURE_KEYS) plain[key] = undefined
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(plain))
  persistSecrets()
  return { ...settingsCache }
}

type SettingsListener = (settings: AppSettings) => void
const settingsListeners = new Set<SettingsListener>()

function broadcastSettings(): void {
  for (const listener of settingsListeners) listener({ ...settingsCache })
}

/** 登录态 Cookie 初始化：localStorage 里存过就直接生效 */
if (settingsCache.qqCookie || settingsCache.neteaseCookie) {
  setProviderCookies({ qq: settingsCache.qqCookie, netease: settingsCache.neteaseCookie })
}

/** C4：设置里开了引擎音源就注册（EngineProvider 在上方定义，此处已可安全引用） */
if (settingsCache.engineEnabled) setEngineProviders(true)

/** C8：从原生加密存储恢复凭据（localStorage 里已不再保存明文） */
const secretsReady = loadSecrets()

/* ------------------------------------------------------------------ *
 * 歌单 / 收藏（localStorage）
 * ------------------------------------------------------------------ */

const keyOf = (song: Song): string => `${song.platform}:${song.id}`

function dedupe(songs: Song[]): Song[] {
  const seen = new Set<string>()
  const result: Song[] = []
  for (const song of songs) {
    if (!song?.id || !song.platform) continue
    const key = keyOf(song)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
  }
  return result
}

function loadPlaylists(): Playlist[] {
  try {
    const raw = localStorage.getItem(PLAYLISTS_KEY)
    const list = raw ? (JSON.parse(raw) as Playlist[]) : []
    if (list.some((item) => item.id === FAVORITES_ID)) return list
    return [
      {
        id: FAVORITES_ID,
        name: '我喜欢',
        builtin: true,
        songs: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      ...list
    ]
  } catch {
    return []
  }
}

function persistPlaylists(list: Playlist[]): Playlist[] {
  localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(list))
  return list
}

let playlistsCache = loadPlaylists()

/* ------------------------------------------------------------------ *
 * 简化版目录逻辑（搜索 / 歌词 / 换源取址）
 * ------------------------------------------------------------------ */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_（）()【】[\]·,，.。'’!！?？]/g, '')
}

interface LrclibItem {
  trackName: string
  artistName: string
  duration: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

async function fetchLrclib(song: Song): Promise<Lyric | null> {
  const artist = song.artists[0] ?? ''
  const headers = { 'User-Agent': 'AuroraMusic/1.0 (mobile player)' }
  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: song.name })
    if (song.duration) params.set('duration', String(Math.round(song.duration / 1000)))
    const timeout = timeoutSignal(8_000)
    let response: Response
    try {
      response = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers,
        signal: timeout.signal
      })
    } finally {
      timeout.done()
    }
    if (response.ok) {
      const lyric = toLyric((await response.json()) as LrclibItem)
      if (lyric) return lyric
    }
  } catch {
    /* 落到搜索接口 */
  }
  try {
    const timeout = timeoutSignal(8_000)
    let response: Response
    try {
      response = await fetch(
        `https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${song.name}` }).toString()}`,
        { headers, signal: timeout.signal }
      )
    } finally {
      timeout.done()
    }
    if (!response.ok) return null
    const list = (await response.json()) as LrclibItem[]
    if (!Array.isArray(list) || !list.length) return null
    return toLyric(list[0])
  } catch {
    return null
  }
}

function toLyric(item: LrclibItem): Lyric | null {
  if (item.syncedLyrics) {
    const parsed = parseLrc(item.syncedLyrics)
    if (parsed.lines.length) {
      return { lines: parsed.lines, offset: parsed.offset, translated: false, source: 'LRCLIB' }
    }
  }
  if (item.plainLyrics) {
    return { lines: [], offset: 0, translated: false, source: 'LRCLIB', plain: item.plainLyrics }
  }
  return null
}

const lyricCache = new Map<string, Lyric | null>()

async function lyric(song: Song): Promise<Lyric | null> {
  const key = `${song.platform}:${song.id}`
  if (lyricCache.has(key)) return lyricCache.get(key) ?? null
  let result: Lyric | null = null
  try {
    result = await getProvider(song.platform).lyric(song)
  } catch {
    result = null
  }
  if (!result || !result.lines.length) result = await fetchLrclib(song)
  lyricCache.set(key, result)
  return result
}

/** 换源：与主进程 catalog.findAlternative 同思路的简化版（最多试 3 个候选） */
async function findAlternative(song: Song): Promise<{ song: Song; stream: StreamInfo } | null> {
  const keyword = song.name.trim()
  if (!keyword) return null
  const candidates = [...registry.values()]
    .filter(
      (item) =>
        item.info.id !== song.platform && item.info.capabilities.stream && item.info.capabilities.search
    )
    // 引擎源优先：musicdl（酷狗/咪咕等）免登录且返回完整直链；
    // 换到未登录的网易云/QQ 只会拿到 30s 试听片段（真机实测）。
    .sort((a, b) => {
      const rank = (id: string): number => (id.startsWith('mdl-') ? 0 : 1)
      return rank(a.info.id) - rank(b.info.id)
    })
  const deadline = Date.now() + 12_000
  let tried = 0
  for (const candidate of candidates) {
    if (tried >= 3 || Date.now() > deadline) break
    tried += 1
    try {
      const page = await candidate.search({ keyword, page: 1, limit: 8 })
      const targetName = normalize(song.name)
      const targetArtists = song.artists.map(normalize)
      let match: Song | null = null
      let bestScore = 0
      for (const item of page.items) {
        const name = normalize(item.name)
        if (!(name === targetName || (name.includes(targetName) || targetName.includes(name)))) continue
        let score = name === targetName ? 60 : 35
        const artists = item.artists.map(normalize)
        if (artists.some((a) => targetArtists.some((t) => a.includes(t) || t.includes(a)))) score += 30
        if (score > bestScore) {
          bestScore = score
          match = item
        }
      }
      if (!match || bestScore < 70) continue
      const stream = await candidate.resolveStream(match, settingsCache.quality)
      return { song: match, stream }
    } catch {
      /* 该平台也不可用，继续 */
    }
  }
  return null
}

async function resolveTrack(args: {
  song: Song
  autoSwitch: boolean
  forceSwitch?: boolean
}): Promise<ResolvedTrack> {
  const { song } = args
  const provider = getProvider(song.platform)
  try {
    const stream = await provider.resolveStream(song, settingsCache.quality)
    return { song, stream }
  } catch (error) {
    if (!args.autoSwitch) {
      throw error instanceof ProviderError
        ? error
        : new ProviderError('network', `${provider.info.name}：${String(error)}`, provider.info.id)
    }
    const alternative = await findAlternative(song)
    if (!alternative) {
      throw error instanceof ProviderError
        ? error
        : new ProviderError('network', `${provider.info.name}：${String(error)}`, provider.info.id)
    }
    return {
      song: alternative.song,
      stream: alternative.stream,
      switchedFrom: song.platform,
      notice: `原音源无法播放，已自动切换到 ${getProvider(alternative.song.platform).info.name}`
    }
  }
}

/* ------------------------------------------------------------------ *
 * AuroraApi 实现
 * ------------------------------------------------------------------ */

function unsupported(name: string): never {
  throw new Error(`${name} 功能在移动端开发中，敬请期待`)
}

type SearchPartialListener = (payload: { streamId: string; items: Song[] }) => void
const searchPartialListeners = new Set<SearchPartialListener>()
const downloadProgressListeners = new Set<(tasks: DownloadTask[]) => void>()

type LoginWindowResult = { platform: 'qq' | 'netease'; ok: boolean; message: string }
const loginWindowResultListeners = new Set<(result: LoginWindowResult) => void>()

function createApi(): AuroraApi {
  return {
    platform: /Android/i.test(navigator.userAgent) ? 'android' : 'web',

    providers(): Promise<ProviderInfo[]> {
      return Promise.resolve([...registry.values()].map((item) => item.info))
    },
    search(args: SearchArgs): Promise<SearchPage> {
      const provider = getProvider(args.platform)
      return provider.search({
        keyword: args.keyword.trim(),
        page: args.page ?? 1,
        limit: Math.min(Math.max(args.limit ?? settingsCache.searchLimit, 1), 50)
      })
    },
    onSearchPartial(cb) {
      searchPartialListeners.add(cb)
      return () => searchPartialListeners.delete(cb)
    },
    charts(platform: string): Promise<ChartSummary[]> {
      const provider = getProvider(platform)
      return provider.info.capabilities.charts ? provider.charts() : Promise.resolve([])
    },
    chartDetail(args) {
      return getProvider(args.platform).chartDetail({
        id: args.id,
        page: args.page ?? 1,
        limit: args.limit ?? 40
      })
    },
    lyric,
    resolveTrack,
    coverResolve(): Promise<string | null> {
      // C2 媒体服务接通后再启用（封面代理也走 muse://）
      return Promise.resolve(null)
    },

    enqueueDownload(song: Song): Promise<DownloadTask> {
      const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const task: DownloadTask = {
        id,
        song,
        status: 'queued',
        progress: -1,
        received: 0,
        total: 0,
        speed: 0,
        attempt: 0,
        createdAt: Date.now(),
        transport: 'http'
      }
      downloadTasks.set(id, task)
      downloadQueue.push(id)
      pumpDownloadQueue()
      emitDownloads()
      return Promise.resolve({ ...task })
    },
    enqueueDownloads(songs: Song[]): Promise<DownloadTask[]> {
      const tasks = songs.map((song) => ({
        id: `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        song,
        status: 'queued' as const,
        progress: -1,
        received: 0,
        total: 0,
        speed: 0,
        attempt: 0,
        createdAt: Date.now(),
        transport: 'http' as const
      }))
      for (const task of tasks) {
        downloadTasks.set(task.id, task)
        downloadQueue.push(task.id)
      }
      pumpDownloadQueue()
      emitDownloads()
      return Promise.resolve(tasks.map((task) => ({ ...task })))
    },
    listDownloads(): Promise<DownloadTask[]> {
      return Promise.resolve([...downloadTasks.values()].map((task) => ({ ...task })))
    },
    async cancelDownload(id: string): Promise<void> {
      const task = downloadTasks.get(id)
      if (!task) return
      if (task.status === 'queued') {
        task.status = 'canceled'
        task.finishedAt = Date.now()
      } else if (task.status === 'downloading') {
        task.status = 'canceled'
        task.finishedAt = Date.now()
        downloadControllers.get(id)?.abort()
        // 原生下载走插件侧取消（fetch abort 对原生流无效）
        void auroraMediaPlugin()
          ?.downloadCancel?.({ id })
          .catch(() => undefined)
      }
      emitDownloads()
    },
    retryDownload(id: string): Promise<void> {
      const task = downloadTasks.get(id)
      if (!task || task.status !== 'error') return Promise.resolve()
      task.status = 'queued'
      task.progress = -1
      task.received = 0
      task.total = 0
      task.error = undefined
      downloadQueue.push(id)
      pumpDownloadQueue()
      emitDownloads()
      return Promise.resolve()
    },
    retryFailedDownloads(): Promise<number> {
      const failed = [...downloadTasks.values()].filter((task) => task.status === 'error')
      for (const task of failed) {
        task.status = 'queued'
        task.progress = -1
        task.received = 0
        task.total = 0
        task.error = undefined
        downloadQueue.push(task.id)
      }
      pumpDownloadQueue()
      emitDownloads()
      return Promise.resolve(failed.length)
    },
    removeDownload(id: string): Promise<void> {
      const task = downloadTasks.get(id)
      if (task?.status === 'downloading') {
        task.status = 'canceled'
        downloadControllers.get(id)?.abort()
        void auroraMediaPlugin()
          ?.downloadCancel?.({ id })
          .catch(() => undefined)
      }
      downloadTasks.delete(id)
      emitDownloads()
      return Promise.resolve()
    },
    clearDownloads(): Promise<void> {
      for (const [id, task] of downloadTasks) {
        if (task.status === 'downloading') {
          task.status = 'canceled'
          downloadControllers.get(id)?.abort()
          void auroraMediaPlugin()
            ?.downloadCancel?.({ id })
            .catch(() => undefined)
        }
        downloadTasks.delete(id)
      }
      downloadQueue.length = 0
      emitDownloads()
      return Promise.resolve()
    },
    openDownload(): Promise<void> {
      return unsupported('打开下载文件')
    },
    revealDownload(): Promise<void> {
      return unsupported('定位下载文件')
    },
    downloadDir(): Promise<string> {
      // Android 上固定写入应用专属 Documents 目录（无需存储权限）
      return Promise.resolve('Android/data/com.aurora.music/files/Documents/Aurora')
    },
    chooseDownloadDir(): Promise<string> {
      return unsupported('自定义下载目录（移动端固定写入应用音乐目录）')
    },

    engineStatus() {
      return engineStatusOnce().then((state) => ({
        ready: state.ready,
        runtime: state.ready
          ? { command: 'chaquopy', label: '内置 CPython 3.13（Chaquopy）', sources: MUSICDL_SOURCES.length }
          : null,
        error: state.error ?? '',
        log: [] as string[],
        bridgeFound: state.ready,
        musicdlFound: state.ready,
        packaged: true
      }))
    },
    engineRestart() {
      engineStatusPromise = null
      return this.engineStatus()
    },
    engineChoosePython(): Promise<never> {
      return unsupported('引擎解释器选择')
    },
    engineRepairVendor() {
      return this.engineStatus()
    },

    listLibrary(): Promise<LibraryTrack[]> {
      return Promise.resolve(libraryCache.map((item) => ({ ...item })))
    },
    async removeLibrary(id: string): Promise<void> {
      const record = libraryCache.find((item) => item.id === id)
      libraryCache = libraryCache.filter((item) => item.id !== id)
      persistLibrary()
      if (record?.filePath) {
        // 文件在应用专属目录内，随记录一起清理；失败不阻塞
        try {
          const dir = record.filePath.includes('/files/Documents/') ? Directory.Documents : Directory.Data
          const rel = record.filePath.split('/files/Documents/')[1] ?? record.filePath
          await Filesystem.deleteFile({ path: rel, directory: dir })
        } catch {
          /* 文件可能已被系统清理 */
        }
      }
    },
    refreshLibrary(): Promise<LibraryTrack[]> {
      return Promise.resolve(libraryCache.map((item) => ({ ...item })))
    },
    revealLibrary(): Promise<void> {
      return unsupported('定位本地文件')
    },
    importMusicDir(): Promise<string[]> {
      return unsupported('本地目录导入（MediaStore 扫描为后续里程碑）')
    },
    removeMusicDir(): Promise<string[]> {
      return Promise.resolve([])
    },
    listMusicDirs(): Promise<string[]> {
      return Promise.resolve([])
    },

    listPlaylists(): Promise<Playlist[]> {
      return Promise.resolve(playlistsCache.map((item) => ({ ...item, songs: [...item.songs] })))
    },
    createPlaylist(name: string, songs?: Song[]): Promise<Playlist[]> {
      const trimmed = name.trim().slice(0, 40)
      if (!trimmed) throw new Error('歌单名不能为空')
      playlistsCache = persistPlaylists([
        ...playlistsCache,
        {
          id: `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: trimmed,
          songs: dedupe(songs ?? []),
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      ])
      return this.listPlaylists()
    },
    renamePlaylist(id: string, name: string): Promise<Playlist[]> {
      playlistsCache = persistPlaylists(
        playlistsCache.map((item) =>
          item.id === id && !item.builtin
            ? { ...item, name: name.trim().slice(0, 40), updatedAt: Date.now() }
            : item
        )
      )
      return this.listPlaylists()
    },
    removePlaylist(id: string): Promise<Playlist[]> {
      playlistsCache = persistPlaylists(playlistsCache.filter((item) => item.id !== id))
      return this.listPlaylists()
    },
    addPlaylistSongs(id: string, songs: Song[]): Promise<Playlist[]> {
      playlistsCache = persistPlaylists(
        playlistsCache.map((item) =>
          item.id === id
            ? { ...item, songs: dedupe([...item.songs, ...songs]), updatedAt: Date.now() }
            : item
        )
      )
      return this.listPlaylists()
    },
    removePlaylistSong(id: string, platform: string, songId: string): Promise<Playlist[]> {
      playlistsCache = persistPlaylists(
        playlistsCache.map((item) =>
          item.id === id
            ? {
                ...item,
                songs: item.songs.filter((song) => !(song.platform === platform && song.id === songId)),
                updatedAt: Date.now()
              }
            : item
        )
      )
      return this.listPlaylists()
    },
    toggleFavorite(song: Song): Promise<{ list: Playlist[]; favorited: boolean }> {
      const favorites = playlistsCache.find((item) => item.id === FAVORITES_ID)
      if (!favorites) throw new Error('收藏夹初始化失败')
      const existed = favorites.songs.some((item) => keyOf(item) === keyOf(song))
      const next = existed
        ? favorites.songs.filter((item) => keyOf(item) !== keyOf(song))
        : dedupe([...favorites.songs, song])
      playlistsCache = persistPlaylists(
        playlistsCache.map((item) =>
          item.id === FAVORITES_ID ? { ...item, songs: next, updatedAt: Date.now() } : item
        )
      )
      return Promise.resolve({
        list: playlistsCache.map((item) => ({ ...item })),
        favorited: !existed
      })
    },

    getSettings(): Promise<AppSettings> {
      return Promise.resolve({ ...settingsCache })
    },
    setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
      settingsCache = { ...settingsCache, ...patch }
      // 登录态变更即时生效（适配器每次请求读内存 Cookie）
      if (patch.qqCookie !== undefined || patch.neteaseCookie !== undefined) {
        setProviderCookies({ qq: settingsCache.qqCookie, netease: settingsCache.neteaseCookie })
      }
      // 引擎音源开关即时增删注册表（首次启动后需要触发一次引擎冷启动）
      if (patch.engineEnabled !== undefined) {
        setEngineProviders(patch.engineEnabled)
      }
      const next = persistSettings()
      broadcastSettings()
      return Promise.resolve(next)
    },

    checkForUpdate() {
      return Promise.resolve({ supported: false, state: 'none' as const, currentVersion: '' })
    },
    installUpdate(): void {
      /* 移动端暂无自更新 */
    },
    onUpdateStatus() {
      return () => false
    },

    winMinimize(): void {},
    winMaximize(): void {},
    winClose(): void {},
    isMaximized(): Promise<boolean> {
      return Promise.resolve(false)
    },

    toggleLyricWindow(): Promise<boolean> {
      return Promise.resolve(false)
    },
    closeLyricWindow(): void {},
    setLyricWindowLock(): void {},
    pushLyricState(): void {},
    getLyricMode(): Promise<'mini' | 'full'> {
      return Promise.resolve('mini')
    },
    setLyricMode(mode: 'mini' | 'full'): Promise<'mini' | 'full'> {
      return Promise.resolve(mode)
    },
    sendLyricCommand(): void {},

    pushTrayState(): void {},
    onTrayCommand() {
      return () => false
    },

    startQrLogin(): Promise<never> {
      return unsupported('扫码登录（移动端将走原生登录）')
    },
    pollQrLogin() {
      return Promise.resolve({
        platform: 'netease' as const,
        phase: 'idle' as const,
        qrImage: '',
        message: '',
        expiresAt: 0
      })
    },
    cancelQrLogin(): void {},

    sendSmsCaptcha(phone: string, countrycode = '86'): Promise<{ ok: boolean; message: string }> {
      return neteaseSendCaptcha(phone, countrycode)
    },
    cellphoneLogin(args: CellphoneLoginArgs): Promise<CellphoneLoginResult> {
      return neteaseCellphoneLogin(args)
    },

    /**
     * C6 移动端应用内登录：QQ 音乐走原生 WebView（CookieManager 抓登录态）。
     * 网易云已有手机号登录（cellphoneLogin），不再提供网页登录。
     *
     * 实现走「启动 + 轮询」而非 Activity 结果回调：vivo 杀后台/重建 Activity
     * 会把 Capacitor 的 startActivityForResult 调用弄丢（日志 "Couldn't save
     * last Plugin call"），promise 永远悬死。改为 WebLoginActivity 把 Cookie
     * 落到应用私有 SharedPreferences，这里每 2s 查一次；用户回到前台仍无
     * Cookie 即判定取消。
     */
    async openLoginWindow(platform: 'qq' | 'netease' = 'qq'): Promise<{ opened: boolean }> {
      const media = auroraMediaPlugin()
      if (!media?.webLogin || !media.webLoginState) return unsupported('应用内登录（请更新 APK）')
      const label = platform === 'netease' ? '网易云' : 'QQ 音乐'
      try {
        // QQ 必须用 oauth2.0/authorize（现行接口，自动跳 xui.ptlogin2.qq.com
        // 统一登录页）——旧的 oauth2.0/show 是 PC 时代 WAP 流程，直接提交
        // 会报「提交参数错误」。display=mobile：手机上有一键登录/账密/短信，
        // 不出现扫不了的二维码；回调页由原生切桌面 UA 换 Cookie。
        // 网易云直接开官网登录页（桌面 UA），手机号/验证码登录后种 MUSIC_U。
        const oauthRedirect = encodeURIComponent(
          'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/'
        )
        const url =
          platform === 'netease'
            ? 'https://music.163.com/#/login'
            : `https://graph.qq.com/oauth2.0/authorize?which=Login&response_type=code&client_id=100497308&state=aurora&display=mobile&redirect_uri=${oauthRedirect}`
        await media.webLogin({ url, platform })

        const finish = (ok: boolean, cookie: string, message: string): void => {
          if (ok) {
            if (platform === 'netease') {
              settingsCache = { ...settingsCache, neteaseCookie: cookie }
              setProviderCookies({ qq: settingsCache.qqCookie, netease: cookie })
            } else {
              settingsCache = { ...settingsCache, qqCookie: cookie }
              setProviderCookies({ qq: cookie, netease: settingsCache.neteaseCookie })
            }
            persistSettings()
            broadcastSettings()
          }
          for (const cb of loginWindowResultListeners) {
            cb({ platform, ok, message })
          }
        }

        return await new Promise<{ opened: boolean }>((resolve, reject) => {
          let visibleTicks = 0
          let settled = false
          const timer = window.setInterval(() => {
            // 每轮都查：Cookie 由原生在捕获瞬间落盘，与 Activity 存活无关
            media
              .webLoginState!()
              .then((state) => {
                if (settled) return
                if (state.cookie) {
                  settled = true
                  window.clearInterval(timer)
                  finish(true, state.cookie, `${label}登录成功`)
                  resolve({ opened: true })
                  return
                }
                // 原生侧已给出失败原因（超时/授权未捕获/取消）：立即收口，
                // 不再等 tick 计数，用户回到 App 就能看到具体原因
                if (state.error) {
                  settled = true
                  window.clearInterval(timer)
                  finish(false, '', state.error)
                  reject(new Error(state.error))
                }
              })
              .catch(() => {})
            if (settled) return
            // 文档不可见 = 用户还在 WebView 登录页，不计时；回前台仍无 Cookie 视为放弃
            if (document.hidden) {
              visibleTicks = 0
              return
            }
            visibleTicks += 1
            // 10 tick（约 20s）：Cookie 落盘与 Activity finish 存在竞态，
            // 阈值给足余量，避免刚授权完就被误判成取消
            if (visibleTicks > 10) {
              settled = true
              window.clearInterval(timer)
              const message = '登录未完成或已取消'
              finish(false, '', message)
              reject(new Error(message))
            }
          }, 2000)
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : '登录失败'
        for (const cb of loginWindowResultListeners) {
          cb({ platform, ok: false, message })
        }
        throw error
      }
    },
    closeLoginWindow(): void {},
    onLoginWindowResult(cb: (result: LoginWindowResult) => void): () => void {
      loginWindowResultListeners.add(cb)
      return () => loginWindowResultListeners.delete(cb)
    },

    onDownloadProgress(cb: (tasks: DownloadTask[]) => void): () => void {
      downloadProgressListeners.add(cb)
      return () => downloadProgressListeners.delete(cb)
    },
    onSettingsChanged(cb: SettingsListener): () => void {
      settingsListeners.add(cb)
      return () => settingsListeners.delete(cb)
    },
    onLyricWindowState() {
      return () => false
    },
    onToast() {
      return () => false
    }
  }
}

let installed = false

/** 渲染层入口调用：没有 preload（Capacitor 环境）时安装移动端桥 */
export async function installMobileBridgeIfNeeded(): Promise<void> {
  if (installed || window.api) return
  await initMediaProxy()
  bindNativeDownloadProgress()
  // 等凭据恢复完成再暴露 API：否则 app.boot() 拿到的设置快照缺账号信息，
  // 账号卡片在下次设置变更前一直显示未登录（竞态修复）
  await secretsReady
  window.api = createApi()
  installed = true
  // 启动后异步校验 QQ 登录态（不阻塞 UI）：musicu.fcg 搜索匿名返回空列表，
  // 登录后才有结果——据此判断 Cookie 是否已失效。
  void validateQqSessionOnBoot()
}

/**
 * 启动会话校验（QQ）。
 *
 * Cookie 会过期（官方有效期约 3 个月，改密码/风控会提前失效）。仅凭「本地有
 * Cookie」判断已登录会在失效后一直显示已登录、搜索却返回空——这里用一次
 * 真实搜索探测，失败才清理凭据；网络异常不误判（保留登录态）。
 */
async function validateQqSessionOnBoot(): Promise<void> {
  if (!settingsCache.qqCookie) return
  // 让启动高峰先过去（引擎 boot / 首屏请求），避免抢占带宽
  await new Promise<void>((resolve) => setTimeout(resolve, 3000))
  try {
    const provider = getProvider('qq')
    const page = await provider.search({ keyword: '周杰伦', page: 1, limit: 1 })
    if ((page.items?.length ?? 0) > 0) return
    // 有 Cookie 但搜索为空 = 登录态失效：清掉并通知 UI 回落到未登录
    settingsCache = { ...settingsCache, qqCookie: '' }
    setProviderCookies({ qq: '', netease: settingsCache.neteaseCookie })
    persistSettings()
    broadcastSettings()
  } catch {
    // 网络/风控异常无法判定，保留登录态，下次启动再校验
  }
}
