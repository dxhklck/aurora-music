import { existsSync } from 'node:fs'
import { clamp, stableId } from './base'
import { pickBest, readSearchCache, recall, remember, withSearchLock, writeSearchCache } from './cache'
import { EngineError } from './errors'
import { downloadHls, type HlsProgress } from './hls'
import { withFailureScope } from './http'
import { writeTags, type TagPayload, type TagResult } from './tag'
import { clearCaches } from './cache'
import { availableSources, createSource, hasSource, SOURCE_META } from './sources'
import { toInt, cleanText } from './text'
import type { ResolveQuery, SongInfo } from './types'

/**
 * 引擎门面：search / resolve / lyric / download / tag 五类操作。
 *
 * 对外只暴露「命令 → 结果」这一层，不做 transport。桌面端由主进程直接调用
 * （不再有 stdio 桥），Android 端可原样复用这层。
 *
 * **流式回调是真正的逐首推送**：解析完一首就回调一次，不是按页或定时批量。
 * 首批结果因此更早出现，事件粒度也更细，但最终条数与分页切片保持一致。
 */

export interface EngineSong {
  id: string
  token: string
  name: string
  singers: string
  album: string
  ext: string
  durationMs: number
  sizeBytes: number
  bitrate: number
  codec: string
  coverUrl: string
  hasUrl: boolean
  protocol: string
}

export interface EngineSearchResult {
  items: EngineSong[]
  total: number
  page: number
  hasMore: boolean
  cost?: number
}

export interface EngineResolveResult {
  url: string
  headers: Record<string, string>
  cookies: Record<string, string>
  ext: string
  size: number
  bitrate: number
  codec: string
  protocol: string
  token: string
  lyric: string
  coverUrl: string
}

export const ENGINE_PAGE_SIZE = 10
export const ENGINE_MAX_RESULTS = 20
export const SEARCH_TIMEOUT_MS = 45_000

/**
 * 对外统一的单曲形态，所有音源解析结果都归一到这里。
 *
 * 所有数值都走 `_as_int` 语义（截断、失败归零），文本走 `_clean` 语义。
 * 少了这层归一，'3.5 MB'、'NULL'、'.FLAC' 这类平台脏值会直接流到 UI。
 */
export function toEngineSong(song: SongInfo): EngineSong {
  const rawExt = song.ext || 'mp3'
  return {
    // identifier 经 cleanText 后为空时，id 退回元信息 md5（见 cache.stableId）
    id: cleanText(song.identifier) || stableId(song).split(':').slice(1).join(':'),
    token: remember(song),
    name: cleanText(song.songName),
    singers: cleanText(song.singers),
    album: cleanText(song.album),
    ext: cleanText(rawExt).replace(/^\.+/, ''),
    durationMs: toInt(song.durationS) * 1000,
    sizeBytes: toInt(song.fileSizeBytes),
    bitrate: toInt(song.bitrate),
    codec: cleanText(song.codec),
    coverUrl: cleanText(song.coverUrl),
    hasUrl: Boolean(song.downloadUrl && /^https?:/i.test(song.downloadUrl)),
    protocol: (cleanText(song.protocol) || 'HTTP').toUpperCase()
  }
}

export interface SearchParams {
  source: string
  keyword: string
  page?: number
  limit?: number
  /**
   * 请求 id：仅用于日志与调试时串起一次搜索，业务逻辑不依赖它——
   * 是否推送 partial 由 `onPartial` 是否存在决定。
   */
  requestId?: number
}

/** 45 秒上限：平台重试链可能拖到一两分钟，UI 不能无限等 */
function withTimeout<T>(task: Promise<T>, label: string, ms = SEARCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EngineError('timeout', `${label} 搜索超时（>${Math.round(ms / 1000)}s）`)), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export async function search(
  params: SearchParams,
  onPartial?: (items: EngineSong[]) => void
): Promise<EngineSearchResult> {
  const source = String(params.source ?? '')
  const keyword = String(params.keyword ?? '').trim()
  const page = Math.max(1, toInt(params.page ?? 1, 1))
  const limit = clamp(toInt(params.limit ?? ENGINE_PAGE_SIZE, ENGINE_PAGE_SIZE), 1, ENGINE_PAGE_SIZE)
  if (!keyword) return { items: [], total: 0, page, hasMore: false }
  if (!hasSource(source)) throw new EngineError('unsupported', `未知音源：${source}`)

  const cacheKey = `${source}|${keyword}|${page}|${limit}`
  const cached = readSearchCache<EngineSearchResult>(cacheKey)
  if (cached) return cached

  return withSearchLock(cacheKey, async () => {
    const again = readSearchCache<EngineSearchResult>(cacheKey)
    if (again) return again
    return runSearch(source, keyword, page, limit, cacheKey, onPartial)
  })
}

async function runSearch(
  source: string,
  keyword: string,
  page: number,
  limit: number,
  cacheKey: string,
  onPartial: ((items: EngineSong[]) => void) | undefined
): Promise<EngineSearchResult> {
  const started = Date.now()
  const client = createSource(source)
  if (!client) throw new EngineError('unsupported', `未知音源：${source}`)

  // 翻页只能「多召回再切片」：musicdl 的召回条数在构造期就固化进了搜索 URL
  const want = Math.min(limit * Math.min(page, 2), ENGINE_MAX_RESULTS)
  const seen = new Set<string>()
  // 有没有回调就是「要不要流式」的信号：进程内直接看 onPartial 即可，
  // 不需要额外的标志位。
  const emit = onPartial

  const failure = { errors: 0 }
  let songs: SongInfo[] = []
  try {
    songs = await withFailureScope(failure, () =>
      withTimeout(
        client.search({
          keyword,
          size: want,
          onItem: (song) => {
            if (!emit) return
            try {
              const payload = toEngineSong(song)
              if (seen.has(payload.id)) return
              seen.add(payload.id)
              emit([payload])
            } catch {
              /* 单条转换失败不打断搜索 */
            }
          }
        }),
        client.label
      )
    )
  } catch (error) {
    if (error instanceof EngineError) throw error
    throw new EngineError('internal', error instanceof Error ? error.message : String(error))
  }

  const payload = songs.filter((song) => Boolean(song.songName)).map((song) => toEngineSong(song))
  // 空结果 + 上游报过错 = 平台接口异常，必须与「真没这首歌」区分开
  if (!payload.length && failure.errors > 0) {
    throw new EngineError('blocked', `音源接口异常（本次搜索 ${failure.errors} 次请求失败），请换其他音源或稍后再试`)
  }

  const total = payload.length
  const start = (page - 1) * limit
  const result: EngineSearchResult = {
    items: payload.slice(start, start + limit),
    total,
    page,
    hasMore: page < 2 && start + limit < total,
    cost: Date.now() - started
  }
  writeSearchCache(cacheKey, result)
  return result
}

/** token 失效时按元信息重新定位同一首歌 */
async function resolveSongInfo(query: ResolveQuery): Promise<SongInfo> {
  const source = String(query.source ?? '')
  if (!hasSource(source)) throw new EngineError('unsupported', `未知音源：${source}`)

  if (query.token) {
    const cached = recall(query.token)
    if (cached) return cached
  }

  let keyword = String(query.keyword ?? '').trim()
  if (!keyword) {
    const name = String(query.name ?? '').trim()
    const artists = String(query.artists ?? '').trim()
    keyword = `${name} ${artists}`.trim()
  }
  if (!keyword) throw new EngineError('invalid', '缺少歌曲信息，无法定位资源')

  const client = createSource(source)
  if (!client) throw new EngineError('unsupported', `未知音源：${source}`)
  const failure = { errors: 0 }
  const size = clamp(toInt(query.size ?? 12, 12), 1, 50)
  const songs = await withFailureScope(failure, () => client.search({ keyword, size }))
  if (!songs.length && failure.errors > 0) {
    throw new EngineError('blocked', `音源接口异常（${failure.errors} 次请求失败），请换其他音源或稍后再试`)
  }
  const matched = pickBest({ name: query.name, artists: query.artists, durationMs: query.durationMs }, songs)
  if (!matched) throw new EngineError('notfound', `${labelOf(source)} 未找到匹配曲目`)
  return matched
}

function labelOf(source: string): string {
  return SOURCE_META.find((item) => item.key === source)?.label ?? source
}

export async function resolve(query: ResolveQuery): Promise<EngineResolveResult> {
  const song = await resolveSongInfo(query)
  if (!song.downloadUrl) {
    throw new EngineError('blocked', `${labelOf(song.source)} 未返回可用播放地址`)
  }
  // 「有地址但不是 http」单独给 unsupported（加密流），不能与 blocked 混在一起——
  // 上层会把它显示成「没版权」而不是「不支持」。
  if (!/^https?:/i.test(song.downloadUrl)) {
    throw new EngineError('unsupported', '该音源返回的是加密流，当前引擎无法直连')
  }
  return {
    url: song.downloadUrl,
    headers: { ...song.headers },
    cookies: { ...song.cookies },
    ext: cleanText(song.ext || 'mp3').replace(/^\.+/, ''),
    size: toInt(song.fileSizeBytes),
    bitrate: toInt(song.bitrate),
    codec: cleanText(song.codec),
    protocol: (cleanText(song.protocol) || 'HTTP').toUpperCase(),
    token: remember(song),
    lyric: song.lyric,
    coverUrl: song.coverUrl
  }
}

/** 歌词：音源在解析地址时已顺带回填，拿不到就返回空串，交给上层走 LRCLIB */
export async function lyric(query: ResolveQuery): Promise<{ lyric: string; source: string }> {
  const song = await resolveSongInfo(query)
  return { lyric: song.lyric, source: labelOf(song.source) }
}

export interface DownloadParams extends ResolveQuery {
  path: string
  taskId?: string
}

/** 引擎侧下载：目前只服务 HLS，HTTP 直链由主进程 DownloadManager 自己流式下载 */
export async function downloadHlsTo(
  params: DownloadParams,
  onProgress?: (received: number, total: number) => void
): Promise<{ path: string; size: number }> {
  const song = await resolveSongInfo(params)
  if (!params.path) throw new EngineError('invalid', '缺少目标路径')
  if (!song.downloadUrl) throw new EngineError('blocked', '没有可用的下载地址')

  const progress: HlsProgress | undefined = onProgress ? (received, total) => onProgress(received, total) : undefined
  const result = await downloadHls({
    url: song.downloadUrl,
    target: params.path,
    headers: song.headers,
    cookies: song.cookies,
    onProgress: progress
  })
  onProgress?.(result.size, result.size)
  return { path: result.path, size: result.size }
}

export async function tag(payload: TagPayload): Promise<TagResult> {
  // 文件不存在是 notfound，不是「写入失败」：两者对用户的含义完全不同。
  if (!payload.path || !existsSync(payload.path)) {
    throw new EngineError('notfound', '文件不存在')
  }
  return writeTags(payload)
}

export function ping(): Record<string, unknown> {
  return {
    version: 'ts-1.0.0',
    executable: 'node',
    runtime: `node ${process.versions.node}`,
    sources: availableSources().map((item) => ({ key: item.key, label: item.label }))
  }
}

export function sources(): Array<{ key: string; label: string }> {
  return availableSources().map((item) => ({ key: item.key, label: item.label }))
}

export function reset(): void {
  clearCaches()
}

export { EngineError, SOURCE_META }
export type { SongInfo }
