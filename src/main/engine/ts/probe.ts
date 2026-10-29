import { HttpSession, type RequestOptions } from './http'
import type { ProbeResult } from './types'

/**
 * 播放地址探测（等价上游 `AudioLinkTester`）。
 *
 * 这是整个引擎最容易被低估的一段：平台经常用 **HTTP 200 + HTML 错误页** 回应
 * 下载请求，只看状态码会把「无法播放」当成「可以播放」丢给播放器。所以必须
 * 真的取一小段字节，按魔数判断类型，再决定这条地址能不能用。
 *
 * 顺序与上游一致：HEAD 先试（省流量）；HEAD 拿不到可判定的扩展名时再用
 * GET 读前 8KB 做魔数嗅探。扩展名推断优先级也保持原样：
 * 原始 URL 后缀 → 重定向后 URL 后缀 → Content-Disposition → Content-Type → 字节魔数。
 */

/** 可用作音频的扩展名（对齐上游 VALID_AUDIO_EXTS；注意上游刻意不含裸 `mp4`） */
const VALID_AUDIO_EXTS = new Set([
  'aac', 'ac3', 'aif', 'aifc', 'aiff', 'alac', 'amr', 'ape', 'au', 'awb', 'caf', 'dff', 'dsf',
  'dts', 'eac3', 'flac', 'm4a', 'm4b', 'm4p', 'm4r', 'm4s', 'mid', 'midi', 'mka', 'm3u8',
  'mp1', 'mp2', 'mp3', 'mpa', 'mpc', 'oga', 'ogg', 'opus', 'ra', 'ram', 'wav', 'wave',
  'wma', 'wv', 'tta', 'spx', 'weba', 'mgg', 'mflac', 'qmcflac', 'qmc0', 'qmc3', 'qmcogg'
])

/** 扩展名归一（mpeg→mp3 这类媒体类型别名） */
const EXT_ALIAS: Record<string, string> = {
  mpeg: 'mp3',
  mpga: 'mp3',
  'x-mp3': 'mp3',
  'x-mpeg': 'mp3',
  wave: 'wav',
  'x-wav': 'wav',
  oga: 'ogg',
  'x-ogg': 'ogg',
  'x-flac': 'flac',
  'x-aac': 'aac',
  'x-m4a': 'm4a',
  mp4a: 'm4a'
}

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/x-ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/x-m4p': 'm4a',
  'video/mp4': 'm4a',
  'application/flac': 'flac',
  'application/x-flac': 'flac',
  'application/ogg': 'ogg',
  'application/x-mpegurl': 'm3u8',
  'application/vnd.apple.mpegurl': 'm3u8'
}

/** 扩展名 → MIME，用于 mimetypes.guess_type(url) 的等价判断 */
const EXT_TO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  ape: 'audio/x-ape',
  m3u8: 'application/vnd.apple.mpegurl'
}

export function normalizeExt(ext?: string | null): string {
  if (!ext) return ''
  const cleaned = ext.trim().toLowerCase().replace(/^\./, '')
  if (!cleaned) return ''
  return EXT_ALIAS[cleaned] ?? cleaned
}

export function isValidAudioExt(ext?: string | null): boolean {
  const normalized = normalizeExt(ext)
  return Boolean(normalized && VALID_AUDIO_EXTS.has(normalized))
}

function normalizeContentType(value?: string | null): string {
  if (!value) return ''
  return value.split(';')[0].trim().toLowerCase()
}

function isAudioMime(value?: string | null): boolean {
  const ctype = normalizeContentType(value)
  if (!ctype) return false
  return (
    ctype.startsWith('audio/') ||
    ctype === 'application/octet-stream' ||
    ctype === 'application/flac' ||
    ctype === 'application/ogg' ||
    ctype === 'application/vnd.apple.mpegurl' ||
    ctype === 'application/x-mpegurl' ||
    ctype === 'video/mp4'
  )
}

/** 从 URL 路径取最后一个后缀（忽略 query 与 hash） */
export function extFromUrl(url?: string | null): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const name = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    const dot = name.lastIndexOf('.')
    if (dot <= 0 || dot === name.length - 1) return ''
    return normalizeExt(name.slice(dot + 1))
  } catch {
    return ''
  }
}

function extFromContentDisposition(value?: string | null): string {
  if (!value) return ''
  for (const part of value.split(';')) {
    const trimmed = part.trim()
    const lower = trimmed.toLowerCase()
    if (lower.startsWith('filename*=')) {
      const raw = trimmed.slice('filename*='.length).replace(/^"|"$/g, '')
      const star = raw.indexOf("''")
      const decoded = star >= 0 ? raw.slice(star + 2) : raw
      try {
        return extFromUrl(`https://x/${decodeURIComponent(decoded)}`)
      } catch {
        return extFromUrl(`https://x/${decoded}`)
      }
    }
    if (lower.startsWith('filename=')) {
      return extFromUrl(`https://x/${trimmed.slice('filename='.length).replace(/^"|"$/g, '')}`)
    }
  }
  return ''
}

function mimeForUrl(url?: string | null): string {
  const ext = extFromUrl(url)
  if (!ext) return ''
  return EXT_TO_MIME[ext] ?? ''
}

function parseSizeFromHeaders(headers: Headers): number {
  const length = headers.get('content-length')
  if (length && /^\d+$/.test(length.trim())) return Number.parseInt(length, 10)
  const range = headers.get('content-range') ?? ''
  const slash = range.lastIndexOf('/')
  if (slash >= 0) {
    const total = range.slice(slash + 1).trim()
    if (/^\d+$/.test(total)) return Number.parseInt(total, 10)
  }
  return 0
}

/**
 * 魔数嗅探。上游用 filetype + puremagic 两个库，这里手写常见音频格式的签名，
 * 覆盖实际会遇到的 99% 场景，且没有第三方依赖。
 */
export function sniffAudioExt(bytes: Uint8Array): string {
  if (!bytes || bytes.length < 4) return ''
  const ascii = (start: number, length: number): string => {
    let text = ''
    for (let index = start; index < Math.min(start + length, bytes.length); index += 1) {
      text += String.fromCharCode(bytes[index])
    }
    return text
  }

  if (ascii(0, 3) === 'ID3') return 'mp3'
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // ADTS 的 layer 位是 00；MPEG Audio 的 Layer I/II/III 分别是 11/10/01
    const layer = (bytes[1] >> 1) & 0x03
    if (layer === 0x00) return 'aac'
    return 'mp3'
  }
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 4) === 'OggS') {
    const head = ascii(0, 64)
    if (head.includes('OpusHead')) return 'opus'
    if (head.includes('Speex')) return 'spx'
    return 'ogg'
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav'
  if (ascii(0, 4) === 'RF64') return 'wav'
  if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) return 'aiff'
  if (ascii(4, 4) === 'ftyp') return 'm4a'
  if (ascii(0, 4) === 'MAC ') return 'ape'
  if (ascii(0, 4) === 'wvpk') return 'wv'
  if (ascii(0, 4) === 'TTA1') return 'tta'
  if (ascii(0, 3) === 'AMR') return 'amr'
  if (ascii(0, 4) === '#!AM' || ascii(0, 5) === '#!AMR') return 'amr'
  if (ascii(0, 7) === '#EXTM3U') return 'm3u8'
  if (bytes[0] === 0x30 && bytes[1] === 0x26 && bytes[2] === 0xb2) return 'wma'
  if (ascii(0, 4) === 'MThd') return 'mid'
  if (ascii(0, 4) === 'caff') return 'caf'
  if (ascii(0, 4) === 'DSD ') return 'dsf'
  if (ascii(0, 4) === 'FRM8') return 'dff'
  return ''
}

function guessExtFromContentType(contentType: string): string {
  const ctype = normalizeContentType(contentType)
  if (!ctype) return ''
  const mapped = MIME_TO_EXT[ctype]
  if (mapped) return mapped
  // mimetypes.guess_extension 的近似：audio/x-xxx → xxx
  const subtype = ctype.split('/')[1]
  if (subtype) {
    const candidate = normalizeExt(subtype.replace(/^x-/, ''))
    if (candidate === 'mpeg') return 'mp3'
    if (candidate === 'mp4') return isAudioMime(ctype) ? 'm4a' : ''
    return candidate
  }
  return ''
}

function inferExt(input: {
  originalUrl: string
  finalUrl: string
  contentType: string
  contentDisposition: string
  sampleBytes: Uint8Array
  reason: string[]
}): string {
  const candidates: Array<[string, string]> = [
    ['url(original)', extFromUrl(input.originalUrl)],
    ['url(final)', extFromUrl(input.finalUrl)],
    ['content-disposition', extFromContentDisposition(input.contentDisposition)],
    ['mime(original-url)', MIME_TO_EXT[mimeForUrl(input.originalUrl)] ?? ''],
    ['mime(final-url)', MIME_TO_EXT[mimeForUrl(input.finalUrl)] ?? ''],
    ['content-type', MIME_TO_EXT[normalizeContentType(input.contentType)] ?? ''],
    ['content-type-guess', guessExtFromContentType(input.contentType)]
  ]
  for (const [strategy, raw] of candidates) {
    const ext = normalizeExt(raw)
    if (isValidAudioExt(ext)) {
      input.reason.push(`${strategy} -> ${ext}`)
      return ext
    }
    if (raw) input.reason.push(`${strategy} -> ${raw}(非音频)`)
  }
  if (!input.sampleBytes.length) {
    input.reason.push('字节嗅探跳过：没有样本')
    return ''
  }
  const sniffed = sniffAudioExt(input.sampleBytes)
  if (isValidAudioExt(sniffed)) {
    input.reason.push(`magic-bytes -> ${sniffed}`)
    return sniffed
  }
  input.reason.push(`magic-bytes -> ${sniffed || '未识别'}`)
  return ''
}

export interface ProbeOptions {
  headers?: Record<string, string>
  cookies?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  /** 单次探测的总尝试次数（HEAD + GET 各算一次，默认交给会话重试策略） */
  retries?: number
}

/**
 * 探测一条播放地址是否真的可用。
 *
 * 注意：**不抛异常**。探测失败是常态（试听被拦、CDN 拒绝），
 * 交给调用方按 `ok` 决定是换档位还是换地址。
 */
export async function probeUrl(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const reason: string[] = []
  const result: ProbeResult = {
    ok: false,
    ext: '',
    fileSizeBytes: 0,
    downloadUrl: url,
    statusCode: 0,
    contentType: '',
    method: '',
    reason
  }
  if (!url || !/^https?:/i.test(url)) {
    reason.push(`地址非法：${String(url).slice(0, 80)}`)
    result.method = 'invalid-url'
    return result
  }

  // 探测用独立会话：不复用搜索会话的 Cookie，避免把平台登录态带进 CDN 请求
  const session = new HttpSession({
    headers: {
      Accept: '*/*',
      'User-Agent':
        options.headers?.['User-Agent'] ??
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      ...(options.headers ?? {})
    },
    cookies: options.cookies ?? {},
    maxRetries: options.retries ?? 1,
    timeoutMs: options.timeoutMs ?? 15_000
  })

  const base: RequestOptions = {
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 15_000,
    retries: 1
  }

  // 1) HEAD：省流量，但很多 CDN 直接 405/403，失败就往下走
  try {
    const head = await session.head(url, base)
    result.statusCode = head.status
    result.downloadUrl = head.url || url
    result.contentType = head.headers.get('content-type') ?? ''
    result.fileSizeBytes = parseSizeFromHeaders(head.headers)
    if (!head.ok) {
      reason.push(`HEAD ${head.status}`)
      result.method = 'HEAD'
    } else {
      reason.push(`HEAD ${head.status} ${result.contentType}`)
      const ext = inferExt({
        originalUrl: url,
        finalUrl: head.url,
        contentType: result.contentType,
        contentDisposition: head.headers.get('content-disposition') ?? '',
        sampleBytes: new Uint8Array(0),
        reason
      })
      if (ext) {
        result.ext = ext
        result.ok = true
        result.method = 'HEAD'
        return result
      }
      reason.push('HEAD 无法判定扩展名，回退 GET')
    }
  } catch (error) {
    reason.push(`HEAD 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 2) GET：只读前 8KB 做魔数嗅探，读满即断开
  try {
    const get = await session.get(url, { ...base, maxBytes: 8192 })
    result.statusCode = get.status
    result.downloadUrl = get.url || url
    result.contentType = get.headers.get('content-type') ?? ''
    const size = parseSizeFromHeaders(get.headers)
    if (size) result.fileSizeBytes = size
    if (!get.ok) {
      reason.push(`GET ${get.status}`)
      result.method = result.method || 'GET'
      return result
    }
    reason.push(`GET ${get.status} ${result.contentType} bytes=${get.bytes.length}`)
    const ext = inferExt({
      originalUrl: url,
      finalUrl: get.url,
      contentType: result.contentType,
      contentDisposition: get.headers.get('content-disposition') ?? '',
      sampleBytes: get.bytes,
      reason
    })
    if (ext) {
      result.ext = ext
      result.ok = true
      result.method = 'GET(stream)'
    } else {
      // 状态码 200 但内容是 HTML 错误页——必须当失败处理
      result.method = 'GET(stream)+ext-failed'
      reason.push('状态码 2xx 但无法判定为音频（疑似错误页）')
    }
  } catch (error) {
    reason.push(`GET 失败：${error instanceof Error ? error.message : String(error)}`)
    if (!result.method) result.method = 'GET'
  }

  // 兜底：HEAD 成功但 GET 失败时，仍以 HEAD 的判定为准
  if (!result.ok && result.statusCode >= 200 && result.statusCode < 300) {
    const fromUrl = extFromUrl(result.downloadUrl)
    if (isValidAudioExt(fromUrl)) {
      result.ext = fromUrl
      result.ok = true
      if (!result.method) result.method = 'HEAD'
      reason.push(`兜底采用 URL 后缀 ${fromUrl}`)
    }
  }
  return result
}
