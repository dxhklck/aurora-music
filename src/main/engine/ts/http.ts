import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpError } from './errors'

/**
 * HTTP 会话层。
 *
 * 对齐上游 `BaseMusicClient.get/post` 的三个行为：
 * 1. **失败重试**：同一个地址最多试 `maxRetries` 次，每次失败记一条错误日志；
 * 2. **最后仍失败时返回响应而不是抛异常**——由调用方 `ensureOk()` 决定要不要失败，
 *    因为部分音源会在非 2xx 响应里塞有用信息；
 * 3. **Cookie 随会话累积**：`Set-Cookie` 写回会话，后续请求自动带上。
 *
 * 另外用 `AsyncLocalStorage` 做了「失败计数」：搜索期间所有请求的失败都记到当前
 * 搜索上下文（在 await 链上自动传递，不必层层透传参数），用来把「平台挂了」
 * 和「真没这首歌」区分开。
 */

export interface FailureScope {
  errors: number
}

const failureScope = new AsyncLocalStorage<FailureScope>()

/** 在指定作用域内执行，作用域内所有 HTTP 失败都会累加到 scope.errors */
export function withFailureScope<T>(scope: FailureScope, fn: () => Promise<T>): Promise<T> {
  return failureScope.run(scope, fn)
}

export function countFailure(): void {
  const scope = failureScope.getStore()
  if (scope) scope.errors += 1
}

export interface HttpResult {
  ok: boolean
  status: number
  /** 跟随重定向后的最终地址 */
  url: string
  headers: Headers
  text: string
  bytes: Uint8Array
  error: string
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  /** 显式 Cookie；缺省时用会话 Cookie */
  cookies?: Record<string, string>
  /** 表单体（application/x-www-form-urlencoded） */
  form?: Record<string, string | number>
  /** 原始请求体 */
  body?: string | Uint8Array
  /** 表单里需要以 JSON 发送时用它 */
  json?: unknown
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
  /** 不读取响应体（HEAD / 只需要状态码时） */
  noBody?: boolean
  /** 最多读取多少字节，超出即中断；用于探测音频头 */
  maxBytes?: number
  redirect?: 'follow' | 'manual'
}

const DEFAULT_TIMEOUT = 15_000
const BINARY_CHUNK = 8192

function cookiesToHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('; ')
}

/** 合并默认头与本次头；去掉由 undici 自己管理的头，避免解压后长度不匹配 */
function mergeHeaders(base: Record<string, string>, override?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { ...base }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined || value === null) continue
    merged[key] = String(value)
  }
  for (const key of Object.keys(merged)) {
    const lower = key.toLowerCase()
    if (lower === 'accept-encoding' || lower === 'host' || lower === 'content-length' || lower === 'connection') {
      delete merged[key]
    }
  }
  return merged
}

export class HttpSession {
  headers: Record<string, string>
  cookies: Record<string, string>
  maxRetries: number
  timeoutMs: number
  private readonly baseHeaders: Record<string, string>

  constructor(options?: { headers?: Record<string, string>; cookies?: Record<string, string>; maxRetries?: number; timeoutMs?: number }) {
    this.baseHeaders = { ...(options?.headers ?? {}) }
    this.headers = { ...this.baseHeaders }
    this.cookies = { ...(options?.cookies ?? {}) }
    this.maxRetries = Math.max(options?.maxRetries ?? 2, 1)
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT
  }

  /** 切回默认头（对应上游 useparseheaderscookies 装饰器的语义） */
  resetHeaders(headers: Record<string, string>): void {
    this.headers = { ...headers }
  }

  get(url: string, options: RequestOptions = {}): Promise<HttpResult> {
    return this.request(url, { ...options, method: 'GET' })
  }

  post(url: string, options: RequestOptions = {}): Promise<HttpResult> {
    return this.request(url, { ...options, method: 'POST' })
  }

  head(url: string, options: RequestOptions = {}): Promise<HttpResult> {
    return this.request(url, { ...options, method: 'HEAD', noBody: true })
  }

  /** 非 2xx 直接抛错，等价 requests 的 raise_for_status */
  static ensureOk(result: HttpResult): HttpResult {
    if (!result.ok) throw new HttpError(result.status, result.url, result.error || `HTTP ${result.status}`)
    return result
  }

  async json<T = Record<string, unknown>>(url: string, options: RequestOptions = {}): Promise<T> {
    const result = HttpSession.ensureOk(await this.get(url, options))
    return parseJsonLoose<T>(result.text)
  }

  async request(url: string, options: RequestOptions = {}): Promise<HttpResult> {
    const method = (options.method ?? 'GET').toUpperCase()
    const retries = Math.max(options.retries ?? this.maxRetries, 1)
    let last: HttpResult = emptyResult(url, method)

    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        last = await this.attempt(url, method, options)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        countFailure()
        last = { ...emptyResult(url, method), error: message }
        continue
      }
      if (last.ok) return last
      // 非 2xx：记一次失败并重试；最后一次的响应体仍然返回给调用方
      countFailure()
    }
    return last
  }

  private async attempt(url: string, method: string, options: RequestOptions): Promise<HttpResult> {
    const headers = mergeHeaders(this.headers, options.headers)
    const cookies = options.cookies === undefined ? this.cookies : options.cookies
    const cookieHeader = cookiesToHeader(cookies)
    if (cookieHeader && !Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
      headers.Cookie = cookieHeader
    }

    let body: string | Uint8Array | undefined = options.body
    if (options.form) {
      body = new URLSearchParams(
        Object.entries(options.form).map(([key, value]) => [key, String(value)])
      ).toString()
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
      }
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json)
      if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json'
      }
    }

    const timeout = options.timeoutMs ?? this.timeoutMs
    const signals: AbortSignal[] = [AbortSignal.timeout(timeout)]
    if (options.signal) signals.push(options.signal)
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]

    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : (body as BodyInit | undefined),
      redirect: options.redirect ?? 'follow',
      signal
    })

    this.absorbCookies(response)

    const result: HttpResult = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      url: response.url || url,
      headers: response.headers,
      text: '',
      bytes: new Uint8Array(0),
      error: ''
    }

    if (options.noBody || method === 'HEAD' || !response.body) {
      if (!result.ok) result.error = `HTTP ${response.status}`
      return result
    }

    const limit = options.maxBytes ?? 0
    if (limit > 0) {
      // 只读前 N 字节即可判断类型，读满就主动断开，不要把整个音频拖下来
      const { bytes } = await readPrefix(response, limit)
      result.bytes = bytes
      result.text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer())
      result.bytes = buffer
      result.text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    }
    if (!result.ok) result.error = `HTTP ${response.status}`
    return result
  }

  private absorbCookies(response: Response): void {
    const raw = response.headers.getSetCookie?.() ?? []
    for (const line of raw) {
      const [pair] = line.split(';')
      const index = pair.indexOf('=')
      if (index <= 0) continue
      this.cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
    }
  }
}

function emptyResult(url: string, method: string): HttpResult {
  return {
    ok: false,
    status: 0,
    url,
    headers: new Headers(),
    text: '',
    bytes: new Uint8Array(0),
    error: `${method} 请求未完成`
  }
}

/** 从响应流里读前 N 字节后立即取消，避免为探测付出整文件带宽 */
async function readPrefix(response: Response, limit: number): Promise<{ bytes: Uint8Array }> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0) }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < limit) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      const remain = limit - total
      const piece = value.length > remain ? value.subarray(0, remain) : value
      chunks.push(piece)
      total += piece.length
      if (total >= limit) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes: merged }
}

/**
 * 容错 JSON 解析。
 *
 * 上游用 `json_repair` 兜底——很多第三方接口会返回带尾逗号、单引号或未转义
 * 换行的「类 JSON」。这里按出现频率做三档修复，不做完整语法树重建：
 * 直接解析 → 去尾逗号 / 换行 → 单引号转双引号。
 */
export function parseJsonLoose<T = unknown>(input: string): T {
  const text = (input ?? '').replace(/^\uFEFF/, '').trim()
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    /* 继续修 */
  }
  const attempts = [
    () => text.replace(/,\s*([}\]])/g, '$1'),
    () => text.replace(/,\s*([}\]])/g, '$1').replace(/[\r\n\t]+/g, ' '),
    () =>
      text
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\r\n\t]+/g, ' ')
        // 只替换「键/值外侧」的单引号，避免破坏中文里的撇号
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'(\s*[:,\]}])/g, '"$1"$2')
        .replace(/([:{,\[]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'/g, '$1"$2"')
  ]
  for (const repair of attempts) {
    try {
      return JSON.parse(repair()) as T
    } catch {
      /* 下一档 */
    }
  }
  return {} as T
}

/** 从一个可能带杂质的响应里抠出第一个 JSON 对象/数组 */
export function extractJson<T = unknown>(input: string): T {
  const direct = parseJsonLoose<T>(input)
  if (direct && typeof direct === 'object' && Object.keys(direct as object).length) return direct
  const text = input ?? ''
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']']
  ] as const) {
    const start = text.indexOf(open)
    if (start < 0) continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const ch = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) {
          const candidate = text.slice(start, index + 1)
          const parsed = parseJsonLoose<T>(candidate)
          if (parsed && typeof parsed === 'object') return parsed
          break
        }
      }
    }
  }
  return {} as T
}

/**
 * 「GET + 请求体」的原生实现。
 *
 * 极少数平台接口（酷我的 `checkRight` / `audioUrl`）要求把签名参数放在 query、
 * 把业务参数放在 **GET 的 body** 里。fetch 规范直接禁止 GET 带 body，所以只能用
 * node:http(s) 自己发。只支持明文 HTTP/HTTPS + 单次请求，够用即可。
 */
export async function rawGetWithBody(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs = 15_000
): Promise<{ status: number; text: string; bytes: Uint8Array; headers: Record<string, string> }> {
  const { request } = await import(url.startsWith('https:') ? 'node:https' : 'node:http')
  const { gunzipSync, inflateSync, brotliDecompressSync } = await import('node:zlib')

  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = Buffer.from(body, 'utf8')
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length)
        },
        timeout: timeoutMs
      },
      (res: import('node:http').IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          let buffer = Buffer.concat(chunks)
          const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
          try {
            if (encoding.includes('gzip')) buffer = gunzipSync(buffer)
            else if (encoding.includes('br')) buffer = brotliDecompressSync(buffer)
            else if (encoding.includes('deflate')) buffer = inflateSync(buffer)
          } catch {
            /* 解压失败就按原样返回，交给 JSON 解析报错 */
          }
          const flat: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') flat[key.toLowerCase()] = value
          }
          resolve({ status: res.statusCode ?? 0, text: buffer.toString('utf8'), bytes: new Uint8Array(buffer), headers: flat })
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}
