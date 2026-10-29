import type {
  ChartSummary,
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { buildLyric } from '@shared/lyric'
import { BaseProvider, DESKTOP_UA } from './base'
import { ProviderError, type SearchArgs } from './types'
import { mediaUrl } from '../media'
import { decodeHtml } from '../utils'
import { extractQQUin, qqCookieHeader } from './cookies'
import { decryptQrc, extractQrcLyric } from './qrc'

interface QQTrack {
  songmid: string
  songname: string
  singer?: Array<{ name: string }>
  albumname?: string
  albummid?: string
  interval?: number
  media_mid?: string
  pay?: { payplay?: number }
}

/** musicu.fcg 搜索模块（DoSearchForQQMusicDesktop）返回的新版曲目结构 */
interface QQSongNew {
  mid: string
  name: string
  singer?: Array<{ name: string }>
  album?: { mid?: string; name?: string }
  interval?: number
  file?: { media_mid?: string; size_flac?: number; size_320mp3?: number; size_128mp3?: number }
  pay?: { pay_play?: number }
}

const CHARTS = [
  { id: '26', name: '热歌榜', subtitle: 'QQ 音乐热度最高的 100 首' },
  { id: '4', name: '新歌榜', subtitle: '本周新上架单曲' },
  { id: '62', name: '飙升榜', subtitle: '播放增速最快' }
]

/** 官方榜单目录条目（fcg_myqq_toplist） */
interface QQTopListItem {
  id: number
  topTitle: string
  listenCount?: number
  picUrl?: string
}

/**
 * QQ 音乐适配器。
 * 搜索与榜单走公开的 c.y.qq.com 接口；播放地址需要通过 musicu.fcg 换取 vkey，
 * 未登录时大量歌曲会返回空 purl —— 这里显式抛 blocked，让上层触发跨平台换源。
 */
export class QQProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'qq',
    name: 'QQ 音乐',
    short: 'QQ',
    color: '#31c27c',
    gradient: ['#41d18a', '#0b6b43'],
    capabilities: { search: true, charts: true, stream: true, lyric: true },
    description: '官方全量榜单（巅峰 / 地区 / 曲风），封面与歌词质量高',
    note: '搜索与播放都需要登录；未登录时将自动换源到其它平台'
  }

  private readonly referer = 'https://y.qq.com/'
  private readonly guid = String(1000000000 + Math.floor(Math.random() * 900000000))
  /** 官方榜单目录缓存（10 分钟） */
  private toplistCache: { at: number; items: ChartSummary[] } | null = null

  protected baseHeaders(): Record<string, string> {
    return {
      'User-Agent': DESKTOP_UA,
      Referer: this.referer,
      Accept: 'application/json, text/plain, */*',
      // 用户在设置里粘贴了自己的登录态才带 Cookie；匿名请求保持原样
      ...qqCookieHeader()
    }
  }

  async search({ keyword, page, limit }: SearchArgs): Promise<SearchPage> {
    // QQ 已下线老的 c.y.qq.com/soso client_search_cp 接口（匿名和带登录态都一律 HTTP 500），
    // 搜索统一切到 u.y.qq.com/musicu.fcg 的桌面端搜索模块。
    // 注意：该模块未登录时返回空列表（code=0），所以匿名状态下直接给出明确引导。
    const uin = extractQQUin()
    const data = await this.json<{
      req?: {
        code?: number
        data?: { body?: { song?: { list?: QQSongNew[]; totalnum?: number } } }
      }
    }>(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: this.referer },
        body: JSON.stringify({
          comm: { ct: 24, cv: 1770, uin: uin || '0', format: 'json' },
          req: {
            module: 'music.search.SearchCgiService',
            method: 'DoSearchForQQMusicDesktop',
            param: { search_type: 0, query: keyword, page_num: page, num_per_page: limit }
          }
        })
      },
      1
    )

    const song = data.req?.data?.body?.song
    const list = song?.list ?? []
    if (!list.length && !uin) {
      throw new ProviderError(
        'blocked',
        'QQ 音乐搜索现在需要登录：到 设置 → 账号 登录 QQ（扫码或粘贴 Cookie）',
        this.info.id
      )
    }
    const total = song?.totalnum ?? list.length
    return {
      items: list.map((track) => this.mapNewTrack(track)),
      total,
      page,
      hasMore: page * limit < total
    }
  }

  /** 新版搜索结果的字段映射（与老接口 mapTrack 字段名不同） */
  private mapNewTrack(track: QQSongNew): Song {
    const albumMid = track.album?.mid ?? ''
    const file = track.file
    return {
      id: track.mid,
      platform: this.info.id,
      name: decodeHtml(track.name),
      artists: (track.singer ?? []).map((s) => decodeHtml(s.name)).filter(Boolean),
      album: decodeHtml(track.album?.name ?? ''),
      coverUrl: albumMid
        ? mediaUrl(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`, 'https://y.qq.com/')
        : null,
      duration: (track.interval ?? 0) * 1000,
      vip: track.pay?.pay_play === 1,
      qualityMax: file?.size_flac
        ? 'lossless'
        : file?.size_320mp3
          ? 'high'
          : 'standard',
      streamable: track.pay?.pay_play !== 1,
      extra: {
        mediaMid: file?.media_mid || track.mid,
        albumMid
      }
    }
  }

  private mapTrack(track: QQTrack): Song {
    const albumMid = track.albummid ?? ''
    return {
      id: track.songmid,
      platform: this.info.id,
      name: decodeHtml(track.songname),
      artists: (track.singer ?? []).map((s) => decodeHtml(s.name)).filter(Boolean),
      album: decodeHtml(track.albumname ?? ''),
      coverUrl: albumMid
        ? mediaUrl(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`, 'https://y.qq.com/')
        : null,
      duration: (track.interval ?? 0) * 1000,
      vip: track.pay?.payplay === 1,
      streamable: track.pay?.payplay !== 1,
      extra: {
        mediaMid: track.media_mid || track.songmid,
        albumMid
      }
    }
  }

  async charts(): Promise<ChartSummary[]> {
    // 10 分钟缓存：榜单目录变化极慢，避免每次进页都打接口
    if (this.toplistCache && Date.now() - this.toplistCache.at < 10 * 60_000) {
      return this.toplistCache.items
    }
    try {
      const data = await this.json<{ data?: { topList?: QQTopListItem[] } }>(
        'https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json',
        { headers: { Referer: this.referer } }
      )
      const list = (data.data?.topList ?? []).filter(
        (item) => item.topTitle && !/mv/i.test(item.topTitle)
      )
      if (list.length) {
        const items = list.map((item) => ({
          id: String(item.id),
          platform: this.info.id,
          name: item.topTitle,
          subtitle:
            item.listenCount && item.listenCount > 0
              ? `${Math.round(item.listenCount / 10000)}万人在听`
              : undefined,
          coverUrl: item.picUrl ? mediaUrl(item.picUrl, this.referer) : null,
          updateFrequency: '每日更新'
        }))
        // 精选 9 个（顺序即展示顺序）：前四个巅峰榜为发现页固定精选，其余为曲风/场景补充。
        // 按关键字在官方目录里取首个匹配（官方名称带「巅峰榜·」前缀，且热歌/新歌有同名榜，官方排序在前者胜出）。
        const keywords = [
          '飙升',
          '热歌',
          '新歌',
          '流行指数',
          '说唱',
          '电音',
          '国乐',
          '抖音热歌',
          '影视金曲'
        ]
        const picked: ChartSummary[] = []
        for (const keyword of keywords) {
          const hit = items.find((item) => !picked.includes(item) && item.name.includes(keyword))
          if (hit) picked.push(hit)
        }
        if (picked.length >= 9) {
          this.toplistCache = { at: Date.now(), items: picked }
          return picked
        }
        // 关键字匹配不齐（官方目录变动）时退回全量列表，保证页不空
        this.toplistCache = { at: Date.now(), items }
        return items
      }
    } catch {
      /* 目录接口挂了回退到内置三榜 */
    }
    return CHARTS.map((chart) => ({
      id: chart.id,
      platform: this.info.id,
      name: chart.name,
      subtitle: chart.subtitle,
      coverUrl: null,
      updateFrequency: '每日更新'
    }))
  }

  async chartDetail({
    id,
    page,
    limit
  }: {
    id: string
    page: number
    limit: number
  }): Promise<SearchPage> {
    const url =
      'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?' +
      new URLSearchParams({
        topid: id,
        page: 'detail',
        type: 'top',
        song_begin: String((page - 1) * limit),
        song_num: String(limit),
        format: 'json'
      }).toString()
    const data = await this.json<{
      songlist?: Array<{ data: QQTrack }>
      total_song_num?: number
      cur_song_num?: number
    }>(url, { headers: { Referer: this.referer } })

    const items = (data.songlist ?? []).map((entry) => this.mapTrack(entry.data))
    const total = data.total_song_num ?? items.length
    return {
      items,
      total,
      page,
      hasMore: page * limit < total
    }
  }

  async resolveStream(song: Song, quality: Quality): Promise<StreamInfo> {
    const mediaMid = String(song.extra?.mediaMid ?? song.id)
    // vkey 的 uin 必须与 Cookie 里的登录态一致，否则 VIP 曲目依然拿不到地址
    const uin = extractQQUin()
    const ladder =
      quality === 'lossless'
        ? [
            { prefix: 'F000', ext: 'flac', label: '无损 FLAC', quality: 'lossless' as Quality },
            { prefix: 'M800', ext: 'mp3', label: '320k MP3', quality: 'high' as Quality }
          ]
        : quality === 'high'
          ? [
              { prefix: 'M800', ext: 'mp3', label: '320k MP3', quality: 'high' as Quality },
              { prefix: 'M500', ext: 'mp3', label: '128k MP3', quality: 'standard' as Quality }
            ]
          : [{ prefix: 'M500', ext: 'mp3', label: '128k MP3', quality: 'standard' as Quality }]

    for (const step of ladder) {
      const filename = `${step.prefix}${mediaMid}.${step.ext}`
      const payload = {
        req_0: {
          module: 'vkey.GetVkeyServer',
          method: 'CgiGetVkey',
          param: {
            guid: this.guid,
            songmid: [song.id],
            songtype: [0],
            uin: uin || '0',
            loginflag: 1,
            platform: '20',
            filename: [filename]
          }
        },
        comm: { uin: uin ? Number(uin) : 0, format: 'json', ct: 24, cv: 0 }
      }
      const data = await this.json<{
        req_0?: {
          data?: { sip?: string[]; midurlinfo?: Array<{ purl?: string; result?: number }> }
        }
      }>(
        'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Referer: this.referer },
          body: JSON.stringify(payload)
        },
        1
      )
      const info = data.req_0?.data?.midurlinfo?.[0]
      const purl = info?.purl ?? ''
      if (!purl) continue
      const sip = data.req_0?.data?.sip?.[0] ?? 'https://dl.stream.qqmusic.qq.com/'
      const url = `${sip}${purl}`
      return {
        url: mediaUrl(url, this.referer),
        directUrl: url,
        headers: { Referer: this.referer },
        quality: step.quality,
        label: step.label,
        format: step.ext,
        expiresAt: Date.now() + 20 * 60_000
      }
    }
    throw new ProviderError(
      'blocked',
      'QQ 音乐未返回播放地址（该曲目需要登录或会员）',
      this.info.id
    )
  }

  async lyric(song: Song): Promise<Lyric | null> {
    // 登录态优先拿 QRC 逐字歌词（crypt=1 的加密分支，3DES 解密）
    const karaoke = await this.fetchKaraoke(song)
    if (karaoke) return karaoke

    try {
      const raw = await this.text(
        'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?' +
          new URLSearchParams({
            songmid: song.id,
            format: 'json',
            nobase64: '0',
            g_tk: '5381'
          }).toString(),
        { headers: { Referer: 'https://y.qq.com/portal/player.html' } }
      )
      const jsonText = raw.trim().replace(/^[^(]*\(/, '').replace(/\)\s*$/, '')
      const data = JSON.parse(jsonText) as { lyric?: string; trans?: string }
      const decode = (value?: string): string =>
        value ? Buffer.from(value, 'base64').toString('utf8') : ''
      const lyric = decode(data.lyric)
      if (!lyric.trim()) return null
      return buildLyric(lyric, decode(data.trans), this.info.name)
    } catch {
      return null
    }
  }

  /**
   * PlayLyricInfo 拿 QRC 逐字歌词。QQ 只在带登录 Cookie 时下发 qrc 字段内容
   * （匿名只回标记），所以未登录直接跳过，不浪费一次往返。
   */
  private async fetchKaraoke(song: Song): Promise<Lyric | null> {
    if (!qqCookieHeader().Cookie) return null
    try {
      const data = await this.json<{
        req_1?: { data?: { qrc?: string; trans?: string } }
      }>(
        'https://u.y.qq.com/cgi-bin/musicu.fcg',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Referer: this.referer },
          body: JSON.stringify({
            comm: { uin: 0, format: 'json', ct: 19, cv: 1863 },
            req_1: {
              module: 'music.musichallSong.PlayLyricInfo',
              method: 'GetPlayLyricInfo',
              param: {
                songMid: song.id,
                crypt: 1,
                qrc: 1,
                qrc_t: 0,
                trans: 1,
                trans_t: 0,
                roma: 0,
                roma_t: 0,
                needSingingAnnotations: false,
                type: 1,
                lrc_t: 0
              }
            }
          })
        },
        1
      )
      const hex = data.req_1?.data?.qrc
      // 未登录 / 无版权时这里是数字 0 或空串
      if (typeof hex !== 'string' || hex.length < 100) return null
      const content = extractQrcLyric(decryptQrc(hex))
      if (!content.trim()) return null
      const trans = data.req_1?.data?.trans
      const transText =
        typeof trans === 'string' && trans.length > 10
          ? Buffer.from(trans, 'base64').toString('utf8')
          : ''
      return buildLyric('', transText, this.info.name, content, 'qrc')
    } catch {
      // 解密失败等异常不阻塞播放，退回匿名 LRC
      return null
    }
  }
}
