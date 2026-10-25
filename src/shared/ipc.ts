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
  /** 手动指定 Python 解释器（安装版没有 npm 脚本时用） */
  engineChoosePython: 'engine:choose-python',

  // 本地库
  libraryList: 'library:list',
  libraryRemove: 'library:remove',
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

  // 桌面歌词
  lyricWindowToggle: 'lyric-window:toggle',
  lyricWindowClose: 'lyric-window:close',
  lyricWindowLock: 'lyric-window:lock',
  lyricWindowState: 'lyric-window:state',
  lyricWindowPush: 'lyric-window:push',
  // 形态切换（mini / full）：不传参数 = 读取当前形态
  lyricWindowMode: 'lyric-window:mode',
  // 歌词窗口发起的播放控制（toggle / next / prev），由主进程转发给主窗口
  lyricWindowCommand: 'lyric-window:command',

  // 系统托盘 / 全局快捷键共用的播放控制命令（主 → 渲染）：toggle / next / prev
  trayState: 'tray:state',
  trayCommand: 'tray:command',

  // 扫码登录：start 创建会话，poll 轮询状态，cancel 关闭弹层
  qrLoginStart: 'qrlogin:start',
  qrLoginPoll: 'qrlogin:poll',
  qrLoginCancel: 'qrlogin:cancel',

  // 浏览器内登录：开一个应用内窗口加载平台官网，用户自己登录，主进程只取 Cookie
  loginWindowOpen: 'login-window:open',
  loginWindowClose: 'login-window:close',
  loginWindowResult: 'login-window:result',

  // 通知
  toast: 'app:toast'
} as const
