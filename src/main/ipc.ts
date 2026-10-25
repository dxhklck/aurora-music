import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { AppSettings, Song } from '@shared/types'
import { setProviderCookies } from './providers/cookies'
import type { TrayState } from '@shared/api'
import { updateTrayState } from './tray'
import { providers, registerEngineProviders, unregisterEngineProviders } from './providers'
import { catalog } from './services/catalog'
import { resolveCover } from './services/cover'
import { downloads } from './services/download'
import { library } from './services/library'
import { playlists } from './services/playlists'
import { settings } from './services/settings'
import {
  cancelQrLogin,
  onLoginSuccess,
  pollQrLogin,
  startQrLogin
} from './services/qrlogin'
import { musicdl } from './engine/musicdl'
import { openLoginWindow, closeLoginWindow } from './services/weblogin'
import {
  createLyricWindow,
  destroyLyricWindow,
  applyMiniMode,
  getLyricMode,
  getLyricWindow,
  getMainWindow,
  setLyricLocked,
  setLyricMode
} from './windows'

function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => fn(...args))
}

/** fire-and-forget 通道必须用 ipcMain.on，与渲染侧的 ipcRenderer.send 配对 */
function on(channel: string, fn: (...args: any[]) => void): void {
  ipcMain.on(channel, (_event, ...args) => {
    try {
      fn(...args)
    } catch (error) {
      process.stdout.write(`[ipc:${channel}] ${String(error)}\n`)
    }
  })
}

export function registerIpc(): void {
  // ---------- 音源 / 目录 ----------
  handle(IPC.providerList, () => providers.infos())
  handle(
    IPC.search,
    (args: { platform: string; keyword: string; page?: number; limit?: number; streamId?: string }) => {
      const { streamId, ...input } = args
      if (!streamId) return catalog.search(input)
      return catalog.search({
        ...input,
        // 慢音源边搜边出：每解析出一首就推给渲染进程，前端先渲染再等收尾
        onPartial: (items) => {
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send(IPC.searchPartial, { streamId, items })
          }
        }
      })
    }
  )
  handle(IPC.charts, (platform: string) => catalog.charts(platform))
  handle(IPC.chartDetail, (args: { platform: string; id: string; page: number; limit: number }) =>
    catalog.chartDetail(args.platform, args.id, args.page, args.limit)
  )
  handle(IPC.lyric, (song: Song) => catalog.lyric(song))
  handle(IPC.resolveTrack, (args: { song: Song; autoSwitch?: boolean; forceSwitch?: boolean }) =>
    catalog.resolveTrack(args.song, args.autoSwitch !== false, args.forceSwitch === true)
  )
  handle(IPC.coverResolve, (song: Song) => resolveCover(song))

  // ---------- 下载 ----------
  handle(IPC.downloadEnqueue, (song: Song) => downloads.enqueue(song))
  handle(IPC.downloadEnqueueMany, (songs: Song[]) => downloads.enqueueMany(songs))
  handle(IPC.downloadList, () => downloads.list())
  handle(IPC.downloadCancel, (id: string) => downloads.cancel(id))
  handle(IPC.downloadRetry, (id: string) => downloads.retry(id))
  handle(IPC.downloadRetryFailed, () => downloads.retryFailed())
  handle(IPC.downloadRemove, (id: string) => downloads.remove(id))
  handle(IPC.downloadClear, () => downloads.clearFinished())
  handle(IPC.downloadDir, () => settings.get().downloadDir)
  handle(IPC.downloadOpen, async (id: string) => {
    const task = downloads.list().find((item) => item.id === id)
    if (task?.filePath) await shell.openPath(task.filePath)
  })
  handle(IPC.downloadReveal, async (id: string) => {
    const task = downloads.list().find((item) => item.id === id)
    if (task?.filePath) shell.showItemInFolder(task.filePath)
  })
  handle(IPC.downloadChooseDir, async () => {
    const win = getMainWindow()
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择下载目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths.length) return settings.get().downloadDir
    const next = await settings.set({ downloadDir: result.filePaths[0] })
    broadcastSettings(next)
    return next.downloadDir
  })

  // ---------- 本地库 ----------
  handle(IPC.libraryList, () => library.list())
  handle(IPC.libraryRefresh, async () => {
    library.setScanDirs([settings.get().downloadDir, ...settings.get().musicDirs])
    // 先重读索引并清掉「文件已被手动删除」的条目（prune），再登记新增文件。
    // 原来只调 scanLocalDirs——它只加不删，手动删掉文件后刷新永远清不掉旧条目。
    await library.refresh()
    await library.scanLocalDirs()
    return library.list()
  })
  handle(IPC.libraryRemove, async (id: string) => {
    await library.remove(id)
    return library.list()
  })
  handle(IPC.libraryReveal, (id: string) => {
    const record = library.findById(id)
    if (record) shell.showItemInFolder(record.filePath)
  })

  // ---------- 本地音乐导入 ----------
  handle(IPC.libraryImportDir, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? undefined
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择本地音乐文件夹'
    }
    const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths.length) return settings.get().musicDirs
    const dir = picked.filePaths[0]
    const current = settings.get().musicDirs
    const next = current.includes(dir) ? current : [...current, dir]
    await settings.set({ musicDirs: next })
    library.setScanDirs([settings.get().downloadDir, ...next])
    await library.scanLocalDirs()
    return next
  })
  handle(IPC.libraryRemoveDir, async (dir: string) => {
    const next = settings.get().musicDirs.filter((item) => item !== dir)
    await settings.set({ musicDirs: next })
    library.setScanDirs([settings.get().downloadDir, ...next])
    // 已从库里移除目录中的文件不删除索引——用户可能只是暂不扫描，文件仍在磁盘
    return next
  })
  handle(IPC.libraryDirs, () => settings.get().musicDirs)

  // ---------- 收藏 / 歌单 ----------
  handle(IPC.playlistList, () => playlists.list())
  handle(IPC.playlistCreate, (args: { name: string; songs?: Song[] }) =>
    playlists.create(args.name, args.songs ?? [])
  )
  handle(IPC.playlistRename, (args: { id: string; name: string }) =>
    playlists.rename(args.id, args.name)
  )
  handle(IPC.playlistRemove, (id: string) => playlists.remove(id))
  handle(IPC.playlistAddSongs, (args: { id: string; songs: Song[] }) =>
    playlists.addSongs(args.id, args.songs)
  )
  handle(IPC.playlistRemoveSong, (args: { id: string; platform: string; songId: string }) =>
    playlists.removeSong(args.id, args.platform, args.songId)
  )
  handle(IPC.playlistToggleFavorite, (song: Song) => playlists.toggleFavorite(song))

  // ---------- 设置 ----------
  handle(IPC.settingsGet, () => settings.get())
  handle(IPC.settingsSet, async (patch: Partial<AppSettings>) => {
    const before = settings.get()
    const next = await settings.set(patch)
    // 迷你模式切换：窗口随之变形（收起为置顶小浮窗 / 展开回完整形态）
    if (before.miniMode !== next.miniMode) {
      const win = getMainWindow()
      if (win) applyMiniMode(win, next.miniMode)
    }
    // 引擎开关会改变音源列表：同步注册/注销，前端重新拉一次 provider 即可
    if (before.engineEnabled !== next.engineEnabled) {
      if (next.engineEnabled) registerEngineProviders()
      else unregisterEngineProviders()
    }
    // 并发数变化后立刻按新值调度（例如从 2 调到 4，排队的任务应该马上动起来）
    if (before.downloadConcurrency !== next.downloadConcurrency) downloads.pump()
    // 登录态 Cookie 变更后即时生效（音源适配器每次请求时读取，无需重建）
    if (
      before.qqCookie !== next.qqCookie ||
      before.neteaseCookie !== next.neteaseCookie
    ) {
      setProviderCookies({ qq: next.qqCookie, netease: next.neteaseCookie })
    }
    broadcastSettings(next)
    return next
  })

  // ---------- musicdl 引擎 ----------
  handle(IPC.engineStatus, () => musicdl.status())
  handle(IPC.engineRestart, () => musicdl.restart())
  handle(IPC.engineChoosePython, async () => {
    const win = getMainWindow()
    const options = {
      title: '选择 Python 解释器',
      properties: ['openFile' as const],
      filters:
        process.platform === 'win32'
          ? [{ name: 'Python', extensions: ['exe'] }]
          : [{ name: '所有文件', extensions: ['*'] }]
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths.length) return musicdl.status()
    await settings.set({ pythonPath: picked.filePaths[0] })
    return musicdl.restart()
  })

  // ---------- 窗口 ----------
  on(IPC.winMinimize, () => getMainWindow()?.minimize())
  on(IPC.winMaximize, () => {
    const win = getMainWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  on(IPC.winClose, () => getMainWindow()?.close())
  handle(IPC.winIsMaximized, () => getMainWindow()?.isMaximized() ?? false)

  // ---------- 托盘 ----------
  on(IPC.trayState, (state: TrayState) => updateTrayState(state))

  // ---------- 扫码登录 ----------
  // 登录成功后：Cookie 已由 service 写入 settings，这里负责让音源适配器即时看到
  // 新登录态（baseHeaders 每次请求都读），并广播让设置页刷新「已配置」状态
  onLoginSuccess((platform, cookie) => {
    setProviderCookies(platform === 'qq' ? { qq: cookie } : { netease: cookie })
    broadcastSettings(settings.get())
  })
  handle(IPC.qrLoginStart, (platform) => startQrLogin(platform))
  handle(IPC.qrLoginPoll, () => pollQrLogin())
  on(IPC.qrLoginCancel, () => cancelQrLogin())

  // ---------- 浏览器内登录 ----------
  handle(IPC.loginWindowOpen, (platform: 'qq' | 'netease') => openLoginWindow(platform))
  on(IPC.loginWindowClose, () => closeLoginWindow())

  // ---------- 桌面歌词 ----------
  handle(IPC.lyricWindowToggle, () => {
    const win = getLyricWindow()
    if (win && !win.isDestroyed()) {
      destroyLyricWindow()
      return false
    }
    createLyricWindow(settings.get().desktopLyricMode)
    setLyricLocked(settings.get().desktopLyricLocked)
    return true
  })
  on(IPC.lyricWindowClose, () => destroyLyricWindow())
  // 不传 mode 就是查询；切换后落盘，下次打开保持上次的形态
  handle(IPC.lyricWindowMode, (mode?: 'mini' | 'full') => {
    if (!mode) return getLyricMode()
    const next = setLyricMode(mode)
    void settings.set({ desktopLyricMode: next })
    // 形态以主进程为准：无论谁发起的切换，都同步给歌词窗口（窗口尺寸由主进程改，布局得跟着变）
    getLyricWindow()?.webContents.send(IPC.lyricWindowState, { mode: next })
    return next
  })
  // 迷你条上的播放按钮：转发给主窗口执行（渲染进程才有播放器实例）
  on(IPC.lyricWindowCommand, (command: string) => {
    if (command !== 'toggle' && command !== 'next' && command !== 'prev') return
    getMainWindow()?.webContents.send(IPC.trayCommand, command)
  })
  on(IPC.lyricWindowLock, (locked: boolean) => {
    setLyricLocked(locked)
    const next = { ...settings.get(), desktopLyricLocked: locked }
    void settings.set({ desktopLyricLocked: locked })
    broadcastSettings(next)
    getLyricWindow()?.webContents.send(IPC.lyricWindowState, { locked })
  })
  on(IPC.lyricWindowPush, (state: unknown) => {
    const win = getLyricWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.lyricWindowState, state)
  })
}

function broadcastSettings(next: AppSettings): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.settingsChanged, next)
  }
}
