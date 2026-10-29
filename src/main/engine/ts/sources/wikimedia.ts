import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { isValidAudioExt, extFromUrl } from '../probe'
import { safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 维基共享资源（Wikimedia Commons）。
 *
 * 这个源没有「码率档位」的概念：每个音频文件只有一条原始地址，
 * 直接探测即可。需要注意的是它的 `pages` 在不同 `formatversion` 下
 * 可能是对象也可能是数组，两种都要能吃。
 */

const API_URL = 'https://commons.wikimedia.org/w/api.php?'
const DEFAULT_ALBUM = 'Wikimedia Commons'

const HEADERS: Record<string, string> = {
  accept: 'application/json',
  referer: 'https://commons.wikimedia.org/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
}

/** 把 extmetadata 的 {value: ...} 结构摊平成普通字典 */
function flattenMetadata(raw: unknown): Record<string, string> {
  const source = (raw ?? {}) as Record<string, unknown>
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
      output[key] = String((value as Record<string, unknown>).value ?? '')
    } else if (value !== null && value !== undefined) {
      output[key] = String(value)
    }
  }
  return output
}

export class WikimediaSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'wikimedia',
      label: '维基共享',
      pageSize: 3,
      headers: HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        action: 'query',
        generator: 'search',
        gsrsearch: `${keyword} filetype:audio`,
        gsrnamespace: '6',
        gsrlimit: String(perPage),
        gsroffset: String(count),
        prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata',
        iiurlwidth: '500',
        format: 'json',
        formatversion: '2',
        origin: '*'
      })
      urls.push(API_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    const pages = safeGet(payload, ['query', 'pages'], []) as unknown
    const results = Array.isArray(pages) ? pages : Object.values((pages as Record<string, unknown>) ?? {})

    for (const result of results as Array<Record<string, unknown>>) {
      if (ctx.full) break
      try {
        const song = await this.parseOne(result)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 跳过单条 */
      }
    }
  }

  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const imageInfo = (safeGet(result, ['imageinfo', 0], {}) ?? {}) as Record<string, unknown>
    const candidate = String(imageInfo.url ?? '')
    if (!candidate || !/^https?:/i.test(candidate)) return null
    // 只要音频：MIME 不是 audio/ 且后缀也不在音频白名单里就跳过（Commons 里混着图片）
    const mime = String(imageInfo.mime ?? '')
    if (!mime.startsWith('audio/') && !isValidAudioExt(extFromUrl(candidate))) return null

    const probed = await probeFirst([candidate], { headers: { referer: HEADERS.referer } })
    if (!probed) return null

    const metadata = flattenMetadata(imageInfo.extmetadata)
    const rawTitle = String(metadata.ObjectName || metadata.ImageDescription || result.title || '').replace(/^File:/, '')
    const title = rawTitle.replace(/\.[^.]+$/, '')
    const singer = metadata.Artist || metadata.Credit || metadata.Author || metadata.Attribution || ''
    const album = metadata.Collection || metadata.Categories || DEFAULT_ALBUM
    const identifier = String(result.pageid ?? '') || Math.random().toString(36).slice(2, 12)

    return makeSong(this.key, {
      identifier,
      songName: title,
      singers: singer,
      album,
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS: toInt(toFloat(imageInfo.duration)),
      coverUrl: imageInfo.thumburl,
      downloadUrl: probed.url,
      headers: { referer: HEADERS.referer },
      protocol: probed.protocol,
      raw: { search: result }
    })
  }
}
