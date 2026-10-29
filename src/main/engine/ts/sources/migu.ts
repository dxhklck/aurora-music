import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { cleanLrc, safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 咪咕音乐。
 *
 * 两个必须原样保留的细节：
 * 1. **响应可能加密**：带 `signature: 1` 头或首字节为 0xAB 时，正文是
 *    「前 4 字节头 + 逐字节滚动异或」的密文，密钥写死在客户端里；
 * 2. **码率档位要按体积降序试**：`rateFormats` 里 SQ 排在 HQ 之后，
 *    必须排序才能先命中无损，否则会先拿 128k 试听再逐档重试（4~6 次往返）。
 */

const SEARCH_URL = 'https://c.musicapp.migu.cn/v1.0/content/search_all.do?'
const LISTEN_URL = 'https://c.musicapp.migu.cn/strategy/listen-url/h5/v2.4'
const CDN_BASE = 'https://d.musicapp.migu.cn'
const MAGIC = 0xab
const CIPHER_KEY = Buffer.from('Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP', 'utf8')

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://h5.nf.migu.cn',
  Referer: 'https://h5.nf.migu.cn/',
  ua: 'Android_migu',
  version: '6.8.8',
  channel: '014021I',
  subchannel: '014021I'
}

/** 解码可能被加密的响应体；解密失败时退回明文解析 */
function decodeBody(bytes: Uint8Array): Record<string, unknown> {
  if (!bytes.length) return {}
  if (bytes[0] !== MAGIC) {
    return parseJsonLoose<Record<string, unknown>>(new TextDecoder('utf-8').decode(bytes))
  }
  const seed = bytes[3]
  const plain = Buffer.alloc(bytes.length - 4)
  for (let index = 0; index < plain.length; index += 1) {
    plain[index] = (bytes[index + 4] + seed - CIPHER_KEY[index % CIPHER_KEY.length]) & 0xff
  }
  const text = plain.toString('utf8')
  // 去掉控制字符，避免个别响应尾部带填充字节
  return parseJsonLoose<Record<string, unknown>>(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''))
}

/** 上游把字典直接拼进 query，是单引号字面量格式；服务端只认这个写法 */
const SEARCH_SWITCH = "{'song': 1, 'album': 0, 'singer': 0, 'tagSong': 1, 'mvSong': 0, 'bestShow': 1}"

/** 体积字段可能是 '3.5MB' 或纯数字，统一折算成可比较的浮点数 */
function sizeOf(meta: unknown): number {
  const raw = String(
    safeGet(meta, ['size'], '') ||
      safeGet(meta, ['iosSize'], '') ||
      safeGet(meta, ['androidSize'], '') ||
      safeGet(meta, ['isize'], '') ||
      safeGet(meta, ['asize'], '') ||
      '0'
  )
    .replace(/MB$/i, '')
    .trim()
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 0
}

interface RateFormat {
  formatType?: string
  resourceType?: string
}

export class MiguSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'migu',
      label: '咪咕音乐',
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
        text: keyword,
        pageNo: String(Math.floor(count / perPage) + 1),
        pageSize: String(perPage),
        isCopyright: '1',
        sort: '1',
        searchSwitch: SEARCH_SWITCH
      })
      urls.push(SEARCH_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const payload = decodeBody(response.bytes)
    const results = safeGet(payload, ['songResultData', 'result'], []) as Array<Record<string, unknown>>
    if (!Array.isArray(results)) return

    for (const result of results) {
      if (ctx.full) break
      try {
        const song = await this.parseOne(result)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 单曲解析失败不影响本页其它结果（对齐上游 with suppress(Exception)） */
      }
    }
  }

  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const contentId = String(result.contentId ?? '')
    const copyrightId = String(result.copyrightId ?? '')
    if (!contentId || !copyrightId) return null

    const formats = [
      ...((result.rateFormats as RateFormat[]) ?? []),
      ...((result.newRateFormats as RateFormat[]) ?? []),
      ...((result.audioFormats as RateFormat[]) ?? [])
    ]
      .filter((item): item is RateFormat => Boolean(item) && typeof item === 'object')
      .sort((a, b) => sizeOf(b) - sizeOf(a))

    for (const format of formats) {
      const formatType = String(format.formatType ?? '')
      const resourceType = String(format.resourceType ?? '')
      // Z3D 是加密音频格式，拿到也用不了
      if (!formatType || !resourceType || formatType === 'Z3D') continue

      const params = new URLSearchParams({
        contentId,
        copyrightId,
        resourceType,
        netType: '01',
        toneFlag: formatType,
        scene: '',
        lowerQualityContentId: contentId
      })
      const response = await this.http.get(`${LISTEN_URL}?${params.toString()}`, {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', birth: 'h5page', signature: '1' }
      })
      if (!response.ok) continue

      const download = decodeBody(response.bytes)
      const direct = String(safeGet(download, ['data', 'url'], '') ?? '')
      // 拿不到签名地址时退回老接口；再往后就是把 128k 路径改写成 320k
      const fallback = `https://app.pd.nf.migu.cn/MIGUM3.0/v1.0/content/sub/listenSong.do?channel=mx&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=${formatType}&resourceType=${resourceType}&userId=15548614588710179085069&netType=00`
      const candidate = (direct || fallback).replace(/MP3_128_16_Stero/, 'MP3_320_16_Stero')
      if (!/^https?:/i.test(candidate)) continue

      const probed = await probeFirst([candidate], { headers: this.playHeaders() })
      if (!probed) continue

      const durationS = toInt(toFloat(safeGet(download, ['data', 'song', 'duration'], 0)))
      const cover = this.pickCover(result)
      const lyric = await this.fetchLyric(result, download, copyrightId, contentId)
      const singers = (result.singers as Array<{ name?: string }>) ?? []
      const albums = (result.albums as Array<{ name?: string }>) ?? []

      return makeSong(this.key, {
        identifier: contentId,
        songName: result.name ?? result.songName,
        singers: singers
          .filter((item) => item && typeof item === 'object' && item.name)
          .map((item) => item.name)
          .join(', '),
        album:
          result.album ??
          albums
            .filter((item) => item && typeof item === 'object' && item.name)
            .map((item) => item.name)
            .join(', '),
        ext: probed.ext,
        fileSizeBytes: probed.size,
        durationS,
        coverUrl: cover,
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
    return { 'User-Agent': HEADERS['User-Agent'] }
  }

  private pickCover(result: Record<string, unknown>): string {
    const items = (result.imgItems as Array<{ img?: string }>) ?? []
    const last = items.length ? items[items.length - 1]?.img : ''
    const raw = String(last || result.img3 || result.img2 || result.img1 || '')
    if (!raw) return ''
    return /^https?:/i.test(raw) ? raw : `${CDN_BASE}${raw.startsWith('/') ? '' : '/'}${raw}`
  }

  /** 歌词：优先用搜索结果里带的地址，缺失时回落到 listen 接口的 lrcUrl */
  private async fetchLyric(
    result: Record<string, unknown>,
    download: Record<string, unknown>,
    copyrightId: string,
    contentId: string
  ): Promise<string> {
    let lyricUrl = String(result.lyricUrl ?? '')
    if (!lyricUrl) {
      const response = await this.http.get(
        `https://app.c.nf.migu.cn/MIGUM3.0/strategy/pc/listen/v1.0?scene=&netType=01&resourceType=2&copyrightId=${copyrightId}&contentId=${contentId}&toneFlag=PQ`
      )
      if (response.ok) lyricUrl = String(safeGet(parseJsonLoose(response.text), ['data', 'lrcUrl'], '') ?? '')
    }
    if (!lyricUrl && download) lyricUrl = String(safeGet(download, ['data', 'lrcUrl'], '') ?? '')
    if (!lyricUrl || !/^https?:/i.test(lyricUrl)) return ''
    const response = await this.http.get(lyricUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        Referer: 'https://y.migu.cn/'
      }
    })
    if (!response.ok) return ''
    return cleanLrc(response.text)
  }
}
