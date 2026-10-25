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
    capabilities: { search: true, charts: false, stream: true, lyric: false },
    description: '免登录可直接播放，下载成功率高',
    note: '歌词走公共歌词库匹配'
  }

  private readonly referer = 'https://www.kuwo.cn/'

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
    return []
  }

  async lyric(_song: Song): Promise<Lyric | null> {
    return null
  }
}
