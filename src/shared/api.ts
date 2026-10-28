/** 渲染进程专用：由主进程注入的 API 类型（与 preload 暴露的对象一一对应） */
import type {
  AppSettings,
  CellphoneLoginArgs,
  CellphoneLoginResult,
  ChartSummary,
  DownloadTask,
  LibraryTrack,
  Lyric,
  Playlist,
  QrLoginPlatform,
  QrLoginState,
  ProviderInfo,
  ResolvedTrack,
  SearchPage,
  Song
} from './types'

/** 引擎运行时状态（主进程 → 设置页） */
export interface EngineStatusView {
  ready: boolean
  runtime: { command: string; label: string; version?: string; sources?: number } | null
  error: string
  log: string[]
  bridgeFound: boolean
  musicdlFound: boolean
  /** 安装版与开发版的补救办法不一样，文案要分开 */
  packaged: boolean
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
  /** 手动指定 Python 解释器并重启引擎 */
  engineChoosePython(): Promise<EngineStatusView>
  /** 引擎自愈：重拉官方 musicdl 源码并重启引擎；失败时 reject 原因 */
  engineRepairVendor(): Promise<EngineStatusView>

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

  toggleLyricWindow(): Promise<boolean>
  closeLyricWindow(): void
  setLyricWindowLock(locked: boolean): void
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
