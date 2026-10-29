/** 渲染进程专用：由主进程注入的 API 类型（与 preload 暴露的对象一一对应） */
import type {
  AppSettings,
  CellphoneLoginArgs,
  CellphoneLoginResult,
  ChartSummary,
  DownloadTask,
  LibraryTrack,
  Lyric,
  MiniVolumeState,
  Playlist,
  QrLoginPlatform,
  QrLoginState,
  ProviderInfo,
  ResolvedTrack,
  SearchPage,
  Song
} from './types'

/** 单个音源在本次运行期间的请求成败统计 */
export interface EngineSourceHealthView {
  key: string
  label: string
  ok: number
  fail: number
  /** 最近一次失败原因；成功后清空 */
  lastError: string
  /** 最近一次请求时间戳，0 = 本次会话还没用过 */
  lastAt: number
}

/** 引擎运行时状态（主进程 → 设置页） */
export interface EngineStatusView {
  ready: boolean
  runtime: { command: string; label: string; version?: number | string; sources?: number } | null
  error: string
  health: EngineSourceHealthView[]
}

export interface SearchArgs {
  platform: string
  keyword: string
  page?: number
  limit?: number
  /**
   * 开启增量结果推送。传入一个本次搜索唯一的 token，
   * 主进程会通过 `onSearchPartial` 陆续把已解析好的歌曲推回来。
   */
  streamId?: string
}

export interface ChartDetailArgs {
  platform: string
  id: string
  page?: number
  limit?: number
}

export interface AuroraApi {
  /** 运行平台：darwin / win32 / linux，用于标题栏与快捷键适配 */
  platform: string
  providers(): Promise<ProviderInfo[]>
  search(args: SearchArgs): Promise<SearchPage>
  /** 订阅增量搜索结果；返回取消订阅函数 */
  onSearchPartial(cb: (payload: { streamId: string; items: Song[] }) => void): () => void
  charts(platform: string): Promise<ChartSummary[]>
  chartDetail(args: ChartDetailArgs): Promise<SearchPage>
  lyric(song: Song): Promise<Lyric | null>
  resolveTrack(args: { song: Song; autoSwitch: boolean; forceSwitch?: boolean }): Promise<ResolvedTrack>
  /** 封面补全：当 song.coverUrl 为空时，跨平台按歌名+歌手搜封面 */
  coverResolve(song: Song): Promise<string | null>

  enqueueDownload(song: Song): Promise<DownloadTask>
  enqueueDownloads(songs: Song[]): Promise<DownloadTask[]>
  listDownloads(): Promise<DownloadTask[]>
  cancelDownload(id: string): Promise<void>
  retryDownload(id: string): Promise<void>
  retryFailedDownloads(): Promise<number>
  removeDownload(id: string): Promise<void>
  clearDownloads(): Promise<void>
  openDownload(id: string): Promise<void>
  revealDownload(id: string): Promise<void>
  downloadDir(): Promise<string>
  chooseDownloadDir(): Promise<string>

  engineStatus(): Promise<EngineStatusView>
  engineRestart(): Promise<EngineStatusView>

  listLibrary(): Promise<LibraryTrack[]>
  removeLibrary(id: string): Promise<void>
  refreshLibrary(): Promise<LibraryTrack[]>
  revealLibrary(id: string): Promise<void>
  /** 导入本地音乐目录：对话框选目录，追加到 musicDirs 并立即扫描，返回当前目录列表 */
  importMusicDir(): Promise<string[]>
  /** 从扫描列表移除目录（不删磁盘文件，也不删已有索引） */
  removeMusicDir(dir: string): Promise<string[]>
  listMusicDirs(): Promise<string[]>

  listPlaylists(): Promise<Playlist[]>
  createPlaylist(name: string, songs?: Song[]): Promise<Playlist[]>
  renamePlaylist(id: string, name: string): Promise<Playlist[]>
  removePlaylist(id: string): Promise<Playlist[]>
  addPlaylistSongs(id: string, songs: Song[]): Promise<Playlist[]>
  removePlaylistSong(id: string, platform: string, songId: string): Promise<Playlist[]>
  toggleFavorite(song: Song): Promise<{ list: Playlist[]; favorited: boolean }>

  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  /** 检查更新（仅打包后的 Windows 有效，其余环境返回 supported=false） */
  checkForUpdate(): Promise<UpdateStatusView>
  /** 下载完成后重启并安装更新 */
  installUpdate(): void
  /** 订阅更新状态推送（检查/下载进度/就绪/出错） */
  onUpdateStatus(cb: (status: UpdateStatusView) => void): () => void

  winMinimize(): void
  winMaximize(): void
  winClose(): void
  isMaximized(): Promise<boolean>
  /**
   * 迷你窗口的临时附加区：`extra` 是附加高度（0 表示收起），
   * `direction` 是期望生长方向（歌词/队列向下，空间不足时自动翻转）。
   */
  setMiniExtra(extra: number, direction: 'up' | 'down'): void
  /** 打开/关闭音量气泡（独立透明窗口），返回最终是否可见 */
  toggleMiniVolume(state: MiniVolumeState): Promise<boolean>
  /** 音量气泡启动时读取当前音量 */
  getMiniVolume(): Promise<MiniVolumeState>
  /** 气泡拖动滑块 → 交给主窗口执行 setVolume */
  setMiniVolume(volume: number): void
  /** 主窗口音量/主题/强调色变化 → 同步气泡 */
  pushMiniVolume(state: MiniVolumeState): void
  /** 主窗口订阅气泡拖动（设置音量） */
  onMiniVolumeChanged(cb: (state: MiniVolumeState) => void): () => void
  /** 气泡订阅主窗口的音量变化 */
  onMiniVolumeState(cb: (state: MiniVolumeState) => void): () => void
  /** 气泡主动关闭（Esc） */
  closeMiniVolume(): void

  toggleLyricWindow(): Promise<boolean>
  closeLyricWindow(): void
  setLyricWindowLock(locked: boolean): void
  /** 锁定态悬停：穿透窗口靠转发 mousemove 感知鼠标，悬停时临时恢复交互 */
  setLyricWindowHover(hover: boolean): void
  /** 手动拖拽：mousedown 记录窗口/光标起点，move 报位移，up 结束（透明窗口 drag 区不可靠） */
  dragLyricWindow(): void
  moveLyricWindow(dx: number, dy: number): void
  endLyricWindowDrag(): void
  pushLyricState(state: unknown): void
  /** 读取当前桌面歌词形态 */
  getLyricMode(): Promise<'mini' | 'full'>
  /** 切换形态（mini 单行迷你条 / full 大字三行） */
  setLyricMode(mode: 'mini' | 'full'): Promise<'mini' | 'full'>
  /** 迷你条上的播放控制，由主进程转发给主窗口执行 */
  sendLyricCommand(command: 'toggle' | 'next' | 'prev'): void

  /** 推送托盘要显示的播放状态（歌名 / 歌手 / 是否在播），状态变化时才需要发 */
  pushTrayState(state: TrayState): void
  /** 订阅托盘菜单下发的播放控制命令：toggle / next / prev */
  onTrayCommand(cb: (command: 'toggle' | 'next' | 'prev') => void): () => void

  onDownloadProgress(cb: (tasks: DownloadTask[]) => void): () => void
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void
  onLyricWindowState(cb: (state: unknown) => void): () => void
  /** 订阅歌词窗口右键菜单（主进程 context-menu 事件转发，坐标为 CSS 像素） */
  onLyricContextMenu(cb: (pos: { x: number; y: number }) => void): () => void
  onToast(cb: (payload: { type: 'info' | 'error' | 'success'; message: string }) => void): () => void

  /** 扫码登录：创建会话并返回二维码（dataURL） */
  startQrLogin(platform: QrLoginPlatform): Promise<QrLoginState>
  /** 轮询扫码状态（无会话时返回 idle） */
  pollQrLogin(): Promise<QrLoginState>
  /** 取消登录（关闭弹层） */
  cancelQrLogin(): void

  /** 手机号登录：发送短信验证码 */
  sendSmsCaptcha(phone: string, countrycode?: string): Promise<{ ok: boolean; message: string }>
  /** 手机号登录：验证码或密码二选一，成功后 Cookie 与账号信息落库并广播 */
  cellphoneLogin(args: CellphoneLoginArgs): Promise<CellphoneLoginResult>

  /** 浏览器内登录：打开官网登录窗口，登录成功后主进程自动取 Cookie 落库 */
  openLoginWindow(platform: QrLoginPlatform): Promise<{ opened: boolean }>
  /** 主动关闭浏览器登录窗口 */
  closeLoginWindow(): void
  /** 浏览器登录结果（主 → 渲染）：ok=false 时 message 说明原因 */
  onLoginWindowResult(cb: (result: { platform: QrLoginPlatform; ok: boolean; message: string }) => void): () => void
}

/** 托盘状态（渲染 → 主进程，main 只用它更新 tooltip 与菜单文案） */
export interface TrayState {
  title: string
  artist: string
  playing: boolean
}

/** 更新状态（主进程 → 设置页） */
export interface UpdateStatusView {
  /** 当前环境是否支持自动更新（仅打包后的 Windows） */
  supported: boolean
  state: 'idle' | 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error'
  currentVersion: string
  /** 可更新到 / 已下载的版本号 */
  version?: string
  /** 下载进度（0-100） */
  percent?: number
  message?: string
}

declare global {
  interface Window {
    api: AuroraApi
  }
}
