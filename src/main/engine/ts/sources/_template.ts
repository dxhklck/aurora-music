/**
 * 新增音源的模板 —— **复制这个文件**开始写，不要直接改它。
 *
 * 完整步骤见 `docs/adding-a-source.md`。这里只讲代码里看不出来的部分。
 *
 * ────────────────────────────────────────────────────────────────
 * 你要实现的东西只有两个方法
 * ────────────────────────────────────────────────────────────────
 *
 *   buildUrls(keyword, perPage, size)  返回一组分页 URL
 *   parsePage(url, ctx)                抓一个 URL，把曲目 push 进 ctx
 *
 * 别的东西 BaseSource 全包了：分页并发、按页限流、跨页去重、逐条流式回调、
 * 单页异常隔离、超时与重试。所以你**不要**自己写 for 循环翻页，也不要自己
 * 维护去重集合——把 size 拆成若干页 URL 就行。
 *
 * ────────────────────────────────────────────────────────────────
 * 四个必须踩对的点（踩错的表现都很难查）
 * ────────────────────────────────────────────────────────────────
 *
 * 1. `ctx.limit` 是**本页**的上限，不是总数。parsePage 里每轮循环都要先看
 *    `ctx.full`，收满了立刻 break——否则一页塞 30 条会让整个搜索退化成串行。
 *
 * 2. `pageSize` 不是越大越好。它决定「几个请求并发」与「每个请求要几条」的乘积。
 *    酷狗每页 2 条拆 5 页并发（5 个请求同时打），咪咕每页 3 条；
 *    实测咪咕每页 2 条会从 6s 退化到 50s+。新源先按 3 试，慢就调小。
 *
 * 3. 播放地址必须**探测过**才算数。很多平台的搜索接口返回的地址是占位符或
 *    需要跟随 302 才有真实文件，`probeFirst` 会发一次 Range 请求确认可播放并
 *    推断扩展名/体积/HLS。不探测的后果：列表里全是条目，点播放全失败。
 *
 * 4. 时长单位各平台不一样：秒 / 毫秒 / "3:45" 字符串都有。填错不会报错，
 *    只会出现「70 万秒」的曲目，并让「同曲不同音质」的比对全失效。
 *
 * ────────────────────────────────────────────────────────────────
 * 验证方式（写完必须做）
 * ────────────────────────────────────────────────────────────────
 *
 *   npm run engine:test            # 解析逻辑单测（如果加了 fixture）
 *   npm run dev → 左侧切到新音源 → 搜一个常见关键词
 *
 * 看三件事：能否出结果、时长对不对、点播放是否真的出声。
 * 「能搜到但播不了」是最常见的半成品状态。
 */
import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { safeGet } from '../text'
import type { SearchContext } from '../types'

/** 该音源的搜索接口。注意用 https，http 会被平台的 302 绕一圈更慢 */
const API_URL = 'https://example.com/api/search'

/**
 * 请求头。至少要有 referer：相当一部分平台校验来源，
 * 不带 referer 会返回 403 或一段「请从正常入口访问」的 HTML。
 */
const HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  referer: 'https://example.com/'
}

/** 接口返回的单条结构（照抄真实响应，只留用得上的字段） */
interface ApiRow {
  id: string | number
  name: string
  artist: string
  album?: string
  /** 毫秒。若接口给的是秒或 "3:45"，在这里统一换算成秒 */
  durationMs?: number
  cover?: string
  /** 播放地址；可能是占位符，必须探测 */
  playUrl?: string
}

/**
 * 把响应转成行数组。
 *
 * 用 `parseJsonLoose` 而不是 `JSON.parse`：不少平台返回的 JSON 带 BOM、
 * 前后有回调包装（`cb({...})`）、或者 HTML 转义过的引号，直接 parse 会抛错。
 */
function parseRows(text: string): ApiRow[] {
  const json = parseJsonLoose<unknown>(text)
  const list = safeGet(json, ['data', 'list'], [])
  if (!Array.isArray(list)) return []
  const rows: ApiRow[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = String(record.id ?? '')
    const name = String(record.name ?? '')
    if (!id || !name) continue
    rows.push({
      id,
      name,
      artist: String(record.artist ?? ''),
      album: String(record.album ?? ''),
      durationMs: Number(record.duration ?? 0) || 0,
      cover: String(record.cover ?? ''),
      playUrl: String(record.playUrl ?? '')
    })
  }
  return rows
}

export class TemplateSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'template', // 必须与 sources/index.ts 里注册的 key 一致
      label: '模板音源', // 侧栏显示的名字
      pageSize: 3,
      headers: HEADERS,
      ...config
    })
  }

  /**
   * 把「要 N 条」拆成若干页 URL。
   *
   * 常见两种分页协议：
   * - offset/limit：`offset=0&limit=3`、`offset=3&limit=3`（下面这种）
   * - page/pageSize：`page=1&size=3`、`page=2&size=3`
   *
   * 注意别超过平台的上限：有的接口 offset 最大 100，超了返回空数组，
   * 表现为「搜到一半突然没结果」。
   */
  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    for (let offset = 0; offset < size; offset += perPage) {
      const params = new URLSearchParams({
        q: keyword,
        limit: String(perPage),
        offset: String(offset)
      })
      urls.push(`${API_URL}?${params.toString()}`)
    }
    return urls
  }

  /** 抓一页并 push。异常不用自己 try/catch 包整个方法，BaseSource 会兜住单页失败 */
  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return

    for (const row of parseRows(response.text)) {
      if (ctx.full) break // 收满就停，剩下的留给下一个并发页

      const probed = await probeFirst([row.playUrl], { headers: { referer: HEADERS.referer } })
      if (!probed) continue // 探测不到就跳过：宁可少一条，也不要塞一条播不了的

      try {
        ctx.push(
          makeSong(this.key, {
            identifier: row.id,
            songName: row.name,
            singers: row.artist,
            album: row.album ?? '',
            ext: probed.ext,
            fileSizeBytes: probed.size,
            durationS: Math.round((row.durationMs ?? 0) / 1000), // 毫秒 → 秒
            coverUrl: row.cover,
            downloadUrl: probed.url,
            headers: { referer: HEADERS.referer }, // 播放器下载时要带上同样的头
            protocol: probed.protocol, // probeFirst 已经判断是不是 HLS
            raw: { row } // 排查用，不参与对外协议
          })
        )
      } catch {
        /* 单曲字段异常：跳过，不影响本页其它结果 */
      }
    }
  }
}
