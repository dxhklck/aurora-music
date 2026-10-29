import { randomUUID, createHash } from 'node:crypto'
import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose, rawGetWithBody } from '../http'
import { cleanLrc, md5Hex, safeGet, secondsToHms, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 波点音乐（酷我）。
 *
 * 迁移时踩到的两个坑，都记在这里：
 *
 * 1. **搜索必须带 `devid` / `qimei36` 头**，否则 `bd-api.kuwo.cn` 一律返回
 *    `code: 402`。这两个值是客户端首次启动时随机生成的设备号，无登录态时
 *    自造一个即可。
 * 2. **官方取地址接口要求「GET + JSON body」**。Node 的 fetch 直接拒绝这种写法，
 *    只能走 `node:https` 原生请求。实测该接口在无 Cookie
 *    时本来也走不通（checkRight 返回 500），而真实链路一直是第三方签名接口
 *    （假空 / 天宝）先命中，所以这里只保留第三方路径——行为与线上一致，
 *    少一条注定失败的请求。
 */

const SEARCH_URL = 'https://bd-api.kuwo.cn/api/search/music/list?'
const JIAKONG_URL = 'https://nmobi.kuwo.cn/mobi.s'
const TIANBAO_URL = 'https://mobi.kuwo.cn/mobi.s'
/** 第 6 档：2000k flac。再高的档位是 DRM 加密流，拿到也没用 */
const QUALITY = { format: 'flac', br: '2000kflac' }

const BASE_HEADERS: Record<string, string> = {
  'user-agent': 'Dart/3.3 (dart:io)',
  plat: 'win',
  'api-ver': 'application/json',
  channel: 'W1',
  brand: 'Windows 11 Pro for Workstations',
  net: 'wifi',
  'content-type': 'application/json',
  ver: '1.1.5',
  svrver: '13'
}

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'

/** 设备号：无登录态时自造，仅用于让接口放行 */
const DEVICE_ID = createHash('md5').update(Buffer.from(randomUUID())).digest('hex')

interface KuwoAuth {
  uid: string
  token: string
  devId: string
}

const AUTH: KuwoAuth = { uid: '-1', token: '', devId: DEVICE_ID }

function apiHeaders(): Record<string, string> {
  return { ...BASE_HEADERS, devid: AUTH.devId, qimei36: AUTH.devId }
}

export class BodianSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'bodian',
      label: '波点音乐',
      pageSize: 3,
      headers: apiHeaders(),
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        pn: String(Math.floor(count / perPage)),
        rn: String(perPage),
        keyword,
        correct: '1',
        uid: AUTH.uid,
        token: AUTH.token
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
    const results = safeGet(payload, ['data', 'resultList'], []) as Array<Record<string, unknown>>
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

  /**
   * 取址顺序与上游一致：第三方先试，官方补位，最后按**文件体积**取大。
   *
   * 「按体积取大」不是优化而是必需：第三方接口对非会员曲目经常只给
   * 192k 的 ogg，而官方接口能给 320k mp3。少了这一步，同一首歌的音质
   * 会明显下降（实测同一首歌 5.5MB → 8.8MB 的差距）。
   */
  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const songId = String(result.id ?? '')
    if (!songId) return null

    const thirdParty = await this.resolveThirdParty(songId)
    // 第三方已经是无损就不必再问官方，省一轮请求
    if (thirdParty && thirdParty.ext === 'flac') return this.buildSong(result, songId, thirdParty)

    const official = await this.resolveOfficial(result, songId)
    if (official && thirdParty) {
      const chosen = thirdParty.size > official.size ? thirdParty : official
      return this.buildSong(result, songId, chosen)
    }
    const fallback = official ?? thirdParty
    return fallback ? this.buildSong(result, songId, fallback) : null
  }

  private async buildSong(
    result: Record<string, unknown>,
    songId: string,
    source: { url: string; ext: string; size: number; protocol: 'HTTP' | 'HLS'; duration: number }
  ): Promise<SongInfo> {
    const lyric = await this.fetchLyric(songId)
    const cover = String(safeGet(result, ['albumPic'], '') || safeGet(result, ['pic'], '') || '')
    return makeSong(this.key, {
      identifier: songId,
      songName: result.name ?? result.songName,
      singers: result.artist,
      album: result.album,
      ext: source.ext,
      fileSizeBytes: source.size,
      durationS: source.duration,
      coverUrl: cover,
      downloadUrl: source.url,
      headers: { 'User-Agent': WEB_UA },
      protocol: source.protocol,
      lyric,
      raw: { search: result }
    })
  }

  /** 第三方签名接口：假空优先，失败退天宝 */
  private async resolveThirdParty(
    songId: string
  ): Promise<{ url: string; ext: string; size: number; protocol: 'HTTP' | 'HLS'; duration: number } | null> {
    const download = await this.resolveDownload(songId)
    if (!download) return null
    const candidate = String(safeGet(download, ['data', 'url'], '') ?? '')
    if (!/^https?:/i.test(candidate)) return null
    const probed = await probeFirst([candidate], { headers: { 'User-Agent': WEB_UA } })
    if (!probed) return null
    return { ...probed, duration: toInt(toFloat(safeGet(download, ['data', 'duration'], 0))) }
  }

  /**
   * 官方酷我接口：checkRight 判断是否仅试听，再按档位取 audioUrl。
   * 两个请求都要求「GET + JSON body」，因此走 rawGetWithBody。
   */
  private async resolveOfficial(
    result: Record<string, unknown>,
    songId: string
  ): Promise<{ url: string; ext: string; size: number; protocol: 'HTTP' | 'HLS'; duration: number } | null> {
    try {
      const freeSign = decodeURIComponent(String(result.freeSign ?? result.fsig ?? ''))
      const base = { uid: AUTH.uid, token: AUTH.token, musicId: songId, freeSign }
      const checkParams = { ...base, timestamp: String(Date.now()) }
      const checkBody = JSON.stringify({ musicId: songId, freeSign })
      const checkUrl =
        `https://bd-api.kuwo.cn/api/play/music/v2/checkRight?${new URLSearchParams(checkParams).toString()}` +
        `&sign=${this.signQuery('/api/play/music/v2/checkRight', checkParams, checkBody)}`
      const check = await rawGetWithBody(checkUrl, checkBody, apiHeaders())
      if (check.status < 200 || check.status >= 300) return null
      const checkPayload = parseJsonLoose<Record<string, unknown>>(check.text)
      const status = safeGet(checkPayload, ['data', 'status'], null)

      let candidate = ''
      let duration = 0
      if (status === 3 || status === '3') {
        // 仅试听：只能拿 30 秒片段
        candidate = String(
          safeGet(checkPayload, ['data', 'audition', 'https'], '') ||
            safeGet(checkPayload, ['data', 'audition', 'car_url_https'], '') ||
            safeGet(checkPayload, ['data', 'audition', 'url'], '') ||
            safeGet(checkPayload, ['data', 'audition', 'car_url'], '') ||
            ''
        )
        duration = toInt(toFloat(safeGet(checkPayload, ['data', 'audition', 'duration'], 0)))
      } else {
        const urlParams = {
          uid: AUTH.uid,
          token: AUTH.token,
          timestamp: String(Date.now()),
          devId: AUTH.devId,
          musicId: songId,
          format: QUALITY.format,
          br: QUALITY.br,
          freeSign
        }
        const urlBody = JSON.stringify({
          devId: AUTH.devId,
          musicId: songId,
          format: QUALITY.format,
          br: QUALITY.br,
          freeSign
        })
        const audioUrl =
          `https://bd-api.kuwo.cn/api/play/music/v2/audioUrl?${new URLSearchParams(urlParams).toString()}` +
          `&sign=${this.signQuery('/api/play/music/v2/audioUrl', urlParams, urlBody)}`
        const response = await rawGetWithBody(audioUrl, urlBody, {
          ...apiHeaders(),
          uid: AUTH.uid,
          token: AUTH.token
        })
        if (response.status < 200 || response.status >= 300) return null
        const payload = parseJsonLoose<Record<string, unknown>>(response.text)
        candidate = String(safeGet(payload, ['data', 'audioHttpsUrl'], '') || safeGet(payload, ['data', 'audioUrl'], '') || '')
        duration = toInt(toFloat(safeGet(payload, ['data', 'duration'], 0)))
      }

      if (!/^https?:/i.test(candidate)) return null
      const probed = await probeFirst([candidate], { headers: { 'User-Agent': WEB_UA } })
      if (!probed) return null
      return { ...probed, duration }
    } catch {
      return null
    }
  }

  /**
   * 酷我的签名算法：`md5("kuwotest" + 排序后的 query 字母数字 + md5(body+"kuwotest") + path)`。
   * 注意 `urlencode` 之后再过滤字符，顺序不能颠倒。
   */
  private signQuery(path: string, params: Record<string, string>, bodyText = ''): string {
    const encoded = new URLSearchParams(params).toString()
    const filtered = [...encoded].filter((ch) => /[a-zA-Z0-9]/.test(ch)).sort().join('')
    let seed = `kuwotest${filtered}`
    if (bodyText) seed += md5Hex(`${bodyText}kuwotest`)
    return md5Hex(`${seed}${path}`)
  }

  /** 第三方签名接口：假空优先，失败退天宝。两者返回结构相同 */
  private async resolveDownload(songId: string): Promise<Record<string, unknown> | null> {
    const attempts: Array<{ url: string; headers: Record<string, string>; body?: string; method?: string; form?: Record<string, string> }> = [
      {
        url: `${JIAKONG_URL}?${new URLSearchParams({
          f: 'web',
          source: 'kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk',
          type: 'convert_url_with_sign',
          rid: songId,
          br: QUALITY.br,
          // 上游用 random.randint(0, 4294967295)；服务端会按用户号分桶挑码率，
          // 取值范围缩小会让同一首歌稳定落到低码率档，必须保持同样的区间
          user: String(Math.floor(Math.random() * 4294967296)),
          loginUid: String(Math.floor(Math.random() * 4294967296))
        }).toString()}`,
        headers: { 'User-Agent': WEB_UA, Accept: '*/*' }
      },
      {
        url: TIANBAO_URL,
        headers: { 'User-Agent': 'Dart/2.19 (dart:io)', plat: 'ar', channel: 'aliopen' },
        form: {
          f: 'web',
          user: String(Math.floor(Math.random() * 4294967296)),
          source: 'kwplayerhd_ar_4.3.0.8_tianbao_T1A_qirui.apk',
          type: 'convert_url_with_sign',
          br: QUALITY.br,
          rid: songId
        }
      }
    ]

    for (const attempt of attempts) {
      try {
        const response = attempt.form
          ? await this.http.get(`${attempt.url}?${new URLSearchParams(attempt.form).toString()}`, { headers: attempt.headers })
          : await this.http.get(attempt.url, { headers: attempt.headers })
        if (!response.ok) continue
        const payload = parseJsonLoose<Record<string, unknown>>(response.text)
        if (toInt(payload.code, 0) !== 200) continue
        const url = String(safeGet(payload, ['data', 'url'], '') ?? '')
        if (/^https?:/i.test(url)) return payload
      } catch {
        /* 换下一个通道 */
      }
    }
    return null
  }

  /** 歌词：酷我的 lrcx 接口，q 参数是「URL 编码后再 base64」 */
  private async fetchLyric(songId: string): Promise<string> {
    const raw = `type=lyric&req=2&lrcx=1&rid=${songId}&songname=&artist=&corp=kuwo&fromchannel=bodian`
    // encodeURIComponent 会把 = 和 & 转义，但这个接口要求原样保留，手动还原
    const quoted = encodeURIComponent(raw).replace(/%3D/g, '=').replace(/%26/g, '&')
    const q = Buffer.from(quoted, 'utf8').toString('base64')
    try {
      const response = await this.http.get(
        `http://mlyric.kuwo.cn/mobi.s?f=bodian&q=${encodeURIComponent(q)}&uid=${AUTH.uid}&token=${AUTH.token}`,
        { headers: { 'User-Agent': WEB_UA } }
      )
      if (!response.ok) return ''
      const payload = parseJsonLoose<Record<string, unknown>>(response.text)
      const content = String(safeGet(payload, ['data', 'content'], '') ?? '')
      if (!content) return ''
      const text = Buffer.from(content, 'base64').toString('utf8')
      // 去掉逐字时间轴标记 `<-123,456>`
      return cleanLrc(text.replace(/<-?\d+,-?\d+>/g, ''))
    } catch {
      return ''
    }
  }
}

/** 供单测：确认时长格式化走统一的 secondsToHms */
export function bodianDuration(seconds: number): string {
  return secondsToHms(seconds)
}
