import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { attrOf, parseHtml, selectAll, selectOne, textOf } from '../html'
import { parseJsonLoose } from '../http'
import { parseDurationText, safeGet } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * Free Music Archive。
 *
 * 搜索结果把每首歌的元数据塞在 `data-track-info` 属性里（一段 JSON），
 * 时长则是页面上唯一一个形如 `3:45` 的 span——没有专门字段，只能按格式匹配。
 * 详情页还可能有更完整的 JSON，这里两处都读，前者兜底后者。
 */

const SEARCH_URL = 'https://freemusicarchive.org/search/?'
const DURATION_PATTERN = /^\d{1,2}:\d{2}(?::\d{2})?$/

const SEARCH_HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
}

const PARSE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  referer: 'https://freemusicarchive.org/'
}

interface FmaTrack extends Record<string, unknown> {
  url?: string
  id?: string
  title?: string
  artistName?: string
  albumTitle?: string
  duration?: string
  fileUrl?: string
  playbackUrl?: string
  downloadUrl?: string
}

export class FmaSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'fma',
      label: 'Free Music Archive',
      pageSize: 3,
      headers: SEARCH_HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        quicksearch: keyword,
        pageSize: String(perPage),
        page: String(Math.floor(count / perPage) + 1)
      })
      urls.push(SEARCH_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const document = parseHtml(response.text)
    const items = selectAll(document, '.play-item[data-track-info]')

    for (const item of items) {
      if (ctx.full) break
      let track: FmaTrack | null = null
      try {
        track = parseJsonLoose<FmaTrack>(attrOf(item, 'data-track-info'))
      } catch {
        track = null
      }
      if (!track || typeof track !== 'object' || !track.id) continue

      // 列表页的补充字段：专辑名在 .ptxt-album，时长是唯一匹配 mm:ss 的 span
      const albumNode = selectOne(item, '.ptxt-album a')
      track.albumTitle = albumNode ? textOf(albumNode) : undefined
      const durationSpan = selectAll(item, 'span').find((span) => DURATION_PATTERN.test(textOf(span)))
      track.duration = durationSpan ? textOf(durationSpan) : undefined

      try {
        const song = await this.parseOne(track)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 跳过单曲 */
      }
    }
  }

  private async parseOne(track: FmaTrack): Promise<SongInfo | null> {
    const pageUrl = String(track.url ?? '')
    if (!pageUrl || !/^https?:/i.test(pageUrl)) return null

    const response = await this.http.get(pageUrl, { headers: PARSE_HEADERS })
    if (!response.ok) return null
    const document = parseHtml(response.text)
    const image =
      selectOne(document, ".w-full.h-80 img[src*='/image/'][src*='type=track']") ??
      selectOne(document, "img[src*='/image/'][src*='type=track']")
    const imageSrc = attrOf(image, 'src')

    let download: Record<string, unknown> = {}
    const rawJson = attrOf(selectOne(document, '[data-track-info]'), 'data-track-info')
    if (rawJson) {
      try {
        download = parseJsonLoose<Record<string, unknown>>(rawJson)
      } catch {
        download = {}
      }
    }
    if (imageSrc) {
      try {
        download.cover_url = new URL(imageSrc, pageUrl).toString()
      } catch {
        download.cover_url = imageSrc
      }
    }

    const candidates = [
      download.fileUrl,
      track.fileUrl,
      download.playbackUrl,
      track.playbackUrl,
      download.downloadUrl,
      track.downloadUrl
    ].map((value) => String(value ?? ''))
    const probed = await probeFirst(candidates, { headers: SEARCH_HEADERS })
    if (!probed) return null

    const durationText = String(track.duration ?? safeGet(track, ['duration'], '') ?? '')
    return makeSong(this.key, {
      identifier: String(track.id),
      songName: track.title ?? download.title,
      singers: track.artistName ?? download.artistName,
      album: track.albumTitle ?? download.albumTitle,
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS: parseDurationText(durationText),
      coverUrl: String(download.cover_url ?? ''),
      downloadUrl: probed.url,
      headers: SEARCH_HEADERS,
      protocol: probed.protocol,
      raw: { search: track, download }
    })
  }
}
