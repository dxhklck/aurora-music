import type {
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { parseLrc } from '@shared/lyric'
import { BaseProvider } from './base'
import { ProviderError } from './types'
import { mediaUrl } from '../media'
import { musicdl, type EngineSong, type ResolveQuery } from '../engine/musicdl'
import { EngineCallError } from '../engine/python'

interface SourceSpec {
  key: string
  name: string
  short: string
  color: string
  gradient: [string, string]
  description: string
  note?: string
  /** 播放地址必须带的 Referer；为空时只用引擎回传的请求头 */
  referer?: string
}

/**
 * musicdl 引擎承载的音源。
 *
 * 这些平台原本各有一套签名算法（酷狗要算 md5 签名、咪咕要拼 AES 参数……），
 * 在 TS 里重写一遍既容易过期也没必要——直接复用 musicdl 的实现，
 * 播放器这边只负责把它们适配成统一的 MusicProvider。
 *
 * netease / qq / kuwo 不在这里：Aurora 有自己的原生适配器（支持榜单和逐字歌词），
 * 同一平台出现两套行为只会让用户困惑。
 */
export const MUSICDL_SOURCES: SourceSpec[] = [
  {
    key: 'kugou',
    name: '酷狗音乐',
    short: '酷狗',
    color: '#2aa3ff',
    gradient: ['#4fc3ff', '#0b4a7a'],
    description: '概念版曲库，320k 直链',
    note: '部分歌曲需要客户端签名，失败时自动换源'
  },
  {
    key: 'migu',
    name: '咪咕音乐',
    short: '咪咕',
    color: '#ff6a00',
    gradient: ['#ff9a3d', '#7a2f00'],
    description: '正版曲库，无损资源较多'
  },
  {
    key: 'qianqian',
    name: '千千音乐',
    short: '千千',
    color: '#3f7cff',
    gradient: ['#6f9bff', '#16265c'],
    description: '原百度音乐曲库'
  },
  {
    key: 'fivesing',
    name: '5sing 原创',
    short: '5sing',
    color: '#ff5c8a',
    gradient: ['#ff87ab', '#6d1f38'],
    description: '原创与翻唱作品聚集地'
  },
  {
    key: 'bodian',
    name: '波点音乐',
    short: '波点',
    color: '#7c5cff',
    gradient: ['#a58cff', '#2c1f66'],
    description: '短视频热门 BGM 曲库'
  },
  {
    key: 'streetvoice',
    name: '街声',
    short: '街声',
    color: '#22c55e',
    gradient: ['#5ce08d', '#0d3b22'],
    description: '独立音乐人作品'
  },
  {
    key: 'bilibili',
    name: '哔哩哔哩',
    short: 'B站',
    color: '#fb7299',
    gradient: ['#ff9db5', '#5c1d2c'],
    description: '视频音轨与音乐区投稿'
  },
  {
    key: 'jiosaavn',
    name: 'JioSaavn',
    short: 'Jio',
    color: '#2bc48a',
    gradient: ['#5ce0b0', '#0c3f2c'],
    description: '印度与南亚曲库'
  },
  {
    key: 'jamendo',
    name: 'Jamendo',
    short: 'Jam',
    color: '#f59e0b',
    gradient: ['#ffc45c', '#5c3a05'],
    description: 'CC 授权独立音乐'
  },
  {
    key: 'ccmixter',
    name: 'ccMixter',
    short: 'ccM',
    color: '#f472b6',
    gradient: ['#ffa3d1', '#5c1f3d'],
    description: '可商用的混音素材'
  },
  {
    key: 'opengameart',
    name: 'OpenGameArt',
    short: 'OGA',
    color: '#84cc16',
    gradient: ['#b6e85c', '#2f4705'],
    description: '游戏音乐与音效'
  },
  {
    key: 'wikimedia',
    name: '维基共享',
    short: 'Wiki',
    color: '#64748b',
    gradient: ['#9aa8bb', '#1f2937'],
    description: '公共领域音频'
  },
  {
    key: 'audius',
    name: 'Audius',
    short: 'Aud',
    color: '#cc0fe0',
    gradient: ['#e86bff', '#4a0a52'],
    description: '去中心化音乐平台'
  },
  {
    key: 'fma',
    name: 'Free Music Archive',
    short: 'FMA',
    color: '#0ea5e9',
    gradient: ['#5cc9f5', '#0a3a52'],
    description: '免费授权音乐库'
  },
  {
    key: 'soundcloud',
    name: 'SoundCloud',
    short: 'SC',
    color: '#ff5500',
    gradient: ['#ff8a4d', '#5c2100'],
    description: '全球独立音乐社区',
    note: '部分曲目需要登录 Cookie'
  }
]

const LOSSLESS_EXT = new Set(['flac', 'wav', 'ape', 'alac', 'dsf', 'dff', 'wv', 'tta'])

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
 * 平台差异（签名、字段、鉴权）全在 Python 侧，这里只做模型转换与错误归一化。
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
      capabilities: { search: true, charts: false, stream: true, lyric: true },
      description: spec.description,
      note: spec.note ?? '由 musicdl 引擎提供，首次使用需加载引擎'
    }
  }

  get sourceKey(): string {
    return this.spec.key
  }

  protected baseHeaders(): Record<string, string> {
    return this.spec.referer ? { Referer: this.spec.referer } : {}
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
    if (error instanceof EngineCallError) {
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
        `musicdl 引擎未就绪：${message}。请在设置页点「重新检测」，或运行 npm run engine:setup`,
        this.info.id
      )
    }
    return new ProviderError('network', `${this.info.name}：${message}`, this.info.id)
  }
}
