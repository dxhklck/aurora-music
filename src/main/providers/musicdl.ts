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
import { MUSICDL_SOURCES, type SourceSpec } from './musicdl-sources'

export { MUSICDL_SOURCES }
export type { SourceSpec }

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
