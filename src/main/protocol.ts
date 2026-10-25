import { protocol, net } from 'electron'
import { readFile } from 'node:fs/promises'
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

  // 整读进内存后以 Buffer 直出。不要换成 createReadStream + Readable.toWeb：
  // Node 流适配器在 protocol.handle 下有背压恢复丢失的问题——元素缓冲耗尽后
  // 恢复信号不再送达，表现为"显示播放中但永久静音"（进歌词舞台等重负载时机触发）。
  let data: Buffer
  try {
    data = await readFile(filePath)
  } catch {
    return new Response('Not Found', { status: 404 })
  }

  const baseHeaders: Record<string, string> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    ...CORS_HEADERS
  }

  const rangeHeader = request.headers.get('range')
  if (rangeHeader) {
    const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader)
    if (match) {
      const start = match[1] ? Number(match[1]) : 0
      const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1
      if (start >= data.length || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${data.length}`, ...CORS_HEADERS }
        })
      }
      return new Response(data.subarray(start, end + 1) as unknown as BodyInit, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Length': String(end - start + 1)
        }
      })
    }
  }

  return new Response(data as unknown as BodyInit, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(data.length) }
  })
}
