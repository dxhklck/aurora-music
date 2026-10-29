import type {
  ChartSummary,
  Lyric,
  Quality,
  ResolvedTrack,
  SearchPage,
  Song
} from '@shared/types'
import { parseLrc } from '@shared/lyric'
import { providers } from '../providers'
import { ProviderError } from '../providers/types'
import { TtlCache } from './cache'
import { settings } from './settings'

const searchCache = new TtlCache<SearchPage>(3 * 60_000, 120)
const chartCache = new TtlCache<SearchPage>(10 * 60_000, 60)

/**
 * 增量结果订阅者（按搜索 key 分组）。
 *
 * 缓存层会把同一 key 的并发请求合并成一次上游调用，但「谁在等」是多个调用方——
 * 直接把第一个调用方的 onPartial 塞进 factory，第二个调用方就收不到任何增量，
 * 页面会一直空着直到整批完成。这里按 key 维护订阅者集合，由 factory 统一广播。
 */
const partialListeners = new Map<string, Set<(items: Song[]) => void>>()

/**
 * 取址结果缓存。
 *
 * 取一次播放地址要三趟往返（取 URL → probe 实测 → 嗅探封装），一秒起。
 * 而「上一首 / 列表循环 / 拖动后重播」都会对同一首歌重复取址——这是纯浪费。
 * 每个 provider 都已经算了 `StreamInfo.expiresAt`，只是从来没人用。
 *
 * 上限 3 分钟而不是直接信 expiresAt：CDN 临时吊销签名时缓存会把死链多喂一次，
 * 窗口越短越安全，3 分钟已足够覆盖连续播放与来回切歌。
 */
const streamCache = new Map<string, { track: ResolvedTrack; expireAt: number }>()
const STREAM_CACHE_MAX = 80
const STREAM_CACHE_CAP = 3 * 60_000
/** 离过期不到这么久就不用缓存了，避免刚过期就命中 */
const STREAM_CACHE_MARGIN = 60_000

/**
 * 换源熔断。
 *
 * `findAlternative` 是串行试候选，每个都要等满超时才算失败——一个坏源就能让
 * 「换源」多花 6~8 秒。这里记「刚失败过的平台」，短时间内直接跳过，
 * 退避 30s 起、翻倍、封顶 5 分钟，到点自动半开重试。
 */
const breaker = new Map<string, { fails: number; until: number }>()
const BREAKER_BASE = 30_000
const BREAKER_MAX = 5 * 60_000

export interface SearchInput {
  platform: string
  keyword: string
  page?: number
  limit?: number
  /** 增量结果回调（只有慢音源会触发），用于边搜边出 */
  onPartial?: (items: Song[]) => void
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_（）()【】[\]·,，.。'’!！?？]/g, '')
}

/** 给「换源」这种可放弃的尝试加个硬超时，超时返回 null 而不是一直挂着 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    task
      .then((value) => resolve(value))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer))
  })
}

/**
 * 目录服务：搜索 / 榜单 / 歌词 / 播放地址。
 * 这一层负责缓存、限流、错误归一化与跨平台换源，Provider 只关心自己平台。
 */
class CatalogService {
  async search({ platform, keyword, page = 1, limit, onPartial }: SearchInput): Promise<SearchPage> {
    const trimmed = keyword.trim()
    if (!trimmed) return { items: [], total: 0, page, hasMore: false }
    const size = Math.min(Math.max(limit ?? settings.get().searchLimit, 1), 50)
    const key = `search:${platform}:${trimmed}:${page}:${size}`
    const started = Date.now()
    if (onPartial) {
      const listeners = partialListeners.get(key) ?? new Set()
      listeners.add(onPartial)
      partialListeners.set(key, listeners)
    }
    try {
      const result = await searchCache.wrap(
        key,
        async () => {
          const provider = providers.get(platform)
          if (!provider.info.capabilities.search) {
            throw new ProviderError('unsupported', `${provider.info.name} 不支持搜索`, platform)
          }
          return provider.search({
            keyword: trimmed,
            page,
            limit: size,
            onPartial: (items) => {
              // 用 key 现查订阅者：factory 可能是上一个调用方创建的，不能闭包捕获某个回调
              const listeners = partialListeners.get(key)
              if (!listeners) return
              for (const listener of listeners) listener(items)
            }
          })
        },
        // 引擎音源一次搜索要 5-10 秒，缓存短了等于每次都在等
        platform.startsWith('mdl-') ? 10 * 60_000 : undefined
      )
      return { ...result, cost: Date.now() - started }
    } finally {
      if (onPartial) {
        const listeners = partialListeners.get(key)
        if (listeners) {
          listeners.delete(onPartial)
          if (!listeners.size) partialListeners.delete(key)
        }
      }
    }
  }

  async charts(platform: string): Promise<ChartSummary[]> {
    const provider = providers.get(platform)
    if (!provider.info.capabilities.charts) return []
    return provider.charts()
  }

  async chartDetail(platform: string, id: string, page = 1, limit = 40): Promise<SearchPage> {
    const key = `chart:${platform}:${id}:${page}:${limit}`
    return chartCache.wrap(key, () => providers.get(platform).chartDetail({ id, page, limit }))
  }

  /**
   * 解析播放地址。
   * 优先原平台；若失败且开启自动换源，则在其它平台按「歌名 + 歌手」模糊匹配后重试。
   */
  async resolveTrack(song: Song, autoSwitch = true, forceSwitch = false): Promise<ResolvedTrack> {
    const quality: Quality = settings.get().quality
    const cacheKey = `${song.platform}:${song.id}:${quality}`
    // forceSwitch 的语义是「这个地址可疑，换一个」：不读缓存，但新结果要覆盖回去
    if (!forceSwitch) {
      const cached = this.readStream(cacheKey)
      if (cached) return cached
    }
    const provider = providers.get(song.platform)
    // forceSwitch：跳过原平台直接跨源（用于音频流停滞——URL 本身有效，重取大概率还是同一个 CDN）
    if (forceSwitch) {
      const alternative = await this.findAlternative(song, quality)
      if (alternative) {
        const sourceName = providers.get(alternative.song.platform).info.name
        const track = this.rememberStream(cacheKey, alternative)
        return {
          ...track,
          switchedFrom: song.platform,
          notice: `音频流停滞，已自动切换到 ${sourceName}`
        }
      }
      throw new ProviderError('network', '停滞重试失败：其它音源也没有找到可播放的版本')
    }
    try {
      const stream = await provider.resolveStream(song, quality)
      return this.rememberStream(cacheKey, { song, stream })
    } catch (error) {
      if (!autoSwitch) throw this.normalizeError(error, provider.info.name)
      const alternative = await this.findAlternative(song, quality)
      if (!alternative) throw this.normalizeError(error, provider.info.name)
      const sourceName = providers.get(alternative.song.platform).info.name
      const track = this.rememberStream(cacheKey, alternative)
      return {
        ...track,
        switchedFrom: song.platform,
        notice: `原音源无法播放，已自动切换到 ${sourceName}`
      }
    }
  }

  /** 缓存命中直接复用同一个对象（调用方只读，不复制） */
  private readStream(key: string): ResolvedTrack | null {
    const entry = streamCache.get(key)
    if (!entry) return null
    if (entry.expireAt <= Date.now()) {
      streamCache.delete(key)
      return null
    }
    return entry.track
  }

  /** 只缓存 {song, stream}：switchedFrom/notice 是「这一次」的提示，缓存进去会反复弹 */
  private rememberStream(key: string, track: { song: Song; stream: ResolvedTrack['stream'] }): ResolvedTrack {
    const expiresAt = track.stream.expiresAt
    if (Number.isFinite(expiresAt)) {
      const expireAt = Math.min(expiresAt - STREAM_CACHE_MARGIN, Date.now() + STREAM_CACHE_CAP)
      if (expireAt > Date.now()) {
        if (streamCache.size >= STREAM_CACHE_MAX) {
          const oldest = streamCache.keys().next().value
          if (oldest) streamCache.delete(oldest)
        }
        streamCache.set(key, { track, expireAt })
      }
    }
    return track
  }

  /**
   * 作废某首歌的取址缓存。
   * 下载失败重试前必须调用：否则三次重试都用同一个已吊销的地址，必然全失败。
   */
  invalidateStream(song: Song): void {
    const prefix = `${song.platform}:${song.id}:`
    for (const key of [...streamCache.keys()]) {
      if (key.startsWith(prefix)) streamCache.delete(key)
    }
  }

  /** 熔断中的平台：短时间内不再作为换源候选，避免每次都等满超时 */
  private isTripped(providerId: string): boolean {    const entry = breaker.get(providerId)
    if (!entry) return false
    if (entry.until <= Date.now()) {
      breaker.delete(providerId)
      return false
    }
    return true
  }

  private trip(providerId: string): void {
    const fails = (breaker.get(providerId)?.fails ?? 0) + 1
    const backoff = Math.min(BREAKER_BASE * 2 ** (fails - 1), BREAKER_MAX)
    breaker.set(providerId, { fails, until: Date.now() + backoff })
  }

  private normalizeError(error: unknown, providerName: string): ProviderError {
    if (error instanceof ProviderError) return error
    const message = error instanceof Error ? error.message : String(error)
    return new ProviderError('network', `${providerName}：${message}`)
  }

  private async findAlternative(song: Song, quality: Quality): Promise<ResolvedTrack | null> {
    // 只用歌名检索：带歌手名反而会让部分平台的搜索接口召回变差
    const keyword = song.name.trim()
    if (!keyword) return null

    // 候选排序：原生适配器优先（快、有榜单），引擎音源放后面且最多试 2 个。
    // 引擎单次搜索可能几十秒，无节制地遍历 15 个源会让「换源」变成「卡死」。
    const candidates = providers
      .streamCandidates(song.platform)
      .sort((a, b) => Number(a.info.id.startsWith('mdl-')) - Number(b.info.id.startsWith('mdl-')))
    const deadline = Date.now() + 12_000
    let engineTried = 0

    for (const candidate of candidates) {
      if (!candidate.info.capabilities.search) continue
      const isEngine = candidate.info.id.startsWith('mdl-')
      if (isEngine && engineTried >= 2) continue
      // 刚失败过的平台直接跳过：换源最怕的不是找不到，而是在一个死源上等满超时
      if (this.isTripped(candidate.info.id)) continue
      if (Date.now() > deadline) break
      if (isEngine) engineTried += 1
      try {
        const page = await withTimeout(
          candidate.search({ keyword, page: 1, limit: isEngine ? 5 : 8 }),
          isEngine ? 12_000 : 8_000
        )
        // 超时（null）不算平台坏了：只说明这次慢，下次还给它机会
        if (!page) continue
        const match = this.pickBest(song, page.items)
        if (!match) continue
        const stream = await candidate.resolveStream(match, quality)
        breaker.delete(candidate.info.id)
        return { song: match, stream }
      } catch (error) {
        // 只有传输/解析层面的失败才熔断。blocked（没版权）、empty、unsupported 都是
        // 「这首歌不行」，熔断它们等于因为一首 VIP 歌把整个平台拉黑
        if (error instanceof ProviderError && (error.code === 'network' || error.code === 'parse')) {
          this.trip(candidate.info.id)
        }
      }
    }
    return null
  }

  private pickBest(target: Song, candidates: Song[]): Song | null {
    let best: { song: Song; score: number } | null = null
    const targetName = normalize(target.name)
    const targetArtists = target.artists.map(normalize)

    for (const candidate of candidates) {
      const name = normalize(candidate.name)
      let score = 0
      if (name === targetName) score += 60
      else if (name.includes(targetName) || targetName.includes(name)) score += 35
      else continue

      const artists = candidate.artists.map(normalize)
      if (artists.some((artist) => targetArtists.some((t) => artist.includes(t) || t.includes(artist)))) {
        score += 30
      }
      if (target.duration && candidate.duration) {
        const diff = Math.abs(target.duration - candidate.duration)
        if (diff < 5_000) score += 10
        else if (diff > 30_000) score -= 15
      }
      if (!best || score > best.score) best = { song: candidate, score }
    }
    return best && best.score >= 70 ? best.song : null
  }

  /** 歌词：平台优先，失败或为空时回退公共歌词库 LRCLIB（musicdl LyricSearchClient 的同款思路） */
  async lyric(song: Song): Promise<Lyric | null> {
    const key = `lyric:${song.platform}:${song.id}`
    const cached = lyricCache.get(key)
    if (cached !== undefined) return cached

    let fromProvider: Lyric | null = null
    try {
      fromProvider = await providers.get(song.platform).lyric(song)
    } catch {
      fromProvider = null
    }
    if (fromProvider && fromProvider.lines.length) {
      lyricCache.set(key, fromProvider)
      return fromProvider
    }

    const external = await fetchLrclib(song)
    const result = external ?? fromProvider
    lyricCache.set(key, result, result ? 30 * 60_000 : 5 * 60_000)
    return result
  }
}

const lyricCache = new TtlCache<Lyric | null>(30 * 60_000, 120)

interface LrclibItem {
  trackName: string
  artistName: string
  duration: number
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

async function fetchLrclib(song: Song): Promise<Lyric | null> {
  const artist = song.artists[0] ?? ''
  const headers = { 'User-Agent': 'AuroraMusic/1.0 (desktop player)' }
  try {
    const params = new URLSearchParams({ artist_name: artist, track_name: song.name })
    if (song.duration) params.set('duration', String(Math.round(song.duration / 1000)))
    const response = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(8_000)
    })
    if (response.ok) {
      const item = (await response.json()) as LrclibItem
      const lyric = toLyric(item)
      if (lyric) return lyric
    }
  } catch {
    /* 继续尝试搜索接口 */
  }

  try {
    const response = await fetch(
      `https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${song.name}` }).toString()}`,
      { headers, signal: AbortSignal.timeout(8_000) }
    )
    if (!response.ok) return null
    const list = (await response.json()) as LrclibItem[]
    if (!Array.isArray(list) || !list.length) return null
    const scored = list
      .map((item) => ({
        item,
        score:
          (normalize(item.trackName) === normalize(song.name) ? 60 : 0) +
          (normalize(item.artistName).includes(normalize(artist)) ? 30 : 0) +
          (song.duration && Math.abs(item.duration * 1000 - song.duration) < 5000 ? 10 : 0)
      }))
      .sort((a, b) => b.score - a.score)
    return toLyric(scored[0].item)
  } catch {
    return null
  }
}

function toLyric(item: LrclibItem): Lyric | null {
  if (item.syncedLyrics) {
    const parsed = parseLrc(item.syncedLyrics)
    if (parsed.lines.length) {
      return {
        lines: parsed.lines,
        offset: parsed.offset,
        translated: false,
        source: 'LRCLIB'
      }
    }
  }
  if (item.plainLyrics) {
    return { lines: [], offset: 0, translated: false, source: 'LRCLIB', plain: item.plainLyrics }
  }
  return null
}


export const catalog = new CatalogService()
