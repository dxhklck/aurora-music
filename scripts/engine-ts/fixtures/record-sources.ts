/**
 * 录制音源真实响应，供离线回放测试使用。
 *
 * 用法：node scripts/engine-ts/.build/record-sources.mjs [keyword] [size]
 *
 * 录制的是「一次成功搜索实际打过的全部 HTTP 请求」，包含搜索页、详情页与播放地址探测。
 * 回放时按 `pathname + 稳定 query` 匹配，因此测试不需要联网，也不依赖平台当天返回什么。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { createSource, SOURCE_META } from '../../../src/main/engine/ts/sources'

interface RecordedRequest {
  url: string
  /** follow 重定向后的最终地址；探测拿它作为 downloadUrl */
  finalUrl: string
  method: string
  status: number
  headers: Array<[string, string]>
  bodyB64: string
}

const keyword = process.argv[2] ?? 'love'
const size = Number(process.argv[3] ?? 3)
const OUT = 'scripts/engine-ts/fixtures/sources'

/** 这些 query 参数每次请求都会变（时间戳、随机用户号、签名），不能作为匹配键 */
const VOLATILE = new Set([
  '_', 't', 'ts', 'time', 'timestamp', 'sign', 'signature', 'nonce', 'user', 'loginUid',
  'devid', 'devId', 'qimei36', 'mid', 'dfid', 'uuid', 'token', 'access_token'
])

function stableKey(raw: string): string {
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

function normalize(item: {
  identifier: string
  songName: string
  singers: string
  album: string
  ext: string
  durationS: number
  protocol: string
  lyric: string
  coverUrl: string
  downloadUrl: string
}): Record<string, unknown> {
  const host = (value: string): string => {
    try {
      return new URL(value).host
    } catch {
      return ''
    }
  }
  return {
    id: item.identifier,
    name: item.songName,
    singers: item.singers,
    album: item.album,
    ext: item.ext,
    durationS: item.durationS,
    protocol: item.protocol,
    hasLyric: Boolean(item.lyric),
    coverHost: host(item.coverUrl),
    urlHost: host(item.downloadUrl)
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const original = globalThis.fetch
  let bucket: RecordedRequest[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const response = await original(input, init)
    const copy = response.clone()
    const buffer = Buffer.from(await copy.arrayBuffer())
    bucket.push({
      url: request.url,
      finalUrl: response.url || request.url,
      method: request.method,
      status: response.status,
      headers: [...response.headers.entries()],
      bodyB64: buffer.toString('base64')
    })
    return response
  }

  const summary: Array<{ source: string; items: number; requests: number; note: string }> = []
  for (const meta of SOURCE_META) {
    bucket = []
    const client = createSource(meta.key)
    if (!client) continue
    let items: Awaited<ReturnType<typeof client.search>> = []
    let note = ''
    const started = Date.now()
    try {
      items = await Promise.race([
        client.search({ keyword, size }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 120_000))
      ])
    } catch (error) {
      note = error instanceof Error ? error.message : String(error)
    }
    const payload = {
      source: meta.key,
      label: meta.label,
      keyword,
      size,
      elapsedMs: Date.now() - started,
      note,
      items: items.map(normalize),
      requests: bucket
    }
    writeFileSync(`${OUT}/${meta.key}.json`, JSON.stringify(payload))
    summary.push({ source: meta.key, items: items.length, requests: bucket.length, note })
    console.log(`${meta.key.padEnd(13)} items=${String(items.length).padStart(2)} requests=${String(bucket.length).padStart(2)} ${note}`)
  }

  globalThis.fetch = original
  writeFileSync(`${OUT}/index.json`, JSON.stringify(summary, null, 2))
  const total = summary.reduce((sum, row) => sum + row.items, 0)
  console.log(`\n合计 ${total} 条，${summary.length} 个音源，关键词「${keyword}」`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
