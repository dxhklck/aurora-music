import { BaseSource, makeSong, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { attrOf, parseHtml, selectAll, selectOne, textOf } from '../html'
import { cleanLrc, safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * 街声（StreetVoice）。
 *
 * 它是全引擎里唯一纯 HLS 的源：搜索结果页给出 `song_id`，再调两个接口拿
 * m3u8 清单。这里不做全量探测（m3u8 有几百个分片，探测代价高），只做一次
 * 轻量 GET 确认清单可访问，扩展名固定为 m3u8。
 */

const SEARCH_URL = 'https://www.streetvoice.cn/search/?'
const API_BASE = 'https://www.streetvoice.cn/api/v5/song'

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  Referer: 'https://www.streetvoice.cn/',
  'x-requested-with': 'XMLHttpRequest'
}

/**
 * 上游用 `Path(path).suffixes[-2]` 从「名字.码率.m3u8」里取码率段。
 * 单后缀路径会直接越界抛错，这里退化为 m3u8，语义上更稳。
 */
function extFromHlsPath(url: string): string {
  try {
    const path = new URL(url).pathname
    const name = path.split('/').filter(Boolean).pop() ?? ''
    const parts = name.split('.')
    if (parts.length >= 3) return parts[parts.length - 2].toLowerCase()
    return 'm3u8'
  } catch {
    return 'm3u8'
  }
}

export class StreetVoiceSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'streetvoice',
      label: '街声',
      pageSize: 3,
      headers: HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    // 上游把每页条数硬压到 10 以内，这里用三者最小值保持一致的请求规模
    const pageSize = Math.min(10, perPage)
    while (size > count) {
      const params = new URLSearchParams({
        page: String(Math.floor(count / pageSize) + 1),
        q: keyword,
        type: 'song',
        _pjax: '#pjax-container'
      })
      urls.push(SEARCH_URL + params.toString())
      count += pageSize
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const document = parseHtml(response.text)
    const items = selectAll(document, 'ul.list-group-song li.work-item.item_box')

    for (const item of items) {
      if (ctx.full) break
      try {
        const playButton = selectOne(item, 'button.js-search')
        const songId = attrOf(playButton, 'data-id')
        if (!songId) continue
        const song = await this.parseOne(songId)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 跳过单条 */
      }
    }
  }

  private async parseOne(songId: string): Promise<SongInfo | null> {
    const detailResponse = await this.http.get(`${API_BASE}/${songId}/?_=${Date.now()}`, {
      headers: { 'x-requested-with': 'XMLHttpRequest' }
    })
    if (!detailResponse.ok) return null
    const detail = parseJsonLoose<Record<string, unknown>>(detailResponse.text)

    const hlsResponse = await this.http.post(`${API_BASE}/${songId}/hls/file/`, {
      headers: { 'x-requested-with': 'XMLHttpRequest' }
    })
    if (!hlsResponse.ok) return null
    const hls = parseJsonLoose<Record<string, unknown>>(hlsResponse.text)

    const file = String(hls.file ?? '')
    if (!file || !/^https?:/i.test(file)) return null

    // 确认清单真的能取到：HLS 源没有别的轻量校验手段
    const check = await this.http.get(file, { maxBytes: 2048, retries: 1 })
    if (!check.ok) return null

    const durationS = toInt(toFloat(detail.length ?? 0))
    return makeSong(this.key, {
      identifier: songId,
      songName: detail.name,
      singers: safeGet(detail, ['user', 'profile', 'nickname'], null),
      album: safeGet(detail, ['album', 'name'], null),
      ext: extFromHlsPath(file),
      // HLS 分片无法预知总体积，按 0 处理（上游塞的是字符串 'HLS'，到取址时反而会崩）
      fileSizeBytes: 0,
      durationS,
      coverUrl: detail.image,
      downloadUrl: file,
      headers: { Referer: HEADERS.Referer, 'User-Agent': HEADERS['User-Agent'] },
      protocol: 'HLS',
      lyric: cleanLrc(String(detail.lyrics ?? '')),
      raw: { detail, hls }
    })
  }
}
