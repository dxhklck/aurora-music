import type {
  ChartSummary,
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { BaseProvider, DESKTOP_UA } from './base'
import { ProviderError, type SearchArgs } from './types'
import { mediaUrl } from '../media'
import { decodeHtml } from '../utils'

/** 酷我 H5 页对 UA 敏感：用移动端 UA 才返回直出列表 */
const KUWO_MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

/**
 * 酷我适配器。
 * 搜索接口返回的是「单引号伪 JSON」，这里用字段级正则解析而不是整体 JSON.parse，
 * 避免歌手名里的撇号破坏解析（musicdl 用 json_repair 解决同类问题）。
 */
export class KuwoProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'kuwo',
    name: '酷我音乐',
    short: '酷我',
    color: '#ff8b00',
    gradient: ['#ffb347', '#b34700'],
    capabilities: { search: true, charts: true, stream: true, lyric: false },
    description: '免登录可直接播放，下载成功率高；官方 6 榜',
    note: '歌词走公共歌词库匹配'
  }

  private readonly referer = 'https://www.kuwo.cn/'

  /** 酷我精选 6 榜（顺序即展示顺序）：bid 对应 kuwo.cn/rankList「官方」分组 */
  private static readonly BANGS = [
    { bid: '16', name: '酷我热歌榜' },
    { bid: '93', name: '酷我飙升榜' },
    { bid: '17', name: '酷我新歌榜' },
    { bid: '158', name: '短视频酷我排行榜' },
    { bid: '176', name: '万物DJ榜' },
    { bid: '145', name: '会员畅听榜' }
  ]

  /** 榜单页缓存（5 分钟）：详情页一次直出全量（约 100-200 首） */
  private bangCache = new Map<string, { songs: Song[]; at: number }>()

  protected baseHeaders(): Record<string, string> {
    return {
      'User-Agent': DESKTOP_UA,
      Referer: this.referer,
      Accept: '*/*'
    }
  }

  async search({ keyword, page, limit }: SearchArgs): Promise<SearchPage> {
    const rn = Math.min(limit, 30)
    const url =
      'http://search.kuwo.cn/r.s?' +
      new URLSearchParams({
        all: keyword,
        ft: 'music',
        itemset: 'web_2013',
        client: 'kt',
        pn: String(page - 1),
        rn: String(rn),
        rformat: 'json',
        encoding: 'utf8'
      }).toString()

    const text = await this.text(url, { headers: { Referer: this.referer } })
    const items = this.extractItems(text)
    const total = Number((text.match(/'TOTAL':'(\d+)'/) ?? [])[1] ?? items.length)
    return {
      items,
      total,
      page,
      hasMore: (page - 1) * rn + items.length < total
    }
  }

  private extractItems(text: string): Song[] {
    const blocks = text.split("{'AARTIST':").slice(1)
    const songs: Song[] = []
    for (const block of blocks) {
      const rawId = this.field(block, 'MUSICRID') || this.field(block, 'DC_TARGETID')
      const id = rawId.replace(/^MUSIC_/, '')
      const name = this.field(block, 'SONGNAME')
      if (!id || !name) continue
      const duration = Number(this.field(block, 'DURATION') || 0) * 1000
      const artist = this.field(block, 'ARTIST')
      const picShort = this.field(block, 'web_albumpic_short')
      const formats = this.field(block, 'FORMATS')
      songs.push({
        id,
        platform: this.info.id,
        name,
        artists: artist ? artist.split(/[&,、/]/).map((s) => s.trim()).filter(Boolean) : [],
        album: this.field(block, 'ALBUM'),
        coverUrl: picShort ? mediaUrl(`https://img1.kuwo.cn/star/albumcover/${picShort}`, this.referer) : null,
        duration,
        qualityLabel: formats.includes('MP3H') ? '320k' : undefined,
        vip: this.field(block, 'PAY') === '1',
        qualityMax: formats.includes('FLAC') || formats.includes('APE')
          ? 'lossless'
          : formats.includes('MP3H')
            ? 'high'
            : 'standard',
        streamable: this.field(block, 'PAY') !== '1'
      })
    }
    return songs
  }

  private field(block: string, key: string): string {
    const match = block.match(new RegExp(`'${key}':'((?:[^'\\\\]|\\\\.)*)'`))
    return match ? decodeHtml(match[1]) : ''
  }

  async resolveStream(song: Song, quality: Quality): Promise<StreamInfo> {
    const ladders =
      quality === 'lossless'
        ? [
            { br: '2000kflac', format: 'flac', label: '无损 FLAC', quality: 'lossless' as Quality },
            { br: '320kmp3', format: 'mp3', label: '320k MP3', quality: 'high' as Quality }
          ]
        : quality === 'high'
          ? [
              { br: '320kmp3', format: 'mp3', label: '320k MP3', quality: 'high' as Quality },
              { br: '128kmp3', format: 'mp3', label: '128k MP3', quality: 'standard' as Quality }
            ]
          : [{ br: '128kmp3', format: 'mp3', label: '128k MP3', quality: 'standard' as Quality }]

    for (const step of ladders) {
      const url =
        'https://antiserver.kuwo.cn/anti.s?' +
        new URLSearchParams({
          type: 'convert_url',
          br: step.br,
          format: step.format,
          response: 'url',
          rid: `MUSIC_${song.id}`
        }).toString()
      try {
        const raw = (await this.text(url, { headers: { Referer: this.referer } })).trim()
        if (!raw.startsWith('http')) continue
        const probe = await this.probe(raw, this.referer)
        if (!probe.ok) continue
        return {
          url: mediaUrl(raw, this.referer),
          directUrl: probe.finalUrl || raw,
          headers: { Referer: this.referer },
          quality: step.quality,
          label: step.label,
          format: step.format,
          expiresAt: Date.now() + 30 * 60_000
        }
      } catch {
        /* 尝试下一档 */
      }
    }
    throw new ProviderError('blocked', '酷我未返回可用播放地址', this.info.id)
  }

  async charts(): Promise<ChartSummary[]> {
    return KuwoProvider.BANGS.map((bang) => ({
      id: bang.bid,
      platform: this.info.id,
      name: bang.name,
      coverUrl: null,
      updateFrequency: '今日更新'
    }))
  }

  /**
   * 榜单详情：m.kuwo.cn 的 H5 详情页服务端直出全量歌曲（约 100-200 首），
   * 一次抓取解析完毕，无翻页接口。
   */
  async chartDetail({ id, page, limit }: { id: string; page: number; limit: number }): Promise<SearchPage> {
    const cached = this.bangCache.get(id)
    let songs: Song[]
    if (cached && Date.now() - cached.at < 5 * 60_000) {
      songs = cached.songs
    } else {
      const html = await this.text(
        `https://m.kuwo.cn/newh5/bang/content?bid=${encodeURIComponent(id)}`,
        { headers: { 'User-Agent': KUWO_MOBILE_UA, Referer: 'https://m.kuwo.cn/' } }
      )
      songs = this.parseBangHtml(html)
      this.bangCache.set(id, { songs, at: Date.now() })
    }
    const start = (page - 1) * limit
    return {
      items: songs.slice(start, start + limit),
      total: songs.length,
      page,
      hasMore: start + limit < songs.length
    }
  }

  /** 解析 H5 详情页：mid 是音乐 id，可直接走 antiserver 换播放地址 */
  private parseBangHtml(html: string): Song[] {
    const songs: Song[] = []
    const blocks = html.split('<li class="singBox"').slice(1)
    for (const block of blocks) {
      const id = (block.match(/mid="(\d+)"/) ?? [])[1]
      const name = (block.match(/<div class="singTexUp2">\s*<p>([^<]+)<\/p>/) ?? [])[1]
      if (!id || !name) continue
      const singLine = (block.match(/<p class="singName">([^<]*)<\/p>/) ?? [])[1] ?? ''
      const decodedName = decodeHtml(name)
      // singName 形如「歌手-歌名」：去掉与歌名重复的尾部得到歌手
      const suffix = `-${decodedName}`
      const artist = decodeHtml(
        singLine.endsWith(suffix) ? singLine.slice(0, singLine.length - suffix.length) : singLine.split('-')[0] ?? ''
      )
      songs.push({
        id,
        platform: this.info.id,
        name: decodedName,
        artists: artist ? artist.split(/[&,、/]/).map((s) => s.trim()).filter(Boolean) : [],
        album: '',
        coverUrl: null,
        duration: 0,
        streamable: true
      })
    }
    return songs
  }

  async lyric(_song: Song): Promise<Lyric | null> {
    return null
  }
}
