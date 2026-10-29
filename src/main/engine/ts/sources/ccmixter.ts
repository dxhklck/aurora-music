import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from './../http'
import { safeGet } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * ccMixter（CC 授权混音素材库）。
 *
 * 搜索返回的是 XSPF（XML）而不是 JSON，且**不包含时长**——时长要再用
 * `f=json&dataview=info` 批量查一次 `files[].file_format_info.ps`（形如 "3:45"）。
 * 少这一次请求，列表页所有曲目的时长都会是 0。
 */

const API_URL = 'https://ccmixter.org/api/query?'

const HEADERS: Record<string, string> = {
  accept: 'application/xspf+xml, application/xml, text/xml, */*',
  referer: 'https://ccmixter.org/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
}

interface XspfTrack {
  download_url: string
  title: string
  creator: string
  album: string
  duration: string
  cover_url: string
  identifier: string
  annotation: string
}

/** 取某个 tag 的文本；XSPF 带命名空间前缀，按「后缀匹配」的方式找 */
function tagText(block: string, tag: string): string {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'i')
  const matched = pattern.exec(block)
  if (!matched) return ''
  return matched[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .trim()
}

function tagTexts(block: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`, 'gi')
  const output: string[] = []
  let matched: RegExpExecArray | null
  while ((matched = pattern.exec(block)) !== null) {
    output.push(
      matched[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]*>/g, '')
        .trim()
    )
  }
  return output
}

/** 解析 XSPF 文档里的所有 <track> */
function parseXspf(text: string): XspfTrack[] {
  const tracks: XspfTrack[] = []
  const pattern = /<(?:[\w.-]+:)?track\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?track>/gi
  let matched: RegExpExecArray | null
  while ((matched = pattern.exec(text)) !== null) {
    const block = matched[1]
    const locations = tagTexts(block, 'location').filter((item) => /^https?:/i.test(item))
    if (!locations.length) continue
    tracks.push({
      download_url: locations[0],
      title: tagText(block, 'title'),
      creator: tagText(block, 'creator'),
      album: tagText(block, 'album'),
      duration: tagText(block, 'duration'),
      cover_url: tagText(block, 'image'),
      identifier: tagText(block, 'identifier') || locations[0],
      annotation: tagText(block, 'annotation')
    })
  }
  return tracks
}

/**
 * "3:45" / "1:02:03" → 秒。
 *
 * 必须要求带冒号：XSPF 里的 `<duration>` 是毫秒数（形如 `6345708`），
 * 上游对这种情况一律按「未知」记为 0，直接解析会把毫秒当成秒，
 * 列表里出现 70 万秒的曲目。
 */
function durationFromClock(input: string): number {
  if (!input || !/^\d+(:\d+){1,2}$/.test(input.trim())) return 0
  const parts = input.split(':').map((item) => Number.parseFloat(item.trim()) || 0)
  if (!parts.length) return 0
  return parts.reduce((total, part, index) => total + part * 60 ** (parts.length - 1 - index), 0)
}

export class CcmixterSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'ccmixter',
      label: 'ccMixter',
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
        f: 'xspf',
        t: 'search_uploads',
        search_type: 'any',
        search: keyword,
        limit: String(perPage),
        offset: String(count)
      })
      urls.push(API_URL + params.toString())
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const tracks = await this.withDurations(parseXspf(response.text))

    for (const track of tracks) {
      if (ctx.full) break
      try {
        const probed = await probeFirst([track.download_url], { headers: { referer: HEADERS.referer } })
        if (!probed) continue
        ctx.push(
          makeSong(this.key, {
            identifier: track.identifier,
            songName: track.title,
            singers: track.creator,
            album: track.album,
            ext: probed.ext,
            fileSizeBytes: probed.size,
            durationS: Math.trunc(durationFromClock(track.duration)),
            coverUrl: track.cover_url,
            downloadUrl: probed.url,
            headers: { referer: HEADERS.referer },
            protocol: probed.protocol,
            raw: { search: track }
          })
        )
      } catch {
        /* 跳过单曲 */
      }
    }
  }

  /** 批量补齐时长：一次请求问清本页所有 id 的文件信息 */
  private async withDurations(tracks: XspfTrack[]): Promise<XspfTrack[]> {
    if (!tracks.length) return tracks
    const ids = tracks.map((track) => track.identifier).join(',')
    const infoResponse = await this.http.get(
      `https://ccmixter.org/api/query?${new URLSearchParams({
        f: 'json',
        dataview: 'info',
        ids
      }).toString()}`
    )
    if (!infoResponse.ok) return tracks
    const parsed = parseJsonLoose<unknown>(infoResponse.text)
    if (!Array.isArray(parsed)) return tracks

    const uploads = new Map<string, Record<string, unknown>>()
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const id = String(record.upload_id ?? '')
      if (id) uploads.set(id, record)
    }
    for (const track of tracks) {
      const files = (safeGet(uploads.get(track.identifier), ['files'], []) ?? []) as Array<Record<string, unknown>>
      const clock = files
        .map((file) => String(safeGet(file, ['file_format_info', 'ps'], '') ?? ''))
        .find((value) => Boolean(value))
      if (clock) track.duration = clock
    }
    return tracks
  }
}
