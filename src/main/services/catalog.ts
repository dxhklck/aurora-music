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
    const provider = providers.get(song.platform)
    // forceSwitch：跳过原平台直接跨源（用于音频流停滞——URL 本身有效，重取大概率还是同一个 CDN）
    if (forceSwitch) {
      const alternative = await this.findAlternative(song, quality)
      if (alternative) {
        const sourceName = providers.get(alternative.song.platform).info.name
        return {
          ...alternative,
          switchedFrom: song.platform,
          notice: `音频流停滞，已自动切换到 ${sourceName}`
        }
      }
      throw new ProviderError('network', '停滞重试失败：其它音源也没有找到可播放的版本')
    }
    try {
      const stream = await provider.resolveStream(song, quality)
      return { song, stream }
    } catch (error) {
      if (!autoSwitch) throw this.normalizeError(error, provider.info.name)
      const alternative = await this.findAlternative(song, quality)
      if (!alternative) throw this.normalizeError(error, provider.info.name)
      const sourceName = providers.get(alternative.song.platform).info.name
      return {
        song: alternative.song,
        stream: alternative.stream,
        switchedFrom: song.platform,
        notice: `原音源无法播放，已自动切换到 ${sourceName}`
      }
    }
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
    const deadline = Date.now() + 15_000
    let engineTried = 0

    for (const candidate of candidates) {
      if (!candidate.info.capabilities.search) continue
      const isEngine = candidate.info.id.startsWith('mdl-')
      if (isEngine && engineTried >= 2) continue
      if (Date.now() > deadline) break
      if (isEngine) engineTried += 1
      try {
        const page = await withTimeout(
          candidate.search({ keyword, page: 1, limit: isEngine ? 5 : 8 }),
          isEngine ? 12_000 : 20_000
        )
        if (!page) continue
        const match = this.pickBest(song, page.items)
        if (!match) continue
        const stream = await candidate.resolveStream(match, quality)
        return { song: match, stream }
      } catch {
        /* 该平台也不可用，继续下一个 */
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
