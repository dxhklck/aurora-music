import { createDecipheriv } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { HttpSession } from './http'
import { EngineError } from './errors'

/**
 * HLS（m3u8）下载器。
 *
 * 上游用 `HLSDownloader` + ffmpeg 做 remux，这里保留同样的两段式：
 * 先并发取分片（含 AES-128 解密）拼成一个中间文件，再交给 ffmpeg
 * `-c copy` 转封装。ffmpeg 缺失时退回「原样落盘」，并让调用方知道
 * 产物其实是 TS 分片而不是期待的 mp3/m4a——静默产出坏文件比报错更糟。
 */

export interface HlsProgress {
  (received: number, total: number): void
}

interface Variant {
  url: string
  bandwidth: number
}

interface KeyInfo {
  method: string
  uri: string
  iv?: Buffer
}

function parseAttributes(line: string): Record<string, string> {
  const output: Record<string, string> = {}
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let matched: RegExpExecArray | null
  while ((matched = pattern.exec(line)) !== null) {
    output[matched[1]] = matched[2].replace(/^"|"$/g, '')
  }
  return output
}

function hexToBuffer(hex: string): Buffer {
  const cleaned = hex.replace(/^0x/i, '')
  const padded = cleaned.length % 2 ? `0${cleaned}` : cleaned
  // IV 可能是短写（如 0x1），按 16 字节右对齐补零
  return Buffer.concat([Buffer.alloc(Math.max(0, 32 - padded.length), 0), Buffer.from(padded, 'hex')])
}

/** 解析主播放列表，选出带宽最高的子列表 */
async function pickVariant(session: HttpSession, url: string, text: string): Promise<{ url: string; text: string }> {
  if (!text.includes('#EXT-X-STREAM-INF')) return { url, text }
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const variants: Variant[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
    const attrs = parseAttributes(lines[index])
    const next = lines[index + 1]
    if (!next || next.startsWith('#')) continue
    variants.push({ url: new URL(next, url).toString(), bandwidth: Number.parseInt(attrs.BANDWIDTH ?? '0', 10) || 0 })
  }
  if (!variants.length) return { url, text }
  variants.sort((a, b) => b.bandwidth - a.bandwidth)
  const response = await session.get(variants[0].url)
  if (!response.ok) return { url, text }
  return { url: variants[0].url, text: response.text }
}

interface Segment {
  url: string
  key?: KeyInfo
}

function parseSegments(baseUrl: string, text: string): Segment[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim())
  const segments: Segment[] = []
  let currentKey: KeyInfo | undefined
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttributes(line.slice(line.indexOf(':') + 1))
      if ((attrs.METHOD ?? '').toUpperCase() === 'NONE') {
        currentKey = undefined
      } else {
        currentKey = {
          method: (attrs.METHOD ?? '').toUpperCase(),
          uri: new URL(attrs.URI ?? '', baseUrl).toString(),
          iv: attrs.IV ? hexToBuffer(attrs.IV) : undefined
        }
      }
      continue
    }
    if (!line || line.startsWith('#')) continue
    segments.push({ url: new URL(line, baseUrl).toString(), key: currentKey })
  }
  return segments
}

async function fetchKey(session: HttpSession, key: KeyInfo): Promise<Buffer> {
  const response = await session.get(key.uri)
  if (!response.ok) throw new EngineError('blocked', `HLS 密钥获取失败（${response.status}）`)
  return Buffer.from(response.bytes)
}

function decryptSegment(data: Buffer, key: Buffer, iv: Buffer | undefined, sequence: number): Buffer {
  const algorithm = key.length === 16 ? 'aes-128-cbc' : 'aes-256-cbc'
  const useIv = iv ?? Buffer.alloc(16)
  if (!iv) useIv.writeUInt32BE(sequence, 12)
  const decipher = createDecipheriv(algorithm, key, useIv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

async function concatSegments(files: string[], target: string): Promise<number> {
  const stream = createWriteStream(target)
  let total = 0
  for (const file of files) {
    const chunk = await readFile(file)
    total += chunk.length
    await new Promise<void>((resolve, reject) => {
      stream.write(chunk, (error) => (error ? reject(error) : resolve()))
    })
  }
  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
  })
  return total
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

export interface HlsDownloadOptions {
  url: string
  target: string
  headers?: Record<string, string>
  cookies?: Record<string, string>
  onProgress?: HlsProgress
  concurrency?: number
}

/**
 * 下载 HLS 流到 `target`。
 *
 * 返回 `{ path, size, remuxed }`：`remuxed=false` 说明 ffmpeg 不可用，
 * 落盘的是 TS 分片拼接体，调用方应据此决定是否提示用户。
 */
export async function downloadHls(options: HlsDownloadOptions): Promise<{ path: string; size: number; remuxed: boolean }> {
  const session = new HttpSession({
    headers: {
      Accept: '*/*',
      ...(options.headers ?? {})
    },
    cookies: options.cookies ?? {},
    maxRetries: 2,
    timeoutMs: 20_000
  })

  const playlist = await session.get(options.url)
  if (!playlist.ok) throw new EngineError('blocked', `HLS 清单不可用（${playlist.status}）`)
  const variant = await pickVariant(session, options.url, playlist.text)
  const segments = parseSegments(variant.url, variant.text)
  if (!segments.length) throw new EngineError('blocked', 'HLS 清单里没有分片')

  const workDir = await mkdtemp(join(tmpdir(), 'aurora-hls-'))
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const keyCache = new Map<string, Buffer>()
  const files: string[] = new Array(segments.length)
  let received = 0

  const downloadOne = async (index: number): Promise<void> => {
    const segment = segments[index]
    const response = await session.get(segment.url, { retries: 2 })
    if (!response.ok) throw new EngineError('blocked', `HLS 分片下载失败（${response.status}）`)
    let data: Buffer = Buffer.from(response.bytes)
    if (segment.key && segment.key.method === 'AES-128') {
      let key = keyCache.get(segment.key.uri)
      if (!key) {
        key = await fetchKey(session, segment.key)
        keyCache.set(segment.key.uri, key)
      }
      data = decryptSegment(data, key, segment.key.iv, index)
    }
    const file = join(workDir, `${String(index).padStart(5, '0')}.part`)
    await writeFile(file, data)
    files[index] = file
    received += data.length
    options.onProgress?.(received, 0)
  }

  try {
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(concurrency, segments.length) }, async () => {
        while (cursor < segments.length) {
          const index = cursor
          cursor += 1
          await downloadOne(index)
        }
      })
    )

    const merged = join(workDir, 'merged.ts')
    const size = await concatSegments(files, merged)
    options.onProgress?.(size, size)

    // 目标是 mp3/m4a 时交给 ffmpeg 转封装；已是 .ts 就直接用
    if (/\.[^.]+$/.test(options.target) && !options.target.toLowerCase().endsWith('.ts')) {
      const ok = await runFfmpeg(['-y', '-loglevel', 'error', '-i', merged, '-c', 'copy', options.target])
      if (ok) return { path: options.target, size: await sizeOf(options.target), remuxed: true }
    }
    await rm(options.target, { force: true })
    const { rename } = await import('node:fs/promises')
    await rename(merged, options.target)
    return { path: options.target, size, remuxed: false }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function sizeOf(path: string): Promise<number> {
  const { stat } = await import('node:fs/promises')
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
