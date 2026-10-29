import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * Audius（去中心化音乐平台）。
 *
 * 播放地址是一个会 302 到 CDN 的固定端点，探测必须跟随重定向取最终地址，
 * 否则拿到的 `api.audius.co/...` 会让播放器再跳一次（部分内核会丢 Referer）。
 */

const SEARCH_URL = 'https://api.audius.co/v1/tracks/search?'
const APP_NAME = 'musicdl'

const HEADERS: Record<string, string> = {
  accept: 'application/json',
  referer: 'https://audius.co/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  authorization: ''
}

export class AudiusSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'audius',
      label: 'Audius',
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
        query: keyword,
        limit: String(perPage),
        offset: String(count),
        app_name: APP_NAME
      })
      urls.push(SEARCH_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    const results = safeGet(payload, ['data'], []) as Array<Record<string, unknown>>
    if (!Array.isArray(results)) return

    for (const result of results) {
      if (ctx.full) break
      try {
        const song = await this.parseOne(result)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 跳过单曲 */
      }
    }
  }

  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const id = String(result.id ?? '')
    if (!id) return null

    const candidate = `https://api.audius.co/v1/tracks/${id}/stream?app_name=${APP_NAME}`
    const probed = await probeFirst([candidate], { headers: { referer: HEADERS.referer } })
    if (!probed) return null

    const artwork = (result.artwork as Record<string, string>) ?? {}
    const durationS = toInt(toFloat(result.duration))

    return makeSong(this.key, {
      identifier: id,
      songName: result.title,
      singers: safeGet(result, ['user', 'name'], null) ?? safeGet(result, ['user', 'handle'], null),
      album: result.album_name ?? result.playlist_name,
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS,
      coverUrl: artwork['1000x1000'] ?? artwork['480x480'] ?? artwork['150x150'],
      downloadUrl: probed.url,
      headers: { referer: HEADERS.referer },
      protocol: probed.protocol,
      raw: { search: result }
    })
  }
}
