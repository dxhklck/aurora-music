import { protocol } from 'electron'
import { open, readFile, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import { MEDIA_SCHEME } from './media'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
  '.lrc': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

const ALLOWED_EXT = new Set(Object.keys(MIME))

/** 超过这个体积才走流式：小文件整读更简单，也彻底绕开背压问题 */
const STREAM_THRESHOLD = 8 * 1024 * 1024
/** 流式分块：太小 syscall 过密，太大首块等待变长 */
const CHUNK = 256 * 1024

/**
 * Web Audio 的 MediaElementAudioSourceNode 只接受「同源或带 CORS 头」的媒体，
 * 否则整条链路静音（analyser 也全是 0），均衡器与频谱会变成摆设。
 * 上游 CDN 自己从不发 CORS 头，所以由代理统一补上——请求是 Node 发的，
 * 上游的跨域策略影响不到这里。
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type'
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/**
 * `muse://local` 允许读取的根目录：下载目录、用户导入的音乐目录、userData 下的
 * 封面/歌词缓存，以及演示音源目录。协议原本只按扩展名放行，等于给渲染层开了
 * 「任意路径读白名单扩展名文件」的口子——只要一次 XSS 就能把用户盘里的图片、
 * 歌词、音频整目录捞走。收敛到受管目录后，越界路径一律 403。
 */
let localRoots: string[] = []
let demoRoot = ''

export function setLocalRoots(roots: { managed: string[]; demo: string }): void {
  demoRoot = roots.demo
  localRoots = [...roots.managed]
}

/** 路径必须在某个受管根内（resolve 归一化 + 前缀比较，防止 ../ 与大小写绕过 Windows 盘符） */
function isInsideManagedRoots(resolved: string): boolean {
  const normalized = resolved.toLowerCase()
  for (const root of localRoots) {
    const rootNormalized = root.toLowerCase()
    if (normalized === rootNormalized || normalized.startsWith(rootNormalized.endsWith('\\') || rootNormalized.endsWith('/') ? rootNormalized : rootNormalized + '\\')) return true
    if (normalized.startsWith(rootNormalized + '/')) return true
  }
  return false
}

/** 演示目录单独放行（dev 与打包布局不同，由主进程启动时登记） */
function isInsideDemoRoot(resolved: string): boolean {
  if (!demoRoot) return false
  const normalized = resolved.toLowerCase()
  const root = demoRoot.toLowerCase()
  return normalized === root || normalized.startsWith(root + '\\') || normalized.startsWith(root + '/')
}

/**
 * 音源自定义请求头仓库。Cookie/Referer 不能塞进 muse:// URL（渲染层可见、
 * 会被日志记录，还可能被拼接重放），所以主进程侧用随机 sid 登记，
 * URL 只带 sid；proxyRemote 取回后附加到上游请求。条目带过期自动淘汰。
 */
const mediaHeaderStore = new Map<string, { headers: Record<string, string>; expireAt: number }>()
const MEDIA_HEADER_TTL = 15 * 60_000
const MEDIA_HEADER_MAX = 120

export function stashMediaHeaders(headers: Record<string, string>): string | null {
  const entries = Object.entries(headers).filter(([, value]) => value)
  if (!entries.length) return null
  if (mediaHeaderStore.size >= MEDIA_HEADER_MAX) {
    // 先清过期的，还超就从最早的开始丢
    const now = Date.now()
    for (const [key, value] of mediaHeaderStore) {
      if (value.expireAt <= now) mediaHeaderStore.delete(key)
    }
    while (mediaHeaderStore.size >= MEDIA_HEADER_MAX) {
      const oldest = mediaHeaderStore.keys().next().value
      if (!oldest) break
      mediaHeaderStore.delete(oldest)
    }
  }
  const sid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  mediaHeaderStore.set(sid, { headers: Object.fromEntries(entries), expireAt: Date.now() + MEDIA_HEADER_TTL })
  return sid
}

/** 必须在 app ready 之前调用 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true
      }
    }
  ])
}

/**
 * 自定义协议：
 *  muse://media/?u=<remote>&r=<referer>  —— 代理远端音频/封面，补齐 Referer 并透传 Range
 *  muse://local/?p=<filePath>           —— 读取本地音频（演示音源、已下载文件）
 *
 * 为什么需要它：<audio> 无法设置请求头，而各平台 CDN 普遍校验 Referer，
 * 同时本地文件需要支持 Range 才能拖动进度条。
 */
export function installMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method === 'OPTIONS') return preflight()
      if (url.hostname === 'media') return await proxyRemote(request, url)
      if (url.hostname === 'local') return await serveLocal(request, url)
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'proxy error'
      process.stdout.write(`[media] ${request.url.slice(0, 120)} -> ${message}\n`)
      return new Response(message, { status: 502, headers: CORS_HEADERS })
    }
  })
}

/**
 * muse://media 的目标校验：渲染层不可控内容能让主进程对任意 URL 发 GET，
 * 包括本机服务（127.0.0.1）、内网段与云元数据接口（169.254.169.254）。
 * 这里按 IP 段拒绝；域名由 DNS 解析结果判定，防止「域名解析到内网」绕过。
 */
function isPrivateAddress(address: string): boolean {
  // IPv6：::1、::、fc00::/7（唯一本地）、fe80::/10（链路本地）、IPv4 映射地址
  if (address.includes(':')) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
    return false
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true // 本机 / 私网 / 0.0.0.0
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true // 保留段
  if (a === 198 && (b === 18 || b === 19)) return true // benchmark
  if (a >= 224) return true // 组播 / 保留
  return false
}

async function assertPublicTarget(target: string): Promise<void> {
  const parsed = new URL(target)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('no host')
  // 字面量 IP 直接判；域名解析后每个地址都要是公网
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateAddress(host)) throw new Error('private address')
    return
  }
  const records = await dnsLookup(host, { all: true, verbatim: true })
  if (!records.length) throw new Error('dns empty')
  for (const record of records) {
    if (isPrivateAddress(record.address)) throw new Error('resolves to private address')
  }
}

async function proxyRemote(request: Request, url: URL): Promise<Response> {
  const target = url.searchParams.get('u') ?? ''
  if (!/^https?:\/\//i.test(target)) return new Response('Bad Request', { status: 400 })
  try {
    await assertPublicTarget(target)
  } catch (error) {
    // 域名解析失败也按拒绝处理：放行等于把 SSRF 判断交给运气
    process.stdout.write(`[media] blocked proxy target: ${error instanceof Error ? error.message : 'unknown'}\n`)
    return new Response('Forbidden', { status: 403, headers: CORS_HEADERS })
  }

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' }
  const referer = url.searchParams.get('r')
  if (referer) headers.Referer = referer
  // 音源自定义头（Cookie/Referer 等）：按 sid 从主进程仓库取，URL 本身不带敏感值
  const sid = url.searchParams.get('h')
  if (sid) {
    const stashed = mediaHeaderStore.get(sid)
    mediaHeaderStore.delete(sid) // 一次性：防重放
    if (stashed) Object.assign(headers, stashed.headers)
  }
  const range = request.headers.get('range')
  if (range) headers.Range = range

  // 上游连接挂起（CDN 不接受连接 / 不回首个字节）时不能无限等：
  // 音频元素会一直卡在 HAVE_NOTHING，不触发 error，UI 却已显示"正在播放"，
  // 用户侧就是永久静音。只掐"响应头"的超时，body 慢不影响（流式下放）。
  const controller = new AbortController()
  const headerTimer = setTimeout(() => controller.abort(), 15_000)
  let upstream: Response
  try {
    // 用 Node 的 fetch（undici）而不是 net.fetch：后者在自定义协议回调里对部分
    // 图片/音频 CDN 会直接 ERR_FAILED，且不便于透传 Range。
    // redirect:'manual'：跟随重定向时不再逐跳复检等于把 302 跳内网的路留给攻击者
    let current = target
    let response: Response | null = null
    for (let hop = 0; hop < 5; hop += 1) {
      if (hop > 0) await assertPublicTarget(current)
      const hopResponse = await fetch(current, {
        method: request.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        redirect: 'manual',
        signal: controller.signal
      })
      const location = hopResponse.headers.get('location')
      if (hopResponse.status >= 300 && hopResponse.status < 400 && location) {
        try {
          await hopResponse.body?.cancel()
        } catch {
          /* 3xx 通常无 body */
        }
        current = new URL(location, current).toString()
        if (!/^https?:\/\//i.test(current)) throw new Error('redirect to non-http')
        continue
      }
      response = hopResponse
      break
    }
    if (!response) throw new Error('too many redirects')
    upstream = response
  } catch (error) {
    clearTimeout(headerTimer)
    if (controller.signal.aborted) throw error // 响应头超时保持原语义：502
    process.stdout.write(`[media] blocked proxy target: ${error instanceof Error ? error.message : 'unknown'}\n`)
    return new Response('Forbidden', { status: 403, headers: CORS_HEADERS })
  } finally {
    clearTimeout(headerTimer)
  }

  const outgoing = new Headers(CORS_HEADERS)
  for (const key of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified'
  ]) {
    const value = upstream.headers.get(key)
    if (value) outgoing.set(key, value)
  }
  if (!outgoing.has('accept-ranges')) outgoing.set('accept-ranges', 'bytes')

  // 图片类响应加体积上限：封面 URL 来自音源返回值（半受控），
  // 超大/无限响应会拖占带宽与解码内存。音频不限——它本来就要整首传输。
  const contentType = outgoing.get('content-type') ?? ''
  if (contentType.startsWith('image/')) {
    const declared = Number(outgoing.get('content-length') ?? 0)
    if (declared > MAX_IMAGE_BYTES) {
      void upstream.body?.cancel()
      return new Response('Image Too Large', { status: 413, headers: CORS_HEADERS })
    }
    return new Response(limitedBody(upstream.body, MAX_IMAGE_BYTES), {
      status: upstream.status,
      headers: outgoing
    })
  }

  return new Response(upstream.body, { status: upstream.status, headers: outgoing })
}

/** 图片代理的响应体上限（8MB：4K 级封面也用不到这么多） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 超过 limit 字节就把流掐断（解码端会因数据截断报错——这正是想要的失败） */
function limitedBody(body: ReadableStream<Uint8Array> | null, limit: number): ReadableStream<Uint8Array> {
  if (!body) return new ReadableStream<Uint8Array>({ pull(controller) { controller.close() } })
  let total = 0
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        controller.close()
        return
      }
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        controller.error(new Error('image size limit exceeded'))
        return
      }
      controller.enqueue(value)
    },
    async cancel() {
      await reader.cancel().catch(() => undefined)
    }
  })
}

async function serveLocal(request: Request, url: URL): Promise<Response> {
  const filePath = decodeURIComponent(url.searchParams.get('p') ?? '')
  const ext = extname(filePath).toLowerCase()
  if (!filePath || !ALLOWED_EXT.has(ext)) return new Response('Forbidden', { status: 403 })
  // 必须是受管目录内的绝对路径；符号链接用 realpath 解到真实位置再判一次
  if (!isAbsolute(filePath) || !isInsideManagedRoots(filePath)) return new Response('Forbidden', { status: 403 })

  let size: number
  let realPath = filePath
  try {
    realPath = await realpath(filePath)
    if (!isInsideManagedRoots(realPath) && !isInsideDemoRoot(realPath)) {
      return new Response('Forbidden', { status: 403 })
    }
    const info = await stat(realPath)
    if (!info.isFile()) return new Response('Not Found', { status: 404 })
    size = info.size
  } catch {
    return new Response('Not Found', { status: 404 })
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ...CORS_HEADERS
  }

  // 只解析单区间：<audio> 的拖动与断点续播只发这一种
  let start = 0
  let end = size - 1
  let partial = false
  const rangeHeader = request.headers.get('range')
  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    if (match) {
      start = match[1] ? Number(match[1]) : 0
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
      if (start >= size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, ...CORS_HEADERS }
        })
      }
      partial = true
    }
  }

  const length = Math.max(0, end - start + 1)
  const headers: Record<string, string> = { ...baseHeaders, 'Content-Length': String(length) }
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  const status = partial ? 206 : 200

  if (request.method === 'HEAD') return new Response(null, { status, headers })

  // 小文件整读：这条路径已经跑稳了，不给它引入变化
  if (size <= STREAM_THRESHOLD) {
    try {
      const data = await readFile(realPath)
      return new Response(data.subarray(start, end + 1) as unknown as BodyInit, { status, headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  }

  // 大文件按需流式：一首 100MB 无损整读，峰值就是一个完整文件；拖动进度条还会再叠一次
  return new Response(fileBody(realPath, start, end), { status, headers })
}

/**
 * 按需读取的文件流。
 *
 * 刻意不用 `createReadStream` + `Readable.toWeb`：那个适配器在 protocol.handle 下会丢
 * 背压恢复信号，表现为「显示播放中但永久静音」（进歌词舞台等重负载时机触发）。
 * 这里手写 ReadableStream，`pull` 由 Chromium 按消费速度调用，本身就是拉模型——
 * 它不想要数据时我们就不读盘，也就不存在「恢复信号丢失」。
 */
function fileBody(path: string, start: number, end: number): ReadableStream<Uint8Array> {
  let handle: FileHandle | null = null
  let position = start
  const close = async (): Promise<void> => {
    const current = handle
    handle = null
    await current?.close().catch(() => undefined)
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        handle ??= await open(path, 'r')
        if (position > end) {
          controller.close()
          await close()
          return
        }
        const size = Math.min(CHUNK, end - position + 1)
        const buffer = Buffer.allocUnsafe(size)
        // 用定位读，不依赖句柄内部游标：并发分段读时游标会被相互踩
        const { bytesRead } = await handle.read(buffer, 0, size, position)
        if (bytesRead <= 0) {
          controller.close()
          await close()
          return
        }
        position += bytesRead
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead))
      } catch (error) {
        controller.error(error)
        await close()
      }
    },
    // 拖动进度条 / 切歌时 Chromium 会 cancel 掉旧流，句柄必须在这里放掉，否则泄漏
    async cancel() {
      await close()
    }
  })
}
