/**
 * TS 引擎的领域类型。
 *
 * 上游字段与本类型的映射是刻意保持的：语义一一对应，
 * 但把上游用「字符串 'NULL'」表达缺失的写法换成了显式的空串 / 0，
 * 归一化在 text.ts 的 cleanText 里完成，不散落到各个音源。
 */

/** 一个音源返回的单曲（已解析出可播放地址） */
export interface SongInfo {
  /** 音源键（kugou / migu …），对应 SOURCES 的 key */
  source: string
  /** 源内稳定标识；缺省时由「歌名|歌手|专辑」的 md5 兜底 */
  identifier: string
  songName: string
  singers: string
  album: string
  /** 音频扩展名，小写、无点。HLS 流为 m3u8 */
  ext: string
  /** 字节数；HLS 无法预知时为 0 */
  fileSizeBytes: number
  /** 音频码率（bps） */
  bitrate: number
  codec: string
  /** 时长（秒） */
  durationS: number
  coverUrl: string
  downloadUrl: string
  /** 播放地址必须携带的请求头（Referer / UA 等） */
  headers: Record<string, string>
  cookies: Record<string, string>
  /** HTTP 直链或 HLS 分片清单 */
  protocol: 'HTTP' | 'HLS'
  /** 歌词原文（LRC 文本），可能为空 */
  lyric: string
  /** 音源原始响应，仅用于排查；不参与对外协议 */
  raw?: Record<string, unknown>
}

/** 探测结果：地址是否真的可播、推断出的扩展名与体积 */
export interface ProbeResult {
  ok: boolean
  ext: string
  fileSizeBytes: number
  /** 跟随重定向后的最终地址 */
  downloadUrl: string
  statusCode: number
  contentType: string
  method: string
  reason: string[]
}

export interface SourceMeta {
  key: string
  label: string
  /** 每页条数：决定分页并行粒度，按平台单独标定 */
  pageSize: number
}

/** 单页解析上下文 */
export interface SearchContext {
  keyword: string
  /** 本页最多产出多少条（分页请求量 + 严格截断） */
  limit: number
  /** 发现一条就立即回调，用于流式搜索 */
  onItem?: (song: SongInfo) => void
  /** 收下一条结果；超过 limit 后自动丢弃，等价上游的 strict_limit 截断 */
  push: (song: SongInfo) => void
  /** 本页是否已收满，子类据此提前跳出循环 */
  readonly full: boolean
}

export interface SearchOptions {
  keyword: string
  /** 期望召回总数（等价 search_size_per_source） */
  size: number
  onItem?: (song: SongInfo) => void
  signal?: AbortSignal
}

export interface ResolveQuery {
  source: string
  token?: string
  name?: string
  artists?: string
  durationMs?: number
  keyword?: string
  size?: number
}

/** 音源适配器的统一契约 */
export interface SourceClient {
  readonly key: string
  readonly label: string
  readonly pageSize: number
  search(opts: SearchOptions): Promise<SongInfo[]>
}
