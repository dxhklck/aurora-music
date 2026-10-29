import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 哔哩哔哩（视频音轨与音乐区投稿）。
 *
 * 一个搜索条目可能对应多 P 视频，所以要展开成多条结果——这也是全引擎里
 * 唯一「一个搜索结果产出 N 首歌」的源，`parsePage` 因此不能假设 1:1。
 *
 * Cookie 说明：上游硬编码了一整套 2023 年的浏览器 Cookie（含当时他人的
 * SESSDATA）。这里只保留反爬必需、且与账号无关的三个（buvid3 / b_nut / _uuid），
 * 登录态一律不带——带上过期凭据反而会被判定为异常会话。
 */

const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/search/type?'
const VIEW_URL = 'https://api.bilibili.com/x/web-interface/view'
const PLAYURL_URL = 'https://api.bilibili.com/x/player/playurl'

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  Referer: 'https://www.bilibili.com/',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Accept-Encoding': 'gzip, deflate',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
}

const COOKIES: Record<string, string> = {
  buvid3: '2E109C72-251F-3827-FA8E-921FA0D7EC5291319infoc',
  b_nut: '1676213591',
  _uuid: '2B2D7A6C-8310-C1167-F548-2F1095A6E93F290252infoc',
  CURRENT_FNVAL: '4048',
  b_ut: '5',
  header_theme_version: 'CLOSE'
}

interface DashAudio {
  baseUrl?: string
  base_url?: string
  backupUrl?: string
  backup_url?: string
  bandwidth?: number
  filesize?: number
}

function pickAudioUrl(audio: DashAudio): string {
  return audio.baseUrl || audio.base_url || audio.backupUrl || audio.backup_url || ''
}

export class BilibiliSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'bilibili',
      label: '哔哩哔哩',
      pageSize: 3,
      headers: HEADERS,
      cookies: COOKIES,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        __refresh__: 'true',
        _extra: '',
        page: String(Math.floor(count / perPage) + 1),
        page_size: String(perPage),
        platform: 'pc',
        highlight: '1',
        context: '',
        single_column: '0',
        keyword,
        category_id: '',
        search_type: 'video',
        dynamic_offset: '0',
        preload: 'true',
        com2co: 'true'
      })
      urls.push(SEARCH_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url, { headers: { Referer: 'https://www.bilibili.com/' } })
    if (!response.ok) return
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    if (toInt(payload.code, -1) !== 0) return
    const results = safeGet(payload, ['data', 'result'], []) as Array<Record<string, unknown>>
    if (!Array.isArray(results)) return

    for (const result of results) {
      if (ctx.full) break
      try {
        for (const song of await this.parseOne(result)) {
          if (ctx.full) break
          ctx.push(song)
        }
      } catch {
        /* 跳过该条目 */
      }
    }
  }

  /** 展开多 P 视频：每一 P 是一条独立结果 */
  private async parseOne(result: Record<string, unknown>): Promise<SongInfo[]> {
    const bvid = String(result.bvid ?? '')
    if (!result.id || !bvid) return []

    const viewResponse = await this.http.get(`${VIEW_URL}?bvid=${bvid}`)
    if (!viewResponse.ok) return []
    const view = parseJsonLoose<Record<string, unknown>>(viewResponse.text)
    const pages = (safeGet(view, ['data', 'pages'], []) ?? []) as Array<Record<string, unknown>>
    const rootTitle = String(safeGet(view, ['data', 'title'], '') ?? '')
    if (!Array.isArray(pages)) return []

    const output: SongInfo[] = []
    for (const page of pages) {
      const cid = page?.cid
      const part = String(page?.part ?? '')
      if (!cid || !part) continue

      const playResponse = await this.http.get(`${PLAYURL_URL}?fnval=16&bvid=${bvid}&cid=${cid}`)
      if (!playResponse.ok) continue
      const play = parseJsonLoose<Record<string, unknown>>(playResponse.text)

      // 优先无损 → 杜比 → 普通；同一档内取带宽/体积最大的
      let audios = (safeGet(play, ['data', 'dash', 'flac', 'audio'], []) ?? []) as DashAudio[]
      if (!Array.isArray(audios) || !audios.filter((item) => item && pickAudioUrl(item)).length) {
        audios = (safeGet(play, ['data', 'dash', 'dolby', 'audio'], []) ?? []) as DashAudio[]
      }
      if (!Array.isArray(audios) || !audios.filter((item) => item && pickAudioUrl(item)).length) {
        audios = (safeGet(play, ['data', 'dash', 'audio'], []) ?? []) as DashAudio[]
      }
      const candidates = (Array.isArray(audios) ? audios : [])
        .filter((item) => item && typeof item === 'object' && pickAudioUrl(item))
        .sort((a, b) => (toInt(b.bandwidth) - toInt(a.bandwidth)) || (toInt(b.filesize) - toInt(a.filesize)))
        .map((item) => pickAudioUrl(item))
        .filter((url) => /^https?:/i.test(url))
      if (!candidates.length) continue

      const probed = await probeFirst(candidates, { headers: { Referer: HEADERS.Referer } })
      if (!probed) continue

      const cover = String(result.pic ?? '')
      const durationS = toInt(toFloat(safeGet(play, ['data', 'dash', 'duration'], 0)))
      output.push(
        makeSong(this.key, {
          identifier: String(cid),
          songName: part === rootTitle ? part : `${rootTitle} - ${part}`,
          singers: result.author,
          album: bvid,
          // B 站返回的是 m4s 分片容器，落盘按 m4a 处理
          ext: probed.ext === 'm4s' || probed.ext === 'mp4' ? 'm4a' : probed.ext,
          fileSizeBytes: probed.size,
          durationS,
          coverUrl: cover && !/^https?:/i.test(cover) ? `https:${cover}` : cover,
          downloadUrl: probed.url,
          headers: { Referer: HEADERS.Referer },
          protocol: probed.protocol,
          raw: { search: result, play }
        })
      )
    }
    return output
  }
}
