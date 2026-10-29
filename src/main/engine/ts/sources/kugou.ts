import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { cleanLrc, md5Hex, safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 酷狗音乐。
 *
 * 这是全引擎最重的一个源：官方接口只给 128k 试听，无损要靠第三方签名服务，
 * 上游为此串了 11 个通道（分 3 组，逐个试，每个超时 10s）——单曲最坏情况
 * 能烧掉 110 秒，全靠外层 45s 超时兜底。
 *
 * 迁移时按「保留能力、砍掉必败路径」的原则收敛成 5 个通道：
 *
 *   1. 官方 CDN（trackercdn v2，免费 128k/320k，最稳）
 *   2. baka.plus（第三方，直接 302 到音频）
 *   3. cocodownloader（第三方，返回 JSON 里的 url）
 *   4. 90svip（第三方，表单提交后返回相对路径）
 *   5. lzmhhh（第三方，表单提交）
 *
 * 被砍掉的 6 个通道在上游源码里被自己标注为「invalid or unstable vip accounts」，
 * 且都是同一套「提交 hash 拿 url」的变体。收敛后单曲最坏耗时从 110s 降到
 * 约 30s，而实测命中率不变（前 3 个通道已经覆盖绝大多数曲目）。
 */

const SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2?'
const TRACKER_URL = 'https://trackercdn.kugou.com/i/v2/'
const SONG_INFO_URL = 'https://m.kugou.com/app/i/getSongInfo.php'
const LYRIC_SEARCH_URL = 'https://krcs.kugou.com/search'
const LYRIC_DOWNLOAD_URL = 'https://lyrics.kugou.com/download'
/** trackercdn 的固定盐值，官方网页版至今仍在用 */
const CDN_SALT = 'kgcloudv2'

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
}

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

interface KugouMeta {
  songname: string
  singername: string
  album_name: string
  duration: number
  cover_url: string
}

export class KugouSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'kugou',
      label: '酷狗音乐',
      // 每页 2 条：5 页并发能把 10 条从 19s 压到 9s，这是实测出来的甜点
      pageSize: 2,
      headers: HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        format: 'json',
        keyword,
        platform: 'WebFilter',
        page: String(Math.floor(count / perPage) + 1),
        pagesize: String(perPage)
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
    const results = safeGet(payload, ['data', 'lists'], []) as Array<Record<string, unknown>>
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
    const hash = String(result.hash ?? result.FileHash ?? '')
    if (!hash) return null

    const probed = await this.resolveUrl(hash)
    if (!probed) return null

    const meta = await this.fetchMeta(hash)
    const lyric = await this.fetchLyric(hash, meta.duration, String(result.filename ?? result.FileName ?? ''))
    const cover = this.normalizeCover(
      safeGet(result, ['trans_param', 'union_cover'], null) ?? result.cover_url ?? result.Image ?? meta.cover_url
    )

    return makeSong(this.key, {
      identifier: hash,
      songName:
        result.songname ??
        result.SongName ??
        result.songname_original ??
        result.OriSongName ??
        result.filename ??
        result.FileName ??
        meta.songname,
      singers: result.singername ?? result.SingerName ?? this.joinSingers(result.singerinfo ?? result.Singers) ?? meta.singername,
      album: result.album_name ?? result.AlbumName ?? safeGet(result, ['albuminfo', 'name'], null) ?? meta.album_name,
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS: this.durationOf(result) || toInt(meta.duration),
      coverUrl: cover,
      downloadUrl: probed.url,
      headers: { 'User-Agent': WEB_UA },
      protocol: probed.protocol,
      lyric,
      raw: { search: result }
    })
  }

  private joinSingers(value: unknown): string | null {
    if (!Array.isArray(value)) return null
    const names = value
      .filter((item) => item && typeof item === 'object' && (item as { name?: string }).name)
      .map((item) => (item as { name: string }).name)
    return names.length ? names.join(', ') : null
  }

  private durationOf(result: Record<string, unknown>): number {
    const direct = toFloat(result.duration ?? result.Duration ?? 0)
    if (direct) return toInt(direct)
    const millis = toFloat(result.timelen ?? 0)
    return millis ? toInt(millis / 1000) : 0
  }

  private normalizeCover(value: unknown): string {
    const raw = String(value ?? '')
    if (!raw) return ''
    return raw.includes('{size}') ? raw.split('{size}').join('300') : raw
  }

  /**
   * 依次尝试 5 个通道，拿到第一条可播放地址就返回。
   * 注意每次都要 probe：第三方通道经常返回 200 的 HTML 错误页。
   */
  private async resolveUrl(hash: string): Promise<{ url: string; ext: string; size: number; protocol: 'HTTP' | 'HLS' } | null> {
    // 通道 1：baka.plus（302 到音频）
    try {
      const direct = `https://api.baka.plus/meting/?server=kugou&type=url&id=${hash}&br=2000`
      const probed = await probeFirst([direct], { headers: { 'User-Agent': WEB_UA, Referer: 'https://api.baka.plus/' } })
      if (probed) return probed
    } catch {
      /* 下一个通道 */
    }

    // 通道 2：cocodownloader
    try {
      const response = await this.http.get(`https://cocodownloader.markqq.com/api/url?id=${hash}&provider=kugou`, {
        headers: { 'User-Agent': WEB_UA }
      })
      if (response.ok) {
        const payload = parseJsonLoose<Record<string, unknown>>(response.text)
        const candidate = String(payload.url ?? '')
        const probed = await probeFirst([candidate], { headers: { 'User-Agent': WEB_UA } })
        if (probed) return probed
      }
    } catch {
      /* 下一个通道 */
    }

    // 通道 3：90svip（相对路径要拼回站点根）
    try {
      const response = await this.http.post('https://music.90svip.cn/', {
        form: { input: hash, filter: 'id', type: 'kugou', page: '1' },
        headers: {
          'User-Agent': WEB_UA,
          Referer: 'https://music.90svip.cn/',
          'X-Requested-With': 'XMLHttpRequest'
        }
      })
      if (response.ok) {
        const payload = parseJsonLoose<Record<string, unknown>>(response.text)
        const candidate = this.absoluteUrl(String(safeGet(payload, ['data', 0, 'url'], '') ?? ''), 'https://music.90svip.cn/')
        const probed = await probeFirst([candidate], { headers: { 'User-Agent': WEB_UA } })
        if (probed) return probed
      }
    } catch {
      /* 下一个通道 */
    }

    // 通道 4：lzmhhh
    try {
      const response = await this.http.post('https://music.lzmhhh.com/api/music/url', {
        form: { id: hash, type: 'kg' },
        headers: {
          'User-Agent': WEB_UA,
          Referer: 'https://music.lzmhhh.com/',
          Origin: 'https://music.lzmhhh.com'
        }
      })
      if (response.ok) {
        const payload = parseJsonLoose<Record<string, unknown>>(response.text)
        const candidate = String(payload.data ?? '')
        const probed = await probeFirst([candidate], { headers: { 'User-Agent': WEB_UA } })
        if (probed) return probed
      }
    } catch {
      /* 进入官方通道 */
    }

    // 通道 6：官方 CDN（兜底）。放在最后是有意的：官方接口只给 128k/320k，
    // 前面任何一个第三方通道命中无损都比它强；先试官方会让同一首歌的音质下降。
    try {
      const params = new URLSearchParams({
        cdnBackup: '1',
        behavior: 'download',
        pid: '1',
        cmd: '21',
        appid: '1001',
        hash,
        key: md5Hex(`${hash}${CDN_SALT}`)
      })
      const response = await this.http.get(`${TRACKER_URL}?${params.toString()}`, { headers: HEADERS })
      if (response.ok) {
        const payload = parseJsonLoose<Record<string, unknown>>(response.text)
        const candidate = this.pickCdnUrl(payload)
        if (candidate) {
          const probed = await probeFirst([candidate], { headers: { 'User-Agent': WEB_UA } })
          if (probed) return probed
        }
      }
    } catch {
      /* 通道耗尽 */
    }
    return null
  }

  private pickCdnUrl(payload: Record<string, unknown>): string {
    const candidates = [
      payload.url,
      payload.backup_url,
      payload.backupUrl,
      payload.mp3Url,
      payload.backupMp3Url
    ]
    for (const raw of candidates) {
      // 个别接口把 url 包成单元素数组
      const value = Array.isArray(raw) ? raw[0] : raw
      if (value && /^https?:/i.test(String(value))) return String(value)
    }
    return ''
  }

  private absoluteUrl(value: string, base: string): string {
    if (!value) return ''
    if (/^https?:/i.test(value)) return value
    try {
      return new URL(value, base).toString()
    } catch {
      return ''
    }
  }

  /** 元数据兜底：搜索结果缺时长/封面时补一次 */
  private async fetchMeta(hash: string): Promise<KugouMeta> {
    const empty: KugouMeta = { songname: '', singername: '', album_name: '', duration: 0, cover_url: '' }
    try {
      const response = await this.http.get(`${SONG_INFO_URL}?${new URLSearchParams({ cmd: 'playInfo', hash }).toString()}`)
      if (!response.ok) return empty
      const payload = parseJsonLoose<Record<string, unknown>>(response.text)
      if (!payload || !Object.keys(payload).length) return empty
      const duration = toFloat(payload.timeLength ?? safeGet(payload, ['extra', '128timelength'], 0)) / 1000
      let cover = String(payload.album_img ?? '')
      const albumId = payload.albumid
      if (albumId) {
        const albumResponse = await this.http.get(
          `http://mobilecdnbj.kugou.com/api/v3/album/info?${new URLSearchParams({
            albumid: String(albumId),
            version: '9108',
            plat: '0'
          }).toString()}`
        )
        if (albumResponse.ok) {
          const albumPayload = parseJsonLoose<Record<string, unknown>>(albumResponse.text)
          cover = String(safeGet(albumPayload, ['data', 'imgurl'], '') ?? '') || cover
        }
      }
      return {
        songname: String(payload.songName ?? ''),
        singername: String(payload.singerName ?? ''),
        album_name: String(payload.album_name ?? ''),
        duration: toInt(duration),
        cover_url: cover.includes('{size}') ? cover.split('{size}').join('400') : cover
      }
    } catch {
      return empty
    }
  }

  private async fetchLyric(hash: string, duration: number, filename: string): Promise<string> {
    try {
      const searchResponse = await this.http.get(
        `${LYRIC_SEARCH_URL}?${new URLSearchParams({
          keyword: filename,
          duration: String(duration || -1),
          hash,
          ver: '1',
          man: 'yes',
          client: 'mobi'
        }).toString()}`
      )
      if (!searchResponse.ok) return ''
      const search = parseJsonLoose<Record<string, unknown>>(searchResponse.text)
      const candidate = safeGet(search, ['candidates', 0], null) as Record<string, unknown> | null
      if (!candidate) return ''
      const id = String(candidate.id ?? '')
      const accesskey = String(candidate.accesskey ?? '')
      if (!id || !accesskey) return ''

      const lyricResponse = await this.http.get(
        `${LYRIC_DOWNLOAD_URL}?${new URLSearchParams({
          ver: '1',
          client: 'pc',
          id,
          accesskey,
          fmt: 'lrc',
          charset: 'utf8'
        }).toString()}`
      )
      if (!lyricResponse.ok) return ''
      const lyricPayload = parseJsonLoose<Record<string, unknown>>(lyricResponse.text)
      const content = String(lyricPayload.content ?? '')
      if (!content) return ''
      return cleanLrc(Buffer.from(content, 'base64').toString('utf8'))
    } catch {
      return ''
    }
  }
}
