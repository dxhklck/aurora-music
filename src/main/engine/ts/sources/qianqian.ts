import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { cleanLrc, md5Hex, safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 千千音乐（原百度音乐）。
 *
 * 接口要求签名：把所有参数按键名排序拼成 `k=v&k=v`，追加密钥后取 md5。
 * `timestamp` 必须参与签名且是秒级整数——用毫秒会直接被判为过期。
 */

const APPID = '16073360'
const SECRET = '0b50b02fd0d73a9c4c8c3a781c30845f'
const SEARCH_URL = 'https://music.91q.com/v1/search?'
const TRACKLINK_URL = 'https://music.91q.com/v1/song/tracklink'
/** 码率档位：3000 是「臻品」无损，往下依次降级 */
const RATES = ['3000', '320', '128', '64']

const HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  referer: 'https://music.91q.com/player',
  'sec-ch-ua-platform': '"Windows"',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  from: 'web',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-dest': 'empty'
}

/** 追加 timestamp 与 sign，原地返回新对象 */
function sign(params: Record<string, string>): Record<string, string> {
  const signed: Record<string, string> = { ...params, timestamp: String(Math.floor(Date.now() / 1000)) }
  const joined = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join('&')
  signed.sign = md5Hex(joined + SECRET)
  return signed
}

export class QianqianSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'qianqian',
      label: '千千音乐',
      pageSize: 3,
      headers: HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = sign({
        word: keyword,
        type: '1',
        pageNo: String(Math.floor(count / perPage) + 1),
        pageSize: String(perPage),
        appid: APPID
      })
      urls.push(SEARCH_URL + new URLSearchParams(params).toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    const results = safeGet(payload, ['data', 'typeTrack'], []) as Array<Record<string, unknown>>
    if (!Array.isArray(results)) return

    for (const result of results) {
      if (ctx.full) break
      try {
        const song = await this.parseOne(result)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 单曲失败跳过 */
      }
    }
  }

  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const tsid = String(result.TSID ?? '')
    if (!tsid) return null

    for (const rate of RATES) {
      const params = sign({ TSID: tsid, appid: APPID, rate })
      const response = await this.http.get(`${TRACKLINK_URL}?${new URLSearchParams(params).toString()}`)
      if (!response.ok) continue
      const download = parseJsonLoose<Record<string, unknown>>(response.text)
      const candidate = String(
        safeGet(download, ['data', 'path'], '') || safeGet(download, ['data', 'trail_audio_info', 'path'], '') || ''
      )
      if (!candidate) continue

      const probed = await probeFirst([candidate], { headers: this.playHeaders() })
      if (!probed) continue

      const durationS = toInt(toFloat(safeGet(download, ['data', 'duration'], 0)))
      const artists = (result.artist as Array<{ name?: string }>) ?? []
      let singers = artists
        .filter((item) => item && typeof item === 'object' && item.name)
        .map((item) => item.name)
        .join(', ')
      const lyric = await this.fetchLyric(result)
      // 少数曲目歌手字段为空，但歌词头部的 [ar:] 有值——用它补
      if ((!singers || singers === 'NULL') && lyric) {
        const matched = /\[ar:(.*?)\]/.exec(lyric)
        if (matched) singers = matched[1]
      }

      return makeSong(this.key, {
        identifier: tsid,
        songName: result.title,
        singers,
        album: result.albumTitle,
        ext: probed.ext,
        fileSizeBytes: probed.size,
        durationS,
        coverUrl: result.pic,
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

  private async fetchLyric(result: Record<string, unknown>): Promise<string> {
    const lyricUrl = String(result.lyric ?? '')
    if (!lyricUrl || !/^https?:/i.test(lyricUrl)) return ''
    const response = await this.http.get(lyricUrl)
    if (!response.ok) return ''
    return cleanLrc(response.text)
  }
}
