import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { cleanLrc, safeGet, sha1Hex, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * Jamendo（CC 授权独立音乐）。
 *
 * 接口要求一个 `x-jam-call` 头：`$<sha1(path + random)>*<random>~`。
 * 这是个防抓取用的弱校验——路径必须与实际请求路径一致，所以每个端点
 * 都要各自算一次，不能复用搜索时那个值。
 */

const API_BASE = 'https://www.jamendo.com'
const FLAC_FALLBACK = 'https://prod-1.storage.jamendo.com/download/track'

const HEADERS: Record<string, string> = {
  referer: 'https://www.jamendo.com/search?q=musicdl',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'x-jam-version': '4rkl5f',
  'x-requested-with': 'XMLHttpRequest'
}

/** 按路径生成 x-jam-call */
function jamCall(path: string): string {
  const random = String(Math.random())
  return `$${sha1Hex(path + random)}*${random}~`
}

export class JamendoSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'jamendo',
      label: 'Jamendo',
      pageSize: 3,
      headers: { ...HEADERS, 'x-jam-call': jamCall('/api/search') },
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        query: keyword,
        type: 'track',
        limit: String(perPage),
        identities: 'www',
        offset: String(count)
      })
      urls.push(`${API_BASE}/api/search?${params.toString()}`)
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    // 每页重新签名：服务端会校验 path 与随机串的对应关系
    const response = await this.http.get(url, { headers: { 'x-jam-call': jamCall('/api/search') } })
    if (!response.ok) return
    const payload = parseJsonLoose<unknown>(response.text)
    const results = Array.isArray(payload) ? (payload as Array<Record<string, unknown>>) : []
    if (!results.length) return

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

    const trackResponse = await this.http.get(`${API_BASE}/api/tracks?${new URLSearchParams({ 'id[]': id }).toString()}`, {
      headers: { 'x-jam-call': jamCall('/api/tracks') }
    })
    let download: Record<string, unknown> = {}
    if (trackResponse.ok) {
      const parsed = parseJsonLoose<unknown>(trackResponse.text)
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object') {
        download = parsed[0] as Record<string, unknown>
      }
    }

    const artistId = safeGet(result, ['artist', 'id'], null) ?? result.artistId ?? download.artistId
    if (!safeGet(result, ['artist', 'name'], null) && artistId) {
      const response = await this.http.get(`${API_BASE}/api/artists?${new URLSearchParams({ 'id[]': String(artistId) }).toString()}`, {
        headers: { 'x-jam-call': jamCall('/api/artists') }
      })
      if (response.ok) {
        const parsed = parseJsonLoose<unknown>(response.text)
        if (Array.isArray(parsed) && parsed[0]) download.artist = parsed[0]
      }
    }

    const albumId = safeGet(result, ['album', 'id'], null) ?? result.albumId ?? download.albumId
    if (!safeGet(result, ['album', 'name'], null) && albumId) {
      const response = await this.http.get(`${API_BASE}/api/albums?${new URLSearchParams({ 'id[]': String(albumId) }).toString()}`, {
        headers: { 'x-jam-call': jamCall('/api/albums') }
      })
      if (response.ok) {
        const parsed = parseJsonLoose<unknown>(response.text)
        if (Array.isArray(parsed) && parsed[0]) download.album = parsed[0]
      }
    }

    const candidates: string[] = []
    for (const path of [
      ['stream', 'flac'],
      ['download', 'flac'],
      ['stream', 'mp33'],
      ['stream', 'mp32'],
      ['download', 'mp3'],
      ['stream', 'mp3'],
      ['stream', 'ogg'],
      ['download', 'ogg']
    ]) {
      const value = safeGet(download, path, null)
      if (value && /^https?:/i.test(String(value))) candidates.push(String(value))
    }
    // 把首选的候选地址的 format 参数改成 flac，再顶到最前面重试一次
    if (candidates.length) {
      try {
        const parsed = new URL(candidates[0])
        if (parsed.searchParams.has('format')) parsed.searchParams.set('format', 'flac')
        candidates.unshift(parsed.toString())
      } catch {
        /* 忽略非法 URL */
      }
    }
    if (!candidates.length) {
      for (const path of [
        ['download', 'mp3'],
        ['stream', 'mp3'],
        ['download', 'ogg'],
        ['stream', 'ogg']
      ]) {
        const value = safeGet(result, path, null)
        if (value && /^https?:/i.test(String(value))) candidates.push(String(value))
      }
    }

    const probed = await probeFirst([`${FLAC_FALLBACK}/${id}/flac/`, ...candidates], {
      headers: { referer: HEADERS.referer }
    })
    if (!probed) return null

    const rawLyric = String(download.lyrics ?? '')
    const lyric = rawLyric ? cleanLrc(rawLyric.replace(/<br\s*\/?>/gi, '\n')) : ''
    const durationS = toInt(toFloat(result.duration ?? download.duration ?? 0))
    const albumForCover = albumId ? String(albumId) : ''

    return makeSong(this.key, {
      identifier: id,
      songName: result.name ?? download.name,
      singers: safeGet(result, ['artist', 'name'], null) ?? safeGet(download, ['artist', 'name'], null),
      album: safeGet(result, ['album', 'name'], null) ?? safeGet(download, ['album', 'name'], null),
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS,
      coverUrl: `https://usercontent.jamendo.com?type=album&id=${albumForCover}&width=300&trackid=${id}`,
      downloadUrl: probed.url,
      headers: { referer: HEADERS.referer },
      protocol: probed.protocol,
      lyric,
      raw: { search: result, download }
    })
  }
}
