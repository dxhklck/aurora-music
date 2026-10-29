/**
 * 测试基础设施：本地 HTTP 服务、fetch 路由、fixture 回放。
 *
 * 全部只用 node: 内置模块，不引入测试框架依赖——`node --test` 足够。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

export const ROOT = process.cwd()
export const FIXTURES = join(ROOT, 'scripts/engine-ts/fixtures')

export function loadJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, relative), 'utf8')) as T
}

export interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

export type FetchHandler = (url: string, init: RequestInit, call: CapturedCall) => Response | Promise<Response>

/** 安装一个全局 fetch 路由，返回调用记录与还原函数 */
export function mockFetch(handler: FetchHandler): { calls: CapturedCall[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: CapturedCall[] = []
  globalThis.fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const request = new Request(input, init)
    const headers: Record<string, string> = {}
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    const call: CapturedCall = { url: request.url, method: request.method, headers, body: '' }
    if (init.body) call.body = typeof init.body === 'string' ? init.body : String(init.body)
    calls.push(call)
    return handler(request.url, init, call)
  }
  return {
    calls,
    restore: () => {
      globalThis.fetch = original
    }
  }
}

export function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  })
}

export function textResponse(text: string, status = 200, contentType = 'text/plain; charset=utf-8'): Response {
  return new Response(text, { status, headers: { 'content-type': contentType } })
}

export function audioResponse(bytes: Uint8Array, contentType = 'audio/mpeg', extra: Record<string, string> = {}): Response {
  // TS 5.9 的 BodyInit 只接受以 ArrayBuffer 支撑的视图；undici 运行时接受任意 Uint8Array。
  // 按运行时行为断言，避免为绕类型去复制一份 buffer。
  return new Response(bytes as unknown as BodyInit, { status: 200, headers: { 'content-type': contentType, ...extra } })
}

export interface ReplayFixture {
  source: string
  keyword: string
  size: number
  items: Array<Record<string, unknown>>
  requests: Array<{
    url: string
    finalUrl?: string
    method: string
    status: number
    headers: Array<[string, string]>
    bodyB64: string
  }>
}

const VOLATILE = new Set([
  '_', 't', 'ts', 'time', 'timestamp', 'sign', 'signature', 'nonce', 'user', 'loginUid',
  'devid', 'devId', 'qimei36', 'mid', 'dfid', 'uuid', 'token', 'access_token'
])

export function stableKey(raw: string): string {
  try {
    const url = new URL(raw)
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !VOLATILE.has(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
    return `${url.pathname}?${params.join('&')}`
  } catch {
    return raw
  }
}

/** 按 `pathname + 稳定 query` 回放录制的响应；同一键按录制顺序取用 */
export function replayFixture(fixture: ReplayFixture): { calls: CapturedCall[]; restore: () => void; missing: string[] } {
  const queues = new Map<string, ReplayFixture['requests']>()
  for (const request of fixture.requests) {
    // method 也进 key：HEAD 与 GET 的响应体不同，混用会让探测误判
    const key = `${request.method} ${stableKey(request.url)}`
    const list = queues.get(key) ?? []
    list.push(request)
    queues.set(key, list)
  }
  const missing: string[] = []
  const mock = mockFetch((url, init) => {
    const key = `${(init.method ?? 'GET').toUpperCase()} ${stableKey(url)}`
    const queue = queues.get(key)
    if (!queue || !queue.length) {
      missing.push(url)
      return new Response('fixture missing', { status: 599 })
    }
    const record = queue.shift() as ReplayFixture['requests'][number]
    const headers: Record<string, string> = {}
    for (const [name, value] of record.headers) {
      const lower = name.toLowerCase()
      // 录制时 fetch 已解压，保留 content-encoding 会让回放再解压一次
      if (lower === 'content-encoding' || lower === 'content-length' || lower === 'transfer-encoding') continue
      headers[lower] = value
    }
    const body = Buffer.from(record.bodyB64, 'base64')
    if (record.status === 204 || record.status === 304) {
      return new Response(null, { status: record.status, headers })
    }
    const response = new Response(body, { status: record.status, headers })
    // fetch 跟随重定向后的最终地址不会自动带上，探测逻辑依赖它推断 CDN 域名
    if (record.finalUrl) {
      Object.defineProperty(response, 'url', { value: record.finalUrl, configurable: true })
    }
    return response
  })
  return { ...mock, missing }
}

export interface TestServer {
  url: string
  calls: CapturedCall[]
  close: () => Promise<void>
}

/** 起一个本地 HTTP 服务；handler 里拿到的 body 已读完 */
export async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>
): Promise<TestServer> {
  const calls: CapturedCall[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join('; ')
    }
    calls.push({ url: req.url ?? '', method: req.method ?? 'GET', headers, body: body.toString('utf8') })
    await handler(req, res, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
  }
}

/** 读取请求体（用于 POST/GET-with-body 断言） */
export function bodyText(body: Buffer): string {
  return body.toString('utf8')
}
