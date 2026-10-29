import type {
  ChartSummary,
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { parseLrc } from '@shared/lyric'
import { BaseProvider, DESKTOP_UA } from './base'
import { ProviderError } from './types'
import { mediaUrl } from '../media'
import { decodeHtml } from '../utils'
import { musicdl, type EngineSong, type ResolveQuery } from '../engine/musicdl'
import { EngineError } from '../engine/ts/errors'
import { MUSICDL_SOURCES, type SourceSpec } from './musicdl-sources'

export { MUSICDL_SOURCES }
export type { SourceSpec }

const LOSSLESS_EXT = new Set(['flac', 'wav', 'ape', 'alac', 'dsf', 'dff', 'wv', 'tta'])

/**
 * 酷狗精选榜单（顺序即展示顺序）：rankid 来自 kugou.com/yy/html/rank.html。
 * 蜂鸟流行音乐榜（59703）只在 PC 端详情页有数据（内嵌 global.features，首屏 22 首）；
* 其余三个走 m.kugou.com 移动接口（30 首/页，可翻页）。
 */
const KUGOU_CHARTS = [
  { id: '6666', name: '酷狗飙升榜' },
  { id: '8888', name: '酷狗TOP500' },
  { id: '59703', name: '蜂鸟流行音乐榜' },
  { id: '52144', name: '短视频热歌榜' }
]

const KUGOU_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

/** 咪咕 v5 网页版（music.migu.cn/v5）榜单接口的请求头 */
const MIGU_HEADERS: Record<string, string> = {
  'User-Agent': DESKTOP_UA,
  Referer: 'https://music.migu.cn/v5/',
  Origin: 'https://music.migu.cn'
}

/** 咪咕榜单条目（rank-index 目录） */
interface MiguRankItem {
  rankId?: string
  rankName?: string
  imageUrl?: string
}

/** 咪咕榜单歌曲条目（rank-info） */
interface MiguRankSong {
  resId?: string
  txt?: string
  txt2?: string
  txt3?: string
  img?: string
  vip?: string
  songData?: string
}

/** 酷狗榜单歌曲条目：移动 JSON 与 PC 页内 features 两种形态的字段合集 */
interface KugouRankSong {
  hash?: string
  Hash?: string
  songname?: string
  FileName?: string
  authors?: Array<{ author_name?: string }>
  author_name?: string
  remark?: string
  duration?: number
  timeLen?: number
  album_sizable_cover?: string
}

/** 从 HTML 里取 `marker = [...]` 的 JSON 数组（括号配平扫描，容忍字符串内括号） */
function extractEmbeddedJson(html: string, marker: string): unknown[] {
  const at = html.indexOf(marker)
  if (at < 0) return []
  const start = html.indexOf('[', at)
  if (start < 0) return []
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as unknown[]
        } catch {
          return []
        }
      }
    }
  }
  return []
}

const NULLISH = new Set(['null', 'none', 'nil', 'undefined', 'n/a', 'na'])

function cleanText(value: string): string {
  const text = (value ?? '').trim()
  return NULLISH.has(text.toLowerCase()) ? '' : text
}

function splitArtists(singers: string): string[] {
  return cleanText(singers)
    .split(/[/、,&;]| feat\.? | ft\.? /i)
    .map((item) => cleanText(item))
    .filter(Boolean)
}

function cookiesToHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ')
}

function qualityOf(ext: string, bitrate: number): Quality {
  if (LOSSLESS_EXT.has(ext)) return 'lossless'
  if (bitrate >= 256_000 || bitrate >= 256) return 'high'
  return 'standard'
}

function labelOf(ext: string, bitrate: number): string {
  const kbps = bitrate > 10_000 ? Math.round(bitrate / 1000) : Math.round(bitrate)
  if (LOSSLESS_EXT.has(ext)) return `${ext.toUpperCase()} 无损`
  if (kbps > 0) return `${kbps}k ${ext.toUpperCase()}`
  return ext.toUpperCase()
}

/**
 * 一个 MusicdlProvider 实例 = 引擎里的一个平台。
 * 平台差异（签名、字段、鉴权）全在引擎侧，这里只做模型转换与错误归一化。
 */
export class MusicdlProvider extends BaseProvider {
  readonly info: ProviderInfo

  constructor(private readonly spec: SourceSpec) {
    super()
    this.info = {
      id: `mdl-${spec.key}`,
      name: spec.name,
      short: spec.short,
      color: spec.color,
      gradient: spec.gradient,
      capabilities: {
        search: true,
        charts: this.spec.key === 'kugou' || this.spec.key === 'migu',
        stream: true,
        lyric: true
      },
      description: spec.description,
      note: spec.note ?? '由 musicdl 引擎提供，首次使用需加载引擎'
    }
  }

  get sourceKey(): string {
    return this.spec.key
  }

  /** 酷狗榜单页缓存（5 分钟）：key = rankid:apiPage 或 rankid:html */
  private kugouPageCache = new Map<string, { songs: Song[]; total: number; at: number }>()

  private kugouApiHeaders(): Record<string, string> {
    return { 'User-Agent': KUGOU_MOBILE_UA, Referer: 'https://m.kugou.com/' }
  }

  async charts(): Promise<ChartSummary[]> {
    if (this.spec.key === 'kugou') {
      return KUGOU_CHARTS.map((chart) => ({
        id: chart.id,
        platform: this.info.id,
        name: chart.name,
        coverUrl: null,
        updateFrequency: '每日更新'
      }))
    }
    if (this.spec.key === 'migu') return this.miguCharts()
    return []
  }

  async chartDetail({
    id,
    page,
    limit
  }: {
    id: string
    page: number
    limit: number
  }): Promise<SearchPage> {
    if (this.spec.key === 'migu') return this.miguChartDetail(id, page, limit)
    if (this.spec.key !== 'kugou') return { items: [], total: 0, page, hasMore: false }
    // 蜂鸟榜只有 PC 详情页数据（首屏 22 首，无翻页接口）
    if (id === '59703') {
      if (page > 1) return { items: [], total: 0, page, hasMore: false }
      const key = `${id}:html`
      const cached = this.kugouPageCache.get(key)
      let songs: Song[]
      let total: number
      if (cached && Date.now() - cached.at < 5 * 60_000) {
        songs = cached.songs
        total = cached.total
      } else {
        const html = await this.text(
          `https://www.kugou.com/yy/rank/home/1-${id}.html?from=rank`,
          { headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://www.kugou.com/' } }
        )
        const features = extractEmbeddedJson(html, 'global.features') as KugouRankSong[]
        songs = features.map((item) => this.kugouFeatureSong(item)).filter((s) => s.id && s.name)
        total = songs.length
        this.kugouPageCache.set(key, { songs, total, at: Date.now() })
      }
      return { items: songs.slice(0, limit), total, page, hasMore: false }
    }

    // 移动接口固定 30 首/页：把请求的 offset 区间映射到所需接口页（一般 1-2 页）
    const pageSize = 30
    const start = (page - 1) * limit
    const end = start + limit
    const firstPage = Math.floor(start / pageSize) + 1
    const lastPage = Math.floor((end - 1) / pageSize) + 1
    const tracks: Song[] = []
    let total = 0
    try {
      for (let apiPage = firstPage; apiPage <= lastPage; apiPage++) {
        const entry = await this.kugouRankPage(id, apiPage)
        total = entry.total
        tracks.push(...entry.songs)
      }
    } catch (error) {
      if (!tracks.length) throw this.toProviderError(error)
    }
    const offset = start - (firstPage - 1) * pageSize
    return {
      items: tracks.slice(offset, offset + limit),
      total,
      page,
      hasMore: end < total
    }
  }

  private async kugouRankPage(id: string, apiPage: number): Promise<{ songs: Song[]; total: number }> {
    const key = `${id}:${apiPage}`
    const cached = this.kugouPageCache.get(key)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached
    const data = await this.json<{ songs?: { list?: KugouRankSong[]; total?: number } }>(
      `https://m.kugou.com/rank/info/?rankid=${id}&page=${apiPage}&json=true`,
      { headers: this.kugouApiHeaders() }
    )
    const songs = (data.songs?.list ?? []).map((item) => this.kugouJsonSong(item))
    const entry = { songs, total: data.songs?.total ?? songs.length, at: Date.now() }
    this.kugouPageCache.set(key, entry)
    return entry
  }

  /** 移动接口条目 → Song（无 token，播放时引擎按关键词解析地址） */
  private kugouJsonSong(item: KugouRankSong): Song {
    const cover = (item.album_sizable_cover ?? '').replace('{size}', '240')
    return {
      id: String(item.hash ?? ''),
      platform: this.info.id,
      name: cleanText(item.songname ?? ''),
      artists: splitArtists((item.authors ?? []).map((a) => a.author_name ?? '').join('/')),
      album: cleanText(item.remark ?? ''),
      coverUrl: cover.startsWith('http') ? mediaUrl(cover, 'https://www.kugou.com/') : null,
      duration: (item.duration ?? 0) * 1000,
      streamable: true,
      extra: { engine: this.spec.key }
    }
  }

  /** PC 页内 features 条目：FileName 形如「歌手 - 歌名」 */
  private kugouFeatureSong(item: KugouRankSong): Song {
    const file = decodeHtml(cleanText(item.FileName ?? ''))
    const sep = file.indexOf(' - ')
    const artist = sep > 0 ? file.slice(0, sep) : cleanText(item.author_name ?? '')
    return {
      id: String(item.Hash ?? ''),
      platform: this.info.id,
      name: sep > 0 ? file.slice(sep + 3) : file,
      artists: artist ? artist.split('/').filter(Boolean) : [],
      album: '',
      coverUrl: null,
      duration: (item.timeLen ?? 0) * 1000,
      streamable: true,
      extra: { engine: this.spec.key }
    }
  }

  protected baseHeaders(): Record<string, string> {
    return this.spec.referer ? { Referer: this.spec.referer } : {}
  }

  /* ---------------- 咪咕榜单（v5 网页版 /pc/bmw/rank 接口） ---------------- */

  /** 咪咕榜单目录缓存（10 分钟）：尖叫榜组在前、特色榜组在后（组内保持官方顺序） */
  private miguIndexCache: { items: ChartSummary[]; at: number } | null = null

  private async miguCharts(): Promise<ChartSummary[]> {
    if (this.miguIndexCache && Date.now() - this.miguIndexCache.at < 10 * 60_000) {
      return this.miguIndexCache.items
    }
    const resp = await this.json<{
      data?: { contents?: Array<{ style?: string; contents?: MiguRankItem[] }> }
    }>('https://app.u.nf.migu.cn/pc/bmw/rank/rank-index/v1.0', { headers: MIGU_HEADERS })
    const groups = resp.data?.contents ?? []
    // 尖叫榜（热歌/新歌/原创/国风）是咪咕的官方正主，排前面；特色榜（抖音/免费/会员…）跟随
    const sorted = [...groups].sort((a, b) =>
      a.style?.includes('尖叫') ? -1 : b.style?.includes('尖叫') ? 1 : 0
    )
    const items: ChartSummary[] = []
    for (const group of sorted) {
      for (const item of group.contents ?? []) {
        if (!item.rankId || !item.rankName) continue
        items.push({
          id: String(item.rankId),
          platform: this.info.id,
          name: item.rankName,
          coverUrl: item.imageUrl ? mediaUrl(item.imageUrl, MIGU_HEADERS.Referer) : null,
          updateFrequency: '每日更新'
        })
      }
    }
    if (!items.length) throw new ProviderError('empty', '咪咕榜单目录为空', this.info.id)
    this.miguIndexCache = { items, at: Date.now() }
    return items
  }

  private async miguChartDetail(
    id: string,
    page: number,
    limit: number
  ): Promise<SearchPage> {
    const start = (page - 1) * limit
    const end = start + limit
    // 接口一次返回全量（热歌榜 100 首，hasNextPage=false），无分页参数；整榜缓存后切片
    const key = `migu:${id}`
    const cached = this.kugouPageCache.get(key)
    let songs: Song[]
    let total: number
    if (cached && Date.now() - cached.at < 10 * 60_000) {
      songs = cached.songs
      total = cached.total
    } else {
      const resp = await this.json<{
        data?: { contents?: MiguRankSong[]; totalCount?: number }
      }>(
        `https://app.u.nf.migu.cn/pc/bmw/rank/rank-info/v1.0?rankId=${id}&rankType=0&period=day`,
        { headers: MIGU_HEADERS }
      )
      songs = (resp.data?.contents ?? [])
        .map((item) => this.miguSong(item))
        .filter((s) => s.id && s.name)
      total = resp.data?.totalCount ?? songs.length
      this.kugouPageCache.set(key, { songs, total, at: Date.now() })
    }
    return { items: songs.slice(start, end), total, page, hasMore: end < total }
  }

  /** 咪咕榜单条目 → Song（无 token，播放时引擎按关键词解析地址）；时长在 songData JSON 里，单位秒 */
  private miguSong(item: MiguRankSong): Song {
    let duration = 0
    try {
      const meta = JSON.parse(item.songData ?? '{}') as { duration?: number }
      duration = Math.round((meta.duration ?? 0) * 1000)
    } catch {
      /* songData 缺失/非法时忽略时长 */
    }
    return {
      id: String(item.resId ?? ''),
      platform: this.info.id,
      name: cleanText(item.txt ?? ''),
      artists: splitArtists(cleanText(item.txt2 ?? '')),
      album: cleanText(item.txt3 ?? ''),
      coverUrl: item.img ? mediaUrl(item.img, MIGU_HEADERS.Referer) : null,
      duration,
      streamable: true,
      extra: { engine: this.spec.key }
    }
  }

  async search({
    keyword,
    page,
    limit,
    onPartial
  }: {
    keyword: string
    page: number
    limit: number
    onPartial?: (items: Song[]) => void
  }): Promise<SearchPage> {
    try {
      // 引擎每个结果都要解析真实地址，一页 10 条约 5-10 秒；
      // 按用户设置一次要 30 条会直接卡住界面，这里强制收敛到 10。
      const size = Math.min(limit, 10)
      const result = onPartial
        ? await musicdl.searchStream(this.spec.key, keyword, page, size, (items) => {
            const songs = items.map((item) => this.toSong(item))
            if (songs.length) onPartial(songs)
          })
        : await musicdl.search(this.spec.key, keyword, page, size)
      return {
        items: result.items.map((item) => this.toSong(item)),
        total: result.total,
        page: result.page,
        hasMore: result.hasMore,
        cost: result.cost
      }
    } catch (error) {
      throw this.toProviderError(error)
    }
  }

  private toSong(item: EngineSong): Song {
    return {
      id: item.id,
      platform: this.info.id,
      name: item.name,
      artists: splitArtists(item.singers),
      album: cleanText(item.album),
      coverUrl: item.coverUrl ? mediaUrl(item.coverUrl, this.spec.referer) : null,
      duration: item.durationMs,
      fileSize: item.sizeBytes || undefined,
      qualityLabel: item.ext ? labelOf(item.ext, item.bitrate) : undefined,
      qualityMax: item.ext ? qualityOf(item.ext, item.bitrate) : undefined,
      streamable: item.hasUrl,
      extra: {
        token: item.token,
        ext: item.ext,
        protocol: item.protocol,
        engine: this.spec.key
      }
    }
  }

  private queryOf(song: Song): ResolveQuery {
    return {
      source: this.spec.key,
      token: typeof song.extra?.token === 'string' ? song.extra.token : undefined,
      name: song.name,
      artists: song.artists.join('/'),
      durationMs: song.duration,
      keyword: `${song.name} ${song.artists[0] ?? ''}`.trim()
    }
  }

  async resolveStream(song: Song, _quality: Quality): Promise<StreamInfo> {
    let resolved
    try {
      resolved = await musicdl.resolve(this.queryOf(song))
    } catch (error) {
      throw this.toProviderError(error)
    }

    const headers: Record<string, string> = { ...resolved.headers }
    const cookie = cookiesToHeader(resolved.cookies)
    if (cookie) headers.Cookie = cookie

    // 引擎给的地址同样要实测：平台经常返回 200 的 HTML 错误页
    const probe = await this.probe(resolved.url, this.spec.referer, headers)
    if (!probe.ok) {
      throw new ProviderError('blocked', `${this.info.name} 返回的地址不可播放（${probe.status}）`, this.info.id)
    }

    const format = (resolved.ext || 'mp3').toLowerCase()
    return {
      url: mediaUrl(probe.finalUrl || resolved.url, this.spec.referer),
      directUrl: probe.finalUrl || resolved.url,
      headers,
      protocol: resolved.protocol === 'HLS' ? 'hls' : 'http',
      quality: qualityOf(format, resolved.bitrate),
      label: labelOf(format, resolved.bitrate),
      format,
      expiresAt: Date.now() + 8 * 60_000
    }
  }

  async lyric(song: Song): Promise<Lyric | null> {
    try {
      const { lyric } = await musicdl.lyric(this.queryOf(song))
      if (!lyric.trim()) return null
      const parsed = parseLrc(lyric)
      if (parsed.lines.length) {
        return {
          lines: parsed.lines,
          offset: parsed.offset,
          translated: false,
          source: this.info.name
        }
      }
      return { lines: [], offset: 0, translated: false, source: this.info.name, plain: lyric }
    } catch {
      // 歌词失败不应该影响播放；交给 catalog 走 LRCLIB 兜底
      return null
    }
  }

  private toProviderError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error
    if (error instanceof EngineError) {
      const code =
        error.code === 'notfound'
          ? 'empty'
          : error.code === 'blocked' || error.code === 'unsupported'
            ? 'blocked'
            : error.code === 'timeout'
              ? 'network'
              : 'network'
      return new ProviderError(code, `${this.info.name}：${error.message}`, this.info.id)
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('引擎')) {
      return new ProviderError(
        'unsupported',
        `音源引擎异常：${message}。请在设置页点「重新检测」`,
        this.info.id
      )
    }
    return new ProviderError('network', `${this.info.name}：${message}`, this.info.id)
  }
}
