import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { attrOf, findByTags, followingNodes, parseHtml, selectAll, textOf, type HtmlNode } from '../html'
import { sha1Hex } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * OpenGameArt（游戏音乐与音效）。
 *
 * 整个源只有一个 HTML 搜索页，剩下全靠「进详情页爬附件链接」。搬运时保留
 * 上游三条判断，它们都是踩过坑才有的：
 *
 * 1. 只认 `/sites/default/files/` 下的直链，且排除 `/styles/`——后者是缩略图；
 * 2. `.mp3.ogg` / `.mp3.oga` 是 OGA 自动转码的预览，音质比原文件差，打分要扣 25；
 * 3. 同一条目下可能有多个附件（wav + ogg + zip），按扩展名打分取最高，
 *    绝不能「取第一个」——第一个常常是封面图或预览片段。
 */

const BASE_URL = 'https://opengameart.org'
const MUSIC_TYPE_ID = '12'

const ARCHIVE_EXTS = new Set(['.zip', '.7z', '.rar'])
const LOSSLESS_EXTS = new Set(['.flac', '.wav', '.aiff', '.aif'])
const AUDIO_EXTS = new Set([
  '.flac', '.wav', '.aiff', '.aif', '.opus', '.ogg', '.oga', '.m4a', '.mp3', '.mid', '.midi', '.mod', '.xm', '.it', '.s3m'
])
const BASE_QUALITY_SCORE: Record<string, number> = {
  '.flac': 100,
  '.wav': 95,
  '.aiff': 95,
  '.aif': 95,
  '.opus': 82,
  '.ogg': 78,
  '.oga': 78,
  '.m4a': 74,
  '.mp3': 70,
  '.xm': 45,
  '.it': 43,
  '.mod': 40,
  '.s3m': 40,
  '.mid': 25,
  '.midi': 25,
  '.zip': 10,
  '.7z': 10,
  '.rar': 10
}

const STOP_HEADINGS = new Set(['pages', 'chat with us!', 'active forum topics - (view more)'])
const LINK_BLACKLIST = new Set(['image', 'preview', 'first', 'previous', 'next', 'last', 'log in', 'register', 'read more'])

interface FileItem {
  name: string
  filename: string
  url: string
  ext: string
  isTranscodedPreview: boolean
}

const normalize = (input: string): string => (input ?? '').replace(/\s+/g, ' ').trim()

/** 把整页文本拆成「一行一句」，等价 soup.get_text('\n', strip=True) */
function textLines(root: HtmlNode): string[] {
  const lines: string[] = []
  const walk = (node: HtmlNode): void => {
    if (node.tag === 'script' || node.tag === 'style') return
    if (node.text) {
      for (const piece of node.text.split(/\r?\n/)) {
        const value = normalize(piece)
        if (value) lines.push(value)
      }
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  return lines
}

/** 找到 label 行后面的那一行 */
function valueAfter(lines: string[], label: string): string {
  const target = label.toLowerCase()
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index].toLowerCase() === target) return lines[index + 1] ?? ''
  }
  return ''
}

/** 取 label 行之后的连续块，遇到停止标签就结束 */
function blockAfter(lines: string[], label: string, stopLabels: string[]): string[] {
  const target = label.toLowerCase()
  const stops = new Set(stopLabels.map((item) => item.toLowerCase()))
  const start = lines.findIndex((line) => line.toLowerCase() === target)
  if (start < 0) return []
  const output: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const lower = line.toLowerCase()
    if (lower !== target && stops.has(lower)) break
    if (lower === target || line === '*' || line === 'Image') continue
    output.push(line)
  }
  return Array.from(new Set(output))
}

function isTranscodedPreview(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.mp3.ogg') || lower.endsWith('.mp3.oga') || lower.includes('.mp3.ogg') || lower.includes('.mp3.oga')
}

function qualityScore(file: FileItem): number {
  const base = BASE_QUALITY_SCORE[file.ext] ?? 0
  const penalty = isTranscodedPreview(file.filename) ? 25 : 0
  const mp3Bonus = file.ext === '.mp3' ? 8 : 0
  const losslessBonus = LOSSLESS_EXTS.has(file.ext) ? 20 : 0
  return base - penalty + mp3Bonus + losslessBonus
}

/** 从一条链接构造文件项；不是附件则返回 null */
function buildFileItem(fileUrl: string, linkText: string): FileItem | null {
  let parsed: URL
  try {
    parsed = new URL(fileUrl)
  } catch {
    return null
  }
  if (!parsed.pathname.includes('/sites/default/files/') || parsed.pathname.includes('/styles/')) return null
  const filename = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
  const dot = filename.lastIndexOf('.')
  const ext = dot > 0 ? filename.slice(dot).toLowerCase() : ''
  if (!AUDIO_EXTS.has(ext) && !ARCHIVE_EXTS.has(ext)) return null
  const label = normalize(linkText).replace(/^Image:\s*/i, '')
  return { name: label || filename, filename, url: fileUrl, ext, isTranscodedPreview: isTranscodedPreview(filename) }
}

/** 采集详情页里所有附件链接（<a href> + 正文里裸写的绝对地址） */
function collectFiles(root: HtmlNode, pageUrl: string, rawHtml: string): FileItem[] {
  const seen = new Set<string>()
  const output: FileItem[] = []
  const push = (item: FileItem | null): void => {
    if (!item || seen.has(item.url)) return
    seen.add(item.url)
    output.push(item)
  }
  for (const anchor of selectAll(root, 'a[href]')) {
    const href = attrOf(anchor, 'href')
    if (!href) continue
    push(buildFileItem(new URL(href, pageUrl).toString(), textOf(anchor)))
  }
  const pattern = /https?:\/\/[^"'\s]+?\/sites\/default\/files\/[^"'\s]+/g
  let matched: RegExpExecArray | null
  while ((matched = pattern.exec(rawHtml)) !== null) {
    push(buildFileItem(matched[0], ''))
  }
  return output
}

function chooseBestFile(files: FileItem[]): FileItem | null {
  if (!files.length) return null
  const audios = files.filter((file) => AUDIO_EXTS.has(file.ext))
  const pool = audios.length ? audios : files
  return pool.reduce((best, current) => (qualityScore(current) > qualityScore(best) ? current : best))
}

const HEADERS: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 OGA-Music-Search/1.0' }

export class OpenGameArtSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'opengameart',
      label: 'OpenGameArt',
      pageSize: 3,
      headers: HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    // 站点自身固定 24 条/页，页大小不能小于它，否则 page 参数会重复
    const pageSize = Math.max(perPage, 24)
    while (size > count) {
      const params = new URLSearchParams({
        keys: keyword,
        'field_art_type_tid[0]': MUSIC_TYPE_ID,
        items_per_page: String(pageSize),
        page: String(Math.floor(count / pageSize))
      })
      urls.push(`${BASE_URL}/art-search-advanced?${params.toString()}`)
      count += pageSize
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const document = parseHtml(response.text)
    const heading = findByTags(document, ['h1', 'h2', 'h3']).find(
      (node) => normalize(textOf(node)).toLowerCase() === 'search art'
    )
    if (!heading) return

    const seen = new Set<string>()
    for (const node of followingNodes(heading)) {
      if (ctx.full) break
      if (['h1', 'h2', 'h3'].includes(node.tag) && STOP_HEADINGS.has(normalize(textOf(node)).toLowerCase())) break
      if (node.tag !== 'a') continue
      const href = attrOf(node, 'href')
      const title = normalize(textOf(node))
      if (!href || !title || LINK_BLACKLIST.has(title.toLowerCase())) continue
      let parsed: URL
      try {
        parsed = new URL(href, BASE_URL)
      } catch {
        continue
      }
      if (parsed.hostname !== 'opengameart.org' || !parsed.pathname.startsWith('/content/') || parsed.pathname === '/content/faq') {
        continue
      }
      const pageUrl = BASE_URL + parsed.pathname
      if (seen.has(pageUrl)) continue
      seen.add(pageUrl)
      try {
        const song = await this.parseOne(title, pageUrl)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 跳过该条目 */
      }
    }
  }

  private async parseOne(songName: string, pageUrl: string): Promise<SongInfo | null> {
    const response = await this.http.get(pageUrl)
    if (!response.ok) return null
    const document = parseHtml(response.text)
    const lines = textLines(document)
    const files = collectFiles(document, pageUrl, response.text)
    const best = chooseBestFile(files)
    if (!best) return null

    const probed = await probeFirst([best.url], { headers: HEADERS })
    if (!probed) return null

    const collections = blockAfter(lines, 'Collections:', [
      'Favorites:',
      'Preview:',
      'File(s):',
      'Tags:',
      'Copyright/Attribution Notice:',
      'Log in or register to post comments'
    ])
    const parsedUrl = new URL(probed.url)
    return makeSong(this.key, {
      // 与上游一致：用「域名 + 路径」的 **SHA1** 做稳定 id（上游用的是 sha1，
      // 换成 md5 会让同一首歌在迁移前后得到不同的 id，影响本地库去重）
      identifier: sha1Hex(`${parsedUrl.host}${parsedUrl.pathname}`).slice(0, 12),
      songName,
      singers: valueAfter(lines, 'Author:'),
      album: collections[0] ?? '',
      ext: probed.ext,
      fileSizeBytes: probed.size,
      durationS: 0,
      coverUrl: '',
      downloadUrl: probed.url,
      headers: HEADERS,
      protocol: probed.protocol,
      raw: { pageUrl, file: best }
    })
  }
}
