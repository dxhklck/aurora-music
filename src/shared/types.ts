/**
 * 跨进程共享的领域模型。
 * 主进程（音源层/数据层）与渲染进程（播放层/UI 层）都只依赖这里的类型，
 * 保证任何平台的差异都被收敛在 Provider 内部，不会泄漏到 UI。
 */

export type PlatformId = string

/** 音质档位：各平台自行映射到自己的码率/格式参数 */
export type Quality = 'standard' | 'high' | 'lossless'

/** 播放模式 */
export type PlayMode = 'order' | 'loop' | 'single' | 'shuffle'

/** 统一歌曲模型（对应 musicdl 里的 SongInfo） */
export interface Song {
  /** 平台内唯一 ID，同一平台内用于去重 */
  id: string
  platform: PlatformId
  name: string
  artists: string[]
  album: string
  /** 已代理的封面地址（muse:// 协议），或 null */
  coverUrl: string | null
  /** 毫秒 */
  duration: number
  /** 文件大小（字节）；平台不返回时为空，UI 显示 — */
  fileSize?: number
  /** 原始码率/格式描述，例如 "320k mp3" */
  qualityLabel?: string
  /** 平台侧是否可播放（部分平台会明确返回付费/无版权） */
  streamable?: boolean
  /** 搜索结果即可判定为 VIP/付费曲目时为 true（UI 显示 VIP 角标） */
  vip?: boolean
  /** 搜索结果即可知的最高音质档；平台不返回时留空 */
  qualityMax?: 'lossless' | 'high' | 'standard'
  /** 平台原始附加字段（如 QQ 的 albumMid），只在主进程/播放解析时使用 */
  extra?: Record<string, string | number>
}

export interface SearchPage {
  items: Song[]
  total: number
  page: number
  hasMore: boolean
  /** 服务端耗时（ms），用于前端展示 */
  cost?: number
}

export interface ChartSummary {
  id: string
  platform: PlatformId
  name: string
  subtitle?: string
  coverUrl: string | null
  trackCount?: number
  updateFrequency?: string
}

export interface StreamInfo {
  /** 可直接喂给 <audio> 的地址（muse:// 代理或本地协议） */
  url: string
  quality: Quality
  label: string
  format: string
  /** 时间戳（ms），过期后需要重新解析 */
  expiresAt: number
  /**
   * 下载用的直连地址。
   * `url` 是给渲染进程播放的 muse:// 代理地址，Node 侧 fetch 不认识这个协议，
   * 所以下载必须走这里；为空时退化为 url（本地文件场景）。
   */
  directUrl?: string
  /** 下载时必须补的请求头（Referer / UA / Cookie），由音源层给出 */
  headers?: Record<string, string>
  /** 传输协议：HLS 需要引擎合并分片，不能按字节流直接落盘 */
  protocol?: 'http' | 'hls'
}

/** 逐字时间轴上的一个片段（一个字或一个词） */
export interface LyricWord {
  /** 起始时间，毫秒（绝对时间，与 LyricLine.time 同一基准） */
  time: number
  /** 持续时间，毫秒 */
  duration: number
  text: string
}

export interface LyricLine {
  /** 毫秒 */
  time: number
  text: string
  translation: string
  /** 逐字时间轴；缺失时降级为整行高亮 */
  words?: LyricWord[]
  /** 行结束时间（毫秒），仅逐字歌词有 */
  endTime?: number
}

export interface Lyric {
  lines: LyricLine[]
  /** 全局偏移，毫秒（正数=歌词提前） */
  offset: number
  translated: boolean
  source: string
  /** 是否包含逐字时间轴（决定 UI 用字粒度渐变还是整行高亮） */
  wordByWord?: boolean
  /** 无时间轴的纯文本歌词，lines 为空时降级展示 */
  plain?: string
}

export interface ProviderCapabilities {
  search: boolean
  charts: boolean
  stream: boolean
  lyric: boolean
}

export interface ProviderInfo {
  id: PlatformId
  name: string
  /** 两字母标识，用于列表角标 */
  short: string
  color: string
  /** 主题渐变，用于背景/封面占位 */
  gradient: [string, string]
  capabilities: ProviderCapabilities
  /** 首页/切换器里的一句话说明 */
  description: string
  /** 已知限制提示，例如"部分歌曲需会员" */
  note?: string
  /** 内部音源（如本地音乐）：不进音源切换列表，但保留播放等底层能力 */
  hidden?: boolean
}

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'done'
  | 'error'
  | 'canceled'


export interface DownloadTask {
  id: string
  song: Song
  status: DownloadStatus
  /** 0-1；未知总大小时为 -1 */
  progress: number
  received: number
  total: number
  /** 字节/秒 */
  speed: number
  /** 已尝试次数（含首次） */
  attempt: number
  error?: string
  filePath?: string
  createdAt: number
  finishedAt?: number
  /** 实际使用的传输方式，用于在下载页区分展示 */
  transport?: 'http' | 'hls' | 'local'
  /** 是否已写入音频标签 */
  tagged?: boolean
}


export interface LibraryTrack {
  id: string
  song: Song
  filePath: string
  fileName: string
  size: number
  ext: string
  qualityLabel?: string
  lyricPath?: string
  metaPath?: string
  downloadedAt: number
}

/** 内置收藏夹的固定 id：不可重命名、不可删除 */
export const FAVORITES_ID = 'favorites'

/** 收藏 / 自建歌单，条目直接内联 Song，切换音源后仍可重新解析播放地址 */
export interface Playlist {
  id: string
  name: string
  /** 内置收藏夹 */
  builtin?: boolean
  songs: Song[]
  createdAt: number
  updatedAt: number
}

export interface AppSettings {
  platform: PlatformId
  quality: Quality
  volume: number
  playMode: PlayMode
  downloadDir: string
  /** 额外导入的本地音乐目录（与下载目录一起扫描进本地库） */
  musicDirs: string[]
  searchLimit: number
  /** 播放失败时自动到其它平台找同名歌曲 */
  autoSwitchSource: boolean
  /** 桌面歌词是否锁定（锁定 = 鼠标穿透，不挡桌面操作） */
  desktopLyricLocked: boolean
  /** 桌面歌词形态：mini 单行迷你条 / full 大字多行 */
  desktopLyricMode: 'mini' | 'full'
  /** 播放页样式：vinyl 黑胶经典 / lyrics 歌词大屏 / cover 封面沉浸 */
  nowPlayingStyle: 'vinyl' | 'lyrics' | 'cover'
  /** 播放页炫彩皮肤：aurora 默认 / neon 流光 / ocean 碧海 / sunset 熔金 / galaxy 星河 */
  playerTheme: 'aurora' | 'neon' | 'ocean' | 'sunset' | 'galaxy'
  /** 界面主题：dark 深色 / light 浅色（播放页始终深色沉浸式） */
  themeMode: ThemeMode
  /** 同时下载的任务数（1-4） */
  downloadConcurrency: number
  /** 单个任务的最大尝试次数（1-5） */
  downloadRetries: number
  /** 下载完成后是否写入音频标签（ID3 / Vorbis / MP4） */
  writeTags: boolean
  /** 启用 musicdl 引擎音源 */
  engineEnabled: boolean
  /**
   * 五段均衡器。gain 单位为 dB，固定 5 段（60/230/910/3600/14000 Hz），范围 ±12。
   * 关闭时滤波器仍在链路里，只是增益归零——拆链重接极易踩到静音。
   */
  equalizer: { enabled: boolean; gains: number[] }
  /** 点关闭按钮时最小化到系统托盘（关掉 = 隐藏后台播放）；为 false 时关闭即退出。托盘不可用时始终退出 */
  closeToTray: boolean
  /** QQ 音乐登录 Cookie（浏览器登录后复制粘贴；解锁逐字歌词与播放权限） */
  qqCookie: string
  /** 网易云音乐登录 Cookie（解锁无损音质与 VIP 曲目） */
  neteaseCookie: string
  /** 网易云登录账号信息（手机号登录成功后写入；粘贴 Cookie 时为 null） */
  neteaseAccount: NeteaseAccountInfo | null
  /** 迷你播放器模式：主窗口收缩为置顶小浮窗（封面 + 控制 + 细进度条） */
  miniMode: boolean
  /** 两种窗口形态各自的位置尺寸，切换时互写回存 */
  windowBounds: { normal?: WinRect; mini?: WinRect }
}

/** 界面主题两档 */
export type ThemeMode = 'dark' | 'light'

/** 窗口矩形（屏幕坐标） */
export interface WinRect {
  x: number
  y: number
  width: number
  height: number}


export interface ResolvedTrack {
  song: Song
  stream: StreamInfo
  /** 若不是原平台，返回被替换的平台 id */
  switchedFrom?: PlatformId
  /** 换源后的提示文案 */
  notice?: string
}

export interface LyricWindowState {
  playing: boolean
  lines: LyricLine[]
  /** 歌词全局偏移（ms），子窗口据此做本地插值 */
  offset: number
  index: number
  /** 主窗口当前的播放时间（ms） */
  time: number
  /** 发送时刻（ms，Date.now），用于子窗口做平滑插值 */
  sentAt: number
  title: string
  artist: string
  locked: boolean
  /** 主窗口强调色：桌面歌词窗口据此实时联动（旧推送可缺省） */
  accent?: string
  accent2?: string
}

/* ---------------- 扫码登录 ---------------- */

export type QrLoginPlatform = 'qq' | 'netease'

/**
 * pending 等待扫码 / scanned 已扫待确认 / success 登录成功 /
 * expired 二维码过期 / error 失败 / idle 无会话
 */
export type QrLoginPhase = 'idle' | 'pending' | 'scanned' | 'success' | 'expired' | 'error'

export interface QrLoginState {
  platform: QrLoginPlatform
  phase: QrLoginPhase
  /** 二维码图片（dataURL，PNG） */
  qrImage: string
  message: string
  /** 过期时刻（ms，Date.now） */
  expiresAt: number
}

/* ---------------- 手机号登录（网易云） ---------------- */

/** 登录成功后的账号摘要（设置页账号卡片展示用） */
export interface NeteaseAccountInfo {
  userId: number
  nickname: string
  avatarUrl: string
  /** 0 = 普通账号，>0 = VIP（不同档位） */
  vipType: number
}

export interface CellphoneLoginArgs {
  phone: string
  /** 国际区号，默认 86 */
  countrycode?: string
  /** 验证码登录（与 password 二选一） */
  captcha?: string
  /** 密码登录（明文传输到本进程后 md5，与 captcha 二选一） */
  password?: string
}

export interface CellphoneLoginResult {
  ok: boolean
  account?: NeteaseAccountInfo
  message?: string
}

/** 迷你窗口音量气泡的状态（主窗口 ↔ 气泡窗口双向同步） */
export interface MiniVolumeState {
  volume: number
  muted: boolean
  /** 当前音源的强调色：气泡是独立窗口，拿不到主窗口运行时设置的 CSS 变量，必须显式传 */
  accent: string
  accent2: string
  /** 主题：气泡窗口默认只有深色变量，浅色主题需要显式切 data-theme */
  theme: 'dark' | 'light'
  /**
   * 气泡在迷你条的上方还是下方（上方放不下时会翻到下方）。
   * 三角要跟着翻转，否则会指向远离迷你条的一侧。
   */
  placement?: 'above' | 'below'
}
