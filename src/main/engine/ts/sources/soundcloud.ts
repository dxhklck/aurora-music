import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * SoundCloud。
 *
 * 上游能把无损流解出来，靠的是 pywidevine 做 Widevine 授权（CTR 流），
 * 这需要一个独立的 Widevine CDM 进程，当前实现没有等价物。因此只支持
 * **progressive（HTTP 直链）与原始文件下载**，DRM 流一律跳过。
 *
 * 实测这个源在本项目里长期返回 0 条（client_id 探测失败 + 授权缺失），
 * 所以这里的降级不会让用户可感知的结果变少；等哪天要恢复无损，
 * 需要单独引入 Widevine 模块，而不是在音源层打补丁。
 */

const SEARCH_URL = 'https://api-v2.soundcloud.com/search/tracks?'
const TRACK_URL = 'https://api-v2.soundcloud.com/tracks'
const APP_VERSION = '1769771069'
const FALLBACK_CLIENT_ID = '9jZvetLfDs6An08euQgJ0lYlHkKdGFzV'

const HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'
}

interface Transcoding {
  url?: string
  preset?: string
  quality?: string
  snipped?: boolean
  format?: { protocol?: string; mime_type?: string }
}

export class SoundCloudSource extends BaseSource {
  private clientId = ''
  private clientIdAt = 0

  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'soundcloud',
      label: 'SoundCloud',
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
        q: keyword,
        sc_a_id: 'ab15798461680579b387acf67441b40149e528cd',
        facet: 'genre',
        client_id: this.clientId || FALLBACK_CLIENT_ID,
        limit: String(perPage),
        offset: String(count),
        linked_partitioning: '1',
        app_version: APP_VERSION,
        app_locale: 'en'
      })
      urls.push(SEARCH_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    await this.ensureClientId()
    const response = await this.http.get(url.replace(/client_id=[^&]+/, `client_id=${this.clientId || FALLBACK_CLIENT_ID}`))
    if (!response.ok) return
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    const results = safeGet(payload, ['collection'], []) as Array<Record<string, unknown>>
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

  /** client_id 会随站点脚本轮换，缓存 30 分钟够用 */
  private async ensureClientId(): Promise<void> {
    if (this.clientId && Date.now() - this.clientIdAt < 30 * 60_000) return
    try {
      const home = await this.http.get('https://soundcloud.com/', { retries: 1 })
      if (home.ok) {
        const scripts = [...home.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]).reverse()
        for (const src of scripts.slice(0, 6)) {
          const script = await this.http.get(src, { retries: 1 })
          if (!script.ok) continue
          const matched = /client_id\s*:\s*"([0-9a-zA-Z]{32})"/.exec(script.text)
          if (matched) {
            this.clientId = matched[1]
            this.clientIdAt = Date.now()
            return
          }
        }
      }
    } catch {
      /* 落到兜底 id */
    }
    this.clientId = FALLBACK_CLIENT_ID
    this.clientIdAt = Date.now()
  }

  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const id = result.id
    if (!id) return null
    let track = result
    const transcodings = (safeGet(track, ['media', 'transcodings'], []) ?? []) as Transcoding[]
    if (!Array.isArray(transcodings) || !transcodings.length) {
      const response = await this.http.get(`${TRACK_URL}/${id}?client_id=${this.clientId}`, { headers: HEADERS })
      if (!response.ok) return null
      track = parseJsonLoose<Record<string, unknown>>(response.text)
    }

    const candidates: string[] = []
    const streamProtocols: string[] = []
    const list = ((safeGet(track, ['media', 'transcodings'], []) ?? []) as Transcoding[])
      .filter((item) => item && typeof item === 'object' && item.url)
      .sort((a, b) => this.streamScore(b) - this.streamScore(a))

    for (const transcoding of list) {
      const protocol = String(safeGet(transcoding, ['format', 'protocol'], '') ?? '').toLowerCase()
      // CBC（FairPlay）与 CTR（Widevine）都要授权，TS 侧无解
      if (protocol.startsWith('cbc-') || protocol.startsWith('ctr-')) continue
      if (protocol !== 'progressive') continue
      const params = new URLSearchParams({ client_id: this.clientId })
      const trackAuth = track.track_auth
      if (typeof trackAuth === 'string' && trackAuth) params.set('track_authorization', trackAuth)
      const response = await this.http.get(`${transcoding.url}?${params.toString()}`, { headers: HEADERS })
      if (!response.ok) continue
      const resolved = parseJsonLoose<Record<string, unknown>>(response.text)
      const direct = String(resolved.url ?? '')
      if (!/^https?:/i.test(direct)) continue
      candidates.push(direct)
      streamProtocols.push(protocol)
    }

    const probed = await probeFirst(candidates, { headers: HEADERS })
    if (!probed) return null

    const durationS = toInt(toFloat(safeGet(track, ['duration'], 0)) / 1000)
    return makeSong(this.key, {
      identifier: String(id),
      songName: track.title,
      singers: safeGet(track, ['publisher_metadata', 'artist'], null) ?? safeGet(track, ['user', 'username'], null),
      album: safeGet(track, ['publisher_metadata', 'album_title'], null),
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS,
      coverUrl: track.artwork_url,
      downloadUrl: probed.url,
      headers: HEADERS,
      protocol: probed.protocol,
      raw: { search: track }
    })
  }

  /** 排序权重：原始文件 > hq > sq；同档里 opus 优于 m4a */
  private streamScore(stream: Transcoding): number {
    const quality = String(stream.quality ?? 'sq').toLowerCase()
    const ext = String(safeGet(stream, ['format', 'mime_type'], '') ?? '').toLowerCase()
    return (quality === 'hq' ? 2 : quality === 'sq' ? 1 : 0) * 10 + (ext.includes('opus') ? 3 : ext.includes('mp4') ? 2 : 1)
  }
}
