import { HttpSession } from './http'
import { probeUrl, type ProbeOptions } from './probe'
import { cleanText, legalize, md5Hex } from './text'
import type { SearchContext, SearchOptions, SongInfo, SourceClient } from './types'

/**
 * 音源基类（等价上游 `BaseMusicClient` 的 search 编排部分）。
 *
 * 保留上游三个关键设计：
 * 1. **模板方法**：子类只实现 `buildUrls` + `parsePage`，分页并发与去重在这里；
 * 2. **按页限流**：每页最多产出 `search_size_per_page` 条，这是当年把咪咕从
 *    17s 压到 6s 的关键——一页塞 10 条会退化成串行解析；
 * 3. **页内即时推送**：每解析出一首就回调，而不是等整页结束。
 *
 * 与上游的差异：上游靠「轮询 list 长度」的观察线程假装逐首回调（见
 * `engine_core.install_page_hook`），这里因为控制了循环本身，是真正的逐首推送，
 * 少一个线程、少 120ms 轮询粒度。
 */

export interface SongDraft {
  identifier: string | number
  songName: unknown
  singers: unknown
  album: unknown
  durationS?: number
  coverUrl?: unknown
  lyric?: string
  ext?: string
  fileSizeBytes?: number
  downloadUrl?: string
  headers?: Record<string, string>
  cookies?: Record<string, string>
  protocol?: 'HTTP' | 'HLS'
  raw?: Record<string, unknown>
}

export interface SourceConfig {
  key: string
  label: string
  /** 每页条数；越小并发越高，但太小会被风控（咪咕每页 2 条会从 6s 退化到 50s+） */
  pageSize?: number
  headers?: Record<string, string>
  cookies?: Record<string, string>
  maxRetries?: number
  timeoutMs?: number
  /** 分页并发度，对应上游 num_threadings */
  concurrency?: number
}

const DEFAULT_PAGE_SIZE = 3

/** 页内收集器：汇总单页解析结果，并按 strict_limit 截断 */
export class PageCollector {
  readonly items: SongInfo[] = []
  private readonly limit: number
  private readonly onItem?: (song: SongInfo) => void

  constructor(limit: number, onItem?: (song: SongInfo) => void) {
    this.limit = Math.max(limit, 1)
    this.onItem = onItem
  }

  get full(): boolean {
    return this.items.length >= this.limit
  }

  push(song: SongInfo): void {
    if (this.full) return
    this.items.push(song)
    this.onItem?.(song)
  }
}

/** 受限并发执行；单个任务失败不影响其它任务 */
export async function runPool(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  const queue = [...tasks]
  const size = Math.max(1, Math.min(concurrency, queue.length))
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) {
        const task = queue.shift()
        if (!task) break
        try {
          await task()
        } catch {
          /* 单页失败已在页内记录，不扩散 */
        }
      }
    })
  )
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/**
 * 构造对外 SongInfo。
 *
 * 上游用 `'NULL'` 表示缺失，对外协议里必须是空串——否则前端的
 * `splitArtists('NULL')` 会渲染出一位叫 NULL 的歌手。
 */
export function makeSong(source: string, draft: SongDraft): SongInfo {
  return {
    source,
    identifier: cleanText(draft.identifier),
    songName: cleanText(legalize(draft.songName)),
    singers: cleanText(legalize(draft.singers)),
    album: cleanText(legalize(draft.album)),
    ext: (draft.ext ?? '').replace(/^\./, '').toLowerCase(),
    fileSizeBytes: Math.max(0, Math.trunc(draft.fileSizeBytes ?? 0)),
    bitrate: 0,
    codec: '',
    durationS: Math.max(0, Math.trunc(draft.durationS ?? 0)),
    coverUrl: cleanText(draft.coverUrl),
    downloadUrl: draft.downloadUrl ?? '',
    headers: { ...(draft.headers ?? {}) },
    cookies: { ...(draft.cookies ?? {}) },
    protocol: draft.protocol ?? 'HTTP',
    lyric: draft.lyric && draft.lyric !== 'NULL' ? draft.lyric : '',
    raw: draft.raw
  }
}

/** 只有真正拿到可播放地址的曲目才算数（对齐 with_valid_download_url） */
export function isPlayable(song: SongInfo): boolean {
  return Boolean(song.downloadUrl && /^https?:/i.test(song.downloadUrl))
}

/**
 * 依次探测候选地址，返回第一条可用的。
 *
 * 上游每个音源都写了一遍「for quality in MUSIC_QUALITIES: test(); if ok: break」，
 * 这里收敛成一个函数，顺带把「探测失败就换下一个」的语义固定下来。
 */
export async function probeFirst(
  urls: Array<string | undefined | null>,
  options: ProbeOptions = {}
): Promise<{ url: string; ext: string; size: number; protocol: 'HTTP' | 'HLS' } | null> {
  for (const url of urls) {
    if (!url || !/^https?:/i.test(url)) continue
    const result = await probeUrl(url, options)
    if (result.ok && result.ext) {
      return {
        url: result.downloadUrl || url,
        ext: result.ext,
        size: result.fileSizeBytes,
        protocol: result.ext === 'm3u8' ? 'HLS' : 'HTTP'
      }
    }
  }
  return null
}

export abstract class BaseSource implements SourceClient {
  readonly key: string
  readonly label: string
  readonly pageSize: number
  protected readonly http: HttpSession
  protected readonly config: SourceConfig
  private readonly concurrency: number

  constructor(config: SourceConfig) {
    this.config = config
    this.key = config.key
    this.label = config.label
    this.pageSize = Math.max(1, config.pageSize ?? DEFAULT_PAGE_SIZE)
    this.concurrency = Math.max(1, config.concurrency ?? 6)
    this.http = new HttpSession({
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        ...(config.headers ?? {})
      },
      cookies: config.cookies,
      maxRetries: config.maxRetries ?? 2,
      timeoutMs: config.timeoutMs ?? 15_000
    })
  }

  /** 构造分页 URL；size 为期望总条数，perPage 为每页条数 */
  protected abstract buildUrls(keyword: string, perPage: number, size: number): string[]

  /** 解析一页，把结果 push 进 ctx；内部异常应自行捕获（对应上游的 try/except） */
  protected abstract parsePage(url: string, ctx: SearchContext): Promise<void>

  async search(options: SearchOptions): Promise<SongInfo[]> {
    const keyword = (options.keyword ?? '').trim()
    if (!keyword) return []
    const size = clamp(options.size || 10, 1, 50)
    const perPage = Math.min(size, this.pageSize)
    let urls: string[] = []
    try {
      urls = this.buildUrls(keyword, perPage, size)
    } catch {
      return []
    }
    if (!urls.length) return []

    const buckets: SongInfo[][] = urls.map(() => [])
    await runPool(
      urls.map((url, index) => async () => {
        const collector = new PageCollector(perPage, options.onItem)
        const ctx: SearchContext = {
          keyword,
          limit: perPage,
          onItem: options.onItem,
          push: (song) => collector.push(song),
          get full() {
            return collector.full
          }
        }
        try {
          await this.parsePage(url, ctx)
        } catch {
          /* 单页失败：保留已收集的部分，等价上游 except 后返回 song_infos */
        }
        buckets[index] = collector.items
      }),
      this.concurrency
    )

    // 页序拼接 + 按 identifier 去重（对齐 _removeduplicates 的保序语义）
    const flattened = buckets.flat()
    const seen = new Set<string>()
    const output: SongInfo[] = []
    for (const song of flattened) {
      const key = song.identifier || stableId(song)
      if (seen.has(key)) continue
      seen.add(key)
      output.push(song)
    }
    return output
  }
}

/**
 * 稳定 id：跨引擎重启不变，用于本地库去重与歌单引用。
 * 优先用音源内的 identifier，缺失时退化为「歌名|歌手|专辑」的 md5。
 */
export function stableId(song: SongInfo): string {
  const identifier = cleanText(song.identifier)
  if (identifier) return `${song.source}:${identifier}`
  const raw = `${song.songName}|${song.singers}|${song.album}`
  return `${song.source}:${md5Hex(raw).slice(0, 16)}`
}
