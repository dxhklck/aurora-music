/**
 * IPC 通道常量。主进程、preload、渲染进程共用，避免字符串散落。
 */
export const IPC = {
  // 音源
  providerList: 'provider:list',
  search: 'provider:search',
  /** 慢音源的增量搜索结果（主 → 渲染，单向推送） */
  searchPartial: 'provider:search-partial',
  charts: 'provider:charts',
  chartDetail: 'provider:chart-detail',
  lyric: 'provider:lyric',
  resolveTrack: 'provider:resolve-track',
  coverResolve: 'provider:cover-resolve',

  // 下载
  downloadEnqueue: 'download:enqueue',
  downloadEnqueueMany: 'download:enqueue-many',
  downloadList: 'download:list',
  downloadCancel: 'download:cancel',
  downloadRetry: 'download:retry',
  downloadRetryFailed: 'download:retry-failed',
  downloadRemove: 'download:remove',
  downloadClear: 'download:clear',
  downloadOpen: 'download:open',
  downloadReveal: 'download:reveal',
  downloadProgress: 'download:progress',
  downloadDir: 'download:dir',
  downloadChooseDir: 'download:choose-dir',

  // musicdl 引擎
  engineStatus: 'engine:status',
  engineRestart: 'engine:restart',
  /** 上游健康巡检：读快照 / 立刻重扫 */
  sourceHealth: 'engine:source-health',
  sourceHealthRefresh: 'engine:source-health-refresh',

  // 本地库
  libraryList: 'library:list',
  libraryRemove: 'library:remove',
  /** 改本地曲目的歌名/歌手/专辑（同时写 sidecar 与音频标签） */
  libraryUpdateMeta: 'library:update-meta',
  libraryRefresh: 'library:refresh',
  libraryReveal: 'library:reveal',
  /** 导入本地音乐目录（对话框选目录 → 追加到 settings.musicDirs → 重新扫描） */
  libraryImportDir: 'library:import-dir',
  libraryRemoveDir: 'library:remove-dir',
  libraryDirs: 'library:dirs',

  // 收藏 / 歌单
  playlistList: 'playlist:list',
  playlistCreate: 'playlist:create',
  playlistRename: 'playlist:rename',
  playlistRemove: 'playlist:remove',
  playlistAddSongs: 'playlist:add-songs',
  playlistRemoveSong: 'playlist:remove-song',
  playlistToggleFavorite: 'playlist:toggle-favorite',

  // 设置
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsChanged: 'settings:changed',

  // 窗口
  winMinimize: 'win:minimize',
  winMaximize: 'win:maximize',
  winClose: 'win:close',
  winIsMaximized: 'win:is-maximized',
  /** 迷你窗口：临时附加区（歌词 / 队列）的高度与生长方向，主进程同步调整窗口 */
  miniSetExtra: 'mini:set-extra',
  /** 迷你窗口：音量气泡（独立透明窗口）开/关与双向同步 */
  miniVolumeToggle: 'mini:volume-toggle',
  miniVolumeInit: 'mini:volume-init',
  miniVolumeSet: 'mini:volume-set',
  miniVolumeState: 'mini:volume-state',
  miniVolumeChanged: 'mini:volume-changed',
  miniVolumePush: 'mini:volume-push',
  miniVolumeClose: 'mini:volume-close',

  // 桌面歌词
  lyricWindowToggle: 'lyric-window:toggle',
  lyricWindowClose: 'lyric-window:close',
  lyricWindowLock: 'lyric-window:lock',
  lyricWindowState: 'lyric-window:state',
  lyricWindowPush: 'lyric-window:push',
  // 歌词窗口右键菜单：主进程 context-menu 事件转发（拖拽区上 DOM 事件可能收不到）
  lyricWindowContextMenu: 'lyric-window:context-menu',
  // 形态切换（mini / full）：不传参数 = 读取当前形态
  lyricWindowMode: 'lyric-window:mode',
  // 歌词窗口发起的播放控制（toggle / next / prev），由主进程转发给主窗口
  lyricWindowCommand: 'lyric-window:command',
  // 手动拖拽：透明窗口上 -webkit-app-region 不可靠，渲染层上报鼠标位移、主进程移动窗口
  lyricWindowDragStart: 'lyric-window:drag-start',
  lyricWindowDragMove: 'lyric-window:drag-move',
  lyricWindowDragEnd: 'lyric-window:drag-end',
  // 锁定态悬停：穿透窗口只转发 mousemove，渲染层据此通知主进程临时恢复交互
  lyricWindowHover: 'lyric-window:hover',

  // 系统托盘 / 全局快捷键共用的播放控制命令（主 → 渲染）：toggle / next / prev
  trayState: 'tray:state',
  trayCommand: 'tray:command',

  // 扫码登录：start 创建会话，poll 轮询状态，cancel 关闭弹层
  qrLoginStart: 'qrlogin:start',
  qrLoginPoll: 'qrlogin:poll',
  qrLoginCancel: 'qrlogin:cancel',

  // 手机号登录（网易云）：验证码发送 + 手机号（验证码/密码）登录
  smsCaptchaSend: 'login:sms-captcha-send',
  cellphoneLogin: 'login:cellphone',

  // 浏览器内登录：开一个应用内窗口加载平台官网，用户自己登录，主进程只取 Cookie
  loginWindowOpen: 'login-window:open',
  loginWindowClose: 'login-window:close',
  loginWindowResult: 'login-window:result',

  // 通知
  toast: 'app:toast',

  // 自动更新（Windows）
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateStatus: 'update:status'
} as const
