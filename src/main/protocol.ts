import { protocol, net } from 'electron'
import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
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

async function proxyRemote(request: Request, url: URL): Promise<Response> {
  const target = url.searchParams.get('u') ?? ''
  if (!/^https?:\/\//i.test(target)) return new Response('Bad Request', { status: 400 })

  const headers: Record<string, string> = { 'User-Agent': UA, Accept: '*/*' }
  const referer = url.searchParams.get('r')
  if (referer) headers.Referer = referer
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
    upstream = await fetch(target, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    })
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

  return new Response(upstream.body, { status: upstream.status, headers: outgoing })
}

async function serveLocal(request: Request, url: URL): Promise<Response> {
  const filePath = decodeURIComponent(url.searchParams.get('p') ?? '')
  const ext = extname(filePath).toLowerCase()
  if (!filePath || !ALLOWED_EXT.has(ext)) return new Response('Forbidden', { status: 403 })

  let size: number
  try {
    const info = await stat(filePath)
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
      const data = await readFile(filePath)
      return new Response(data.subarray(start, end + 1) as unknown as BodyInit, { status, headers })
    } catch {
      return new Response('Not Found', { status: 404 })
    }
  }

  // 大文件按需流式：一首 100MB 无损整读，峰值就是一个完整文件；拖动进度条还会再叠一次
  return new Response(fileBody(filePath, start, end), { status, headers })
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
