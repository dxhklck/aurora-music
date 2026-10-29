import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { cleanLrc, durationFromLrc, safeGet, secondsToHms, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 5sing 原创。
 *
 * 这个源有个反直觉的地方：**取地址接口一次返回全部码率**（sq/hq/lq 三个字段），
 * 所以不该像咪咕那样每档发一次请求，而是一次拿到后按 sq→hq→lq 依次探测。
 * 照抄「每档一次请求」的写法会白白多打两次接口。
 */

const SEARCH_URL = 'http://search.5sing.kugou.com/home/json?'
const SONG_URL = 'http://mobileapi.5sing.kugou.com/song/getSongUrl'
const SONG_DETAIL_URL = 'http://mobileapi.5sing.kugou.com/song/newget'
const QUALITIES = ['sq', 'hq', 'lq']

const HEADERS: Record<string, string> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  Referer: 'https://5sing.kugou.com/'
}

export class FiveSingSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'fivesing',
      label: '5sing 原创',
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
        keyword,
        sort: '1',
        page: String(Math.floor(count / perPage) + 1),
        filter: '0',
        type: '0'
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
    const results = safeGet(payload, ['list'], []) as Array<Record<string, unknown>>
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
    const songId = String(result.songId ?? '')
    const songType = String(result.typeEname ?? '')
    if (!songId || !songType) return null

    const response = await this.http.get(
      `${SONG_URL}?${new URLSearchParams({ songid: songId, songtype: songType }).toString()}`
    )
    if (!response.ok) return null
    const download = parseJsonLoose<Record<string, unknown>>(response.text)

    for (const quality of QUALITIES) {
      const candidate = String(
        safeGet(download, ['data', `${quality}url`], '') || safeGet(download, ['data', `${quality}url_backup`], '') || ''
      )
      if (!candidate) continue
      const probed = await probeFirst([candidate], { headers: this.playHeaders() })
      if (!probed) continue

      const detail = await this.fetchDetail(songId, songType)
      const lyric = cleanLrc(String(detail.dynamicWords ?? '')) || ''
      let durationS = toInt(toFloat(detail.duration ?? 0))
      if (!durationS) durationS = durationFromLrc(lyric)

      return makeSong(this.key, {
        identifier: songId,
        songName: result.songName,
        singers: result.singer,
        album: detail.albumName,
        ext: probed.ext,
        fileSizeBytes: probed.size,
        durationS,
        coverUrl: safeGet(detail, ['user', 'I'], null) ?? safeGet(download, ['data', 'user', 'I'], null),
        downloadUrl: probed.url,
        headers: this.playHeaders(),
        protocol: probed.protocol,
        lyric,
        raw: { search: result, download }
      })
    }
    return null
  }

  private playHeaders(): Record<string, string> {
    return { 'user-agent': HEADERS['user-agent'] }
  }

  /** 详情接口补专辑名、封面与歌词；失败不致命 */
  private async fetchDetail(songId: string, songType: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.http.get(
        `${SONG_DETAIL_URL}?${new URLSearchParams({
          songid: songId,
          songtype: songType,
          songfields: '',
          userfields: ''
        }).toString()}`
      )
      if (!response.ok) return {}
      const payload = parseJsonLoose<Record<string, unknown>>(response.text)
      return (safeGet(payload, ['data'], {}) ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}

/** 供单测：确认歌词里取出的时长统一走向 secondsToHms */
export function fivesingDurationFallback(lyric: string): string {
  return secondsToHms(durationFromLrc(lyric))
}
