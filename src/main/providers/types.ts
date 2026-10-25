import type {
  ChartSummary,
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'

export type ProviderErrorCode = 'network' | 'blocked' | 'unsupported' | 'parse' | 'empty'

export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly provider: string

  constructor(code: ProviderErrorCode, message: string, provider = '') {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.provider = provider
  }
}

export interface SearchArgs {
  keyword: string
  page: number
  limit: number
  /**
   * 增量结果回调。只有「取地址很慢」的音源（musicdl 引擎）会用到：
   * 每解析出一首就回调一次，UI 可以先渲染再等收尾。
   * 原生音源一次请求就返回，直接忽略即可。
   */
  onPartial?: (items: Song[]) => void
}

/**
 * 统一音源适配器接口 —— 对应需求 1：新增平台只需实现该接口并注册。
 * 所有平台差异（签名、字段命名、音质档位）都在实现内部消化。
 */
export interface MusicProvider {
  readonly info: ProviderInfo

  search(args: SearchArgs): Promise<SearchPage>

  /** 榜单目录；不支持时返回空数组 */
  charts(): Promise<ChartSummary[]>

  /** 榜单详情；不支持时抛 ProviderError('unsupported') */
  chartDetail(args: { id: string; page: number; limit: number }): Promise<SearchPage>

  /** 解析可播放地址（内部完成多档音质回退 + 可用性探测） */
  resolveStream(song: Song, quality: Quality): Promise<StreamInfo>

  /** 抓取歌词；无歌词返回 null，由 LyricResolver 走公共歌词库兜底 */
  lyric(song: Song): Promise<Lyric | null>
}
