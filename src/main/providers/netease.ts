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
import { neteaseCookieHeader } from './cookies'
import { ProviderError, type SearchArgs } from './types'
import { mediaUrl } from '../media'

interface NeteaseSong {
  id: number
  name: string
  ar?: Array<{ name: string }>
  al?: { name?: string; picUrl?: string }
  dt?: number
  /** h/m/l = 匿名可得的各档音质，size 为该档文件字节数（估值，实际播放音质可能不同） */
  h?: { br?: number; size?: number }
  m?: { br?: number; size?: number }
  l?: { br?: number; size?: number }
  privilege?: { st?: number }
  fee?: number
}

interface NeteaseChartCache {
  tracks: Song[]
  total: number
  at: number
}

const CHART_DEFS: Array<{ id: string; name: string; subtitle: string; freq: string }> = [
  { id: '3778678', name: '热歌榜', subtitle: '此刻最多人播放', freq: '每天更新' },
  { id: '19723756', name: '飙升榜', subtitle: '上升最快的单曲', freq: '刚刚更新' },
  { id: '3779629', name: '新歌榜', subtitle: '新鲜出炉的作品', freq: '刚刚更新' },
  { id: '2884035', name: '原创榜', subtitle: '独立与原创力量', freq: '每周四更新' }
]

/**
 * 精选榜单白名单（顺序即展示顺序，共 9 个）：官方 /api/toplist 返回 65 个榜，
 * 全收太杂（音乐合伙人子榜、俄语/越南语等），按「核心榜 + 曲风 + 全球」挑选。
 * 前四个（飙升/新歌/热歌/原创）同时是发现音乐页的固定精选；id 动态取，官方调整自动跟上。
 */
const CHART_NAME_WHITELIST = [
  '飙升榜',
  '新歌榜',
  '热歌榜',
  '原创榜',
  '网易云中文说唱榜',
  '网易云电音榜',
  '网易云ACG榜',
  '网易云国风榜',
  '美国Billboard榜'
]

const LEVEL_LABEL: Record<string, string> = {
  standard: '标准 128k',
  higher: '较高 192k',
  exhigh: '极高 320k',
  lossless: '无损',
  hires: 'Hi-Res'
}

/**
 * 网易云适配器。
 * 搜索走 cloudsearch/pc（musicdl 同款接口），播放地址走 song/enhance/player/url/v1，
 * 并按 无损 → 极高 → 标准 逐档回退，最后再试外链地址，每一档都用 probe 实测。
 */
export class NeteaseProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'netease',
    name: '网易云音乐',
    short: '网易',
    color: '#ec4141',
    gradient: ['#ff5f6d', '#8b1a1a'],
    capabilities: { search: true, charts: true, stream: true, lyric: true },
    description: '曲库最全，官方 20 个榜单：热歌 / 飙升 / 说唱 / 电音 / 国风 / ACG…',
    note: '部分 VIP / 独家歌曲可能无法播放，会自动跨平台换源'
  }

  private readonly referer = 'https://music.163.com/'
  private readonly chartCache = new Map<string, NeteaseChartCache>()
  /** 官方榜单目录缓存（10 分钟） */
  private toplistCache: { at: number; items: ChartSummary[] } | null = null

  protected baseHeaders(): Record<string, string> {
    return {
      'User-Agent': DESKTOP_UA,
      Referer: this.referer,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      // 登录态：解锁 lossless/hires 音质与 VIP 曲目（设置里粘贴自己的 Cookie）
      ...neteaseCookieHeader()
    }
  }

  async search({ keyword, page, limit }: SearchArgs): Promise<SearchPage> {
    const offset = (page - 1) * limit
    const data = await this.form<{
      result?: { songs?: NeteaseSong[]; songCount?: number }
      code?: number
    }>(
      'https://music.163.com/api/cloudsearch/pc',
      { s: keyword, type: 1, limit, offset },
      this.referer
    )
    const songs = data.result?.songs ?? []
    const total = data.result?.songCount ?? songs.length
    return {
      items: songs.map((song) => this.mapSong(song)),
      total,
      page,
      hasMore: offset + songs.length < total
    }
  }

  private mapSong(song: NeteaseSong): Song {
    const pic = song.al?.picUrl ?? ''
    const maxBr = song.h?.br ?? song.m?.br ?? song.l?.br ?? 0
    return {
      id: String(song.id),
      platform: this.info.id,
      name: song.name,
      artists: (song.ar ?? []).map((item) => item.name).filter(Boolean),
      album: song.al?.name ?? '',
      coverUrl: pic ? mediaUrl(`${pic}?param=320y320`, this.referer) : null,
      duration: song.dt ?? 0,
      qualityLabel: song.h?.br ? `${Math.round(song.h.br / 1000)}k` : undefined,
      fileSize: song.h?.size || song.m?.size || song.l?.size || undefined,
      // fee: 1=VIP 曲目 4=数字专辑购买 8=非会员仅可听标准音质
      vip: song.fee === 1 || song.fee === 4,
      qualityMax: maxBr >= 999000 ? 'lossless' : maxBr >= 320000 ? 'high' : 'standard',
      streamable: song.privilege?.st === undefined ? true : song.privilege.st > 0
    }
  }

  async charts(): Promise<ChartSummary[]> {
    // 10 分钟缓存：官方榜单目录变化极慢，避免每次进页都打接口
    if (this.toplistCache && Date.now() - this.toplistCache.at < 10 * 60_000) {
      return this.toplistCache.items
    }
    try {
      const data = await this.json<{
        list?: Array<{ id: number; name: string; updateFrequency?: string; coverImgUrl?: string }>
      }>('https://music.163.com/api/toplist', { headers: { Referer: this.referer } })
      const byName = new Map((data.list ?? []).map((item) => [item.name, item]))
      const picked: ChartSummary[] = []
      for (const name of CHART_NAME_WHITELIST) {
        const item = byName.get(name)
        if (!item) continue
        // 四大核心榜沿用内置文案，其余用官方更新频率
        const preset = CHART_DEFS.find((def) => def.name === name)
        picked.push({
          id: String(item.id),
          platform: this.info.id,
          name: item.name,
          subtitle: preset?.subtitle,
          coverUrl: item.coverImgUrl
            ? mediaUrl(`${item.coverImgUrl}?param=300y300`, this.referer)
            : null,
          updateFrequency: item.updateFrequency ?? preset?.freq ?? '每日更新'
        })
      }
      if (picked.length) {
        this.toplistCache = { at: Date.now(), items: picked }
        return picked
      }
    } catch {
      /* 目录接口挂了回退到内置四榜 */
    }
    return CHART_DEFS.map((item) => ({
      id: item.id,
      platform: this.info.id,
      name: item.name,
      subtitle: item.subtitle,
      coverUrl: null,
      updateFrequency: item.freq
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
    const cached = this.chartCache.get(id)
    if (!cached || Date.now() - cached.at > 5 * 60_000) {
      const tracks = await this.loadChartTracks(id)
      this.chartCache.set(id, { tracks, total: tracks.length, at: Date.now() })
    }
    const entry = this.chartCache.get(id)!
    const start = (page - 1) * limit
    return {
      items: entry.tracks.slice(start, start + limit),
      total: entry.total,
      page,
      hasMore: start + limit < entry.total
    }
  }

  private async loadChartTracks(id: string): Promise<Song[]> {
    const data = await this.json<{
      playlist?: { tracks?: NeteaseSong[]; trackCount?: number }
      code?: number
    }>(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000`, {
      headers: { Referer: this.referer }
    })
    const tracks = data.playlist?.tracks ?? []
    if (tracks.length) return tracks.map((song) => this.mapSong(song))

    // 详情接口有时只返回 trackIds，用 track/all 再取一次
    const all = await this.json<{ songs?: NeteaseSong[] }>(
      `https://music.163.com/api/playlist/track/all?id=${id}&limit=500&offset=0`,
      { headers: { Referer: this.referer } }
    )
    return (all.songs ?? []).map((song) => this.mapSong(song))
  }

  async resolveStream(song: Song, quality: Quality): Promise<StreamInfo> {
    const levels =
      quality === 'lossless'
        ? ['lossless', 'exhigh', 'standard']
        : quality === 'high'
          ? ['exhigh', 'standard']
          : ['standard']

    for (const level of levels) {
      const url = await this.requestLevelUrl(song.id, level)
      if (!url) continue
      const probe = await this.probe(url, this.referer)
      if (!probe.ok) continue
      return {
        url: mediaUrl(probe.finalUrl || url, this.referer),
        directUrl: probe.finalUrl || url,
        headers: { Referer: this.referer },
        quality: level === 'lossless' ? 'lossless' : level === 'standard' ? 'standard' : 'high',
        label: LEVEL_LABEL[level] ?? level,
        // 网易对 FLAC 也返回 application/octet-stream，Content-Type 判不出来；
        // 嗅探文件头（fLaC 魔数）才能正确落 .flac 扩展名，否则无损会被存成 .mp3
        format: await this.sniffFormat(probe.finalUrl || url),
        expiresAt: Date.now() + 10 * 60_000
      }
    }

    // 最后一档：外链接口（128k，非 VIP 曲目可用）
    const outer = `https://music.163.com/song/media/outer/url?id=${song.id}.mp3`
    const probe = await this.probe(outer, this.referer)
    if (probe.ok) {
      return {
        url: mediaUrl(probe.finalUrl || outer, this.referer),
        directUrl: probe.finalUrl || outer,
        headers: { Referer: this.referer },
        quality: 'standard',
        label: '标准 128k',
        format: 'mp3',
        expiresAt: Date.now() + 8 * 60_000
      }
    }
    throw new ProviderError(
      'blocked',
      '网易云未返回可用播放地址（可能是 VIP / 无版权歌曲）',
      this.info.id
    )
  }

  /** 取前 4 字节判断真实封装：fLaC 魔数 → flac；ID3/MPEG 帧头 → mp3；失败回退 URL 后缀 */
  private async sniffFormat(url: string): Promise<'flac' | 'mp3'> {
    try {
      const response = await fetch(url, {
        headers: { ...this.baseHeaders(), Range: 'bytes=0-3', Referer: this.referer },
        signal: AbortSignal.timeout(8_000)
      })
      // 只读 4 字节后立刻断开。用 arrayBuffer() 的话，CDN 一旦忽略 Range
      // 就会把整首无损（30MB+）拖下来才返回——播放一首歌白付一次全量带宽。
      const reader = response.body?.getReader()
      let magic = ''
      if (reader) {
        try {
          const { value } = await reader.read()
          if (value) magic = Buffer.from(value.subarray(0, 4)).toString('latin1')
        } finally {
          await reader.cancel().catch(() => undefined)
        }
      }
      if (magic.startsWith('fLaC')) return 'flac'
      if (magic.startsWith('ID3') || magic.charCodeAt(0) === 0xff) return 'mp3'
    } catch {
      /* 嗅探失败走后缀推断 */
    }
    return /\.flac(\?|$)/i.test(url) ? 'flac' : 'mp3'
  }

  private async requestLevelUrl(id: string, level: string): Promise<string> {    const ids = encodeURIComponent(`[${id}]`)
    try {
      const data = await this.json<{
        data?: Array<{ url?: string | null }>
      }>(
        `https://music.163.com/api/song/enhance/player/url/v1?ids=${ids}&level=${level}&encodeType=mp3`,
        { headers: { Referer: this.referer } }
      )
      const url = data.data?.[0]?.url
      return typeof url === 'string' && url.startsWith('http') ? url : ''
    } catch {
      return ''
    }
  }

  async lyric(song: Song): Promise<Lyric | null> {
    try {
      const data = await this.json<{
        lrc?: { lyric?: string }
        tlyric?: { lyric?: string }
        yrc?: { lyric?: string }
      }>(
        // yv=1 让网易云带上逐字歌词（yrc）。部分歌曲没有 yrc，会返回空字符串，
        // buildLyric 会自动退回 LRC，无需在这里判断。
        `https://music.163.com/api/song/lyric/v1?id=${song.id}&cp=false&lv=-1&kv=-1&tv=-1&rv=-1&yv=1&ytv=0&yrv=0`,
        { headers: { Referer: this.referer } }
      )
      const raw = data.lrc?.lyric ?? ''
      if (!raw.trim() && !(data.yrc?.lyric ?? '').trim()) return null
      return buildLyric(raw, data.tlyric?.lyric ?? '', this.info.name, data.yrc?.lyric ?? '')
    } catch {
      return null
    }
  }
}
