import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { trayReady, isQuitting } from './tray'
import { settings } from './services/settings'

let mainWindow: BrowserWindow | null = null
let lyricWindow: BrowserWindow | null = null

const isDev = !!process.env.ELECTRON_RENDERER_URL
const isMac = process.platform === 'darwin'
const isLinux = process.platform === 'linux'

function rendererUrl(hash: string): { url?: string; file?: string; hash: string } {
  if (isDev) return { url: `${process.env.ELECTRON_RENDERER_URL}${hash}`, hash }
  return { file: join(__dirname, '../renderer/index.html'), hash }
}

/**
 * 应用图标（任务栏/窗口用）。不配的话 dev 模式下任务栏显示的是 Electron
 * 默认图标，与托盘、exe 三个来源不一致——统一解析到 resources/icons/icon.ico。
 */
function resolveAppIcon(): string {
  const name = 'icon.ico'
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'icons', name)]
    : [
        join(app.getAppPath(), 'resources', 'icons', name),
        join(__dirname, '../../resources', 'icons', name),
        join(process.cwd(), 'resources', 'icons', name)
      ]
  return candidates.find((path) => existsSync(path)) ?? ''
}

export function createMainWindow(): BrowserWindow {
  const icon = resolveAppIcon()
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1024,
    minHeight: 660,
    show: false,
    ...(icon ? { icon } : {}),
    // macOS 保留原生窗口框架以显示红绿灯按钮；Windows / Linux 用自绘标题栏
    frame: isMac,
    backgroundColor: '#08080c',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 17 } }
      : { titleBarStyle: 'hidden' as const }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      // 窗口被遮挡/最小化时仍保持歌词与进度动画的刷新节奏
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    // 恢复上次关闭前的窗口位置与形态（迷你态跨重启）
    if (mainWindow) restoreWindowShape(mainWindow)
    mainWindow?.show()
    mainWindow?.webContents.setBackgroundThrottling(false)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const target = rendererUrl(process.env.AURORA_ROUTE ?? '')
  if (target.url) {
    void mainWindow.loadURL(target.url)
  } else if (target.file) {
    void mainWindow.loadFile(target.file, target.hash ? { hash: target.hash } : undefined)
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    lyricWindow?.close()
    lyricWindow = null
  })

  // 关闭行为可配置（settings.closeToTray，默认开）：
  //  - 开 + 托盘可用：点关闭按钮 = 隐藏到托盘（音乐播放器惯例：后台继续播）
  //  - 关，或托盘不可用（Linux 无 AppIndicator 等）：保持原生关闭，避免「关不掉又没托盘」
  mainWindow.on('close', (event) => {
    if (trayReady && settings.get().closeToTray && !isQuitting() && mainWindow && !mainWindow.isDestroyed()) {
      // 退出前把当前形态的位置存下来，下次启动原样恢复
      const bounds = { ...settings.get().windowBounds }
      const rect = mainWindow.getNormalBounds()
      if (settings.get().miniMode) bounds.mini = rect
      else if (rect.width > MINI_SIZE.width) bounds.normal = rect
      void settings.set({ windowBounds: bounds })
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  return mainWindow
}

/** 供需要真正关闭窗口的调用方使用（当前托盘退出走 app.quit，不经过这里） */
export function hideToTray(): void {
  mainWindow?.hide()
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/* ---------------- 迷你播放器模式 ---------------- */

const NORMAL_SIZE = { width: 1320, height: 840, minWidth: 1024, minHeight: 660 }
const MINI_SIZE = { width: 384, height: 112 }

/** 把目标矩形纠正到最近显示器的可视区域内（换显示器/分辨率后防止窗口跑到屏外） */
function clampRect(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  const display = screen.getDisplayMatching(rect)
  const area = display.workArea
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width)
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height)
  return { x, y }
}

/**
 * 主窗口在「完整形态 ↔ 迷你浮窗」之间切换。
 * 两种形态各自记住位置尺寸（settings.windowBounds），切换时把当前形态的位置存回去。
 * 迷你形态：置顶 + 不可缩放（布局锁死）；恢复形态：还原常规最小尺寸。
 */
export function applyMiniMode(win: BrowserWindow, mini: boolean): void {
  if (win.isDestroyed()) return
  const bounds = { ...settings.get().windowBounds }

  if (win.isMaximized()) win.unmaximize()

  if (mini) {
    // 只有从完整形态切过去时才记录常规位置；已在迷你态（如重启恢复）时保留旧值
    if (win.getBounds().width > MINI_SIZE.width) {
      bounds.normal = win.getNormalBounds()
    }
    const miniRect = bounds.mini ?? {
      // 首次进入：贴着当前显示器右下角
      ...clampRect({ x: win.getBounds().x + 240, y: win.getBounds().y + 320, ...MINI_SIZE }),
      ...MINI_SIZE
    }
    const pos = clampRect(miniRect)
    // 顺序敏感：先清掉旧上限（0,0 = 不限制），再设新的上下限——
    // 若先设 min 再改 max，min>max 的中间态会让 Windows 忽略 max 更新，展开时窗口会被 384 上限钳死
    win.setMaximumSize(0, 0)
    win.setMinimumSize(320, 96)
    win.setMaximumSize(MINI_SIZE.width, MINI_SIZE.height)
    win.setAlwaysOnTop(true, 'floating')
    win.setResizable(false)
    win.setBounds({ ...pos, ...MINI_SIZE })
    bounds.mini = { ...pos, ...MINI_SIZE }
  } else {
    if (win.getBounds().width <= MINI_SIZE.width) {
      bounds.mini = win.getNormalBounds()
    }
    // 顺序敏感（Windows 实测）：setResizable(false) 之后 setMaximumSize/setMinimumSize
    // 会被系统忽略，必须先恢复 resizable，再清最大尺寸锁（0,0 = 不限制）、设最小尺寸，
    // 最后 setBounds——否则窗口永远钳在 384×112
    win.setResizable(true)
    win.setMaximumSize(0, 0)
    win.setMinimumSize(NORMAL_SIZE.minWidth, NORMAL_SIZE.minHeight)
    win.setAlwaysOnTop(false)
    const normal = bounds.normal ?? {
      ...clampRect({ x: win.getBounds().x - 120, y: win.getBounds().y - 120, ...NORMAL_SIZE }),
      ...NORMAL_SIZE
    }
    const pos = clampRect(normal)
    win.setBounds({ ...pos, width: normal.width, height: normal.height })
    bounds.normal = { ...pos, width: normal.width, height: normal.height }
    if (process.env.AURORA_CAPTURE || process.env.AURORA_SELFTEST) {
      process.stdout.write(
        `[debug:expand] after setBounds -> ${JSON.stringify(win.getBounds())} requested ${normal.width}x${normal.height} max=${JSON.stringify(win.getMaximumSize())} min=${JSON.stringify(win.getMinimumSize())}\n`
      )
    }
  }

  void settings.set({ windowBounds: bounds })
}

/** 启动时恢复上次关闭前的形态（含迷你态跨重启） */
export function restoreWindowShape(win: BrowserWindow): void {
  const { miniMode, windowBounds } = settings.get()
  const normal = windowBounds?.normal
  if (!miniMode && normal && normal.width > MINI_SIZE.width) {
    const pos = clampRect(normal)
    try {
      win.setBounds({ ...pos, width: normal.width, height: normal.height })
    } catch {
      /* ignore */
    }
  }
  if (miniMode) applyMiniMode(win, true)
}

/** 桌面歌词形态：mini 单行迷你条（播放按钮 + 一行歌词）/ full 大字三行 */
export type LyricMode = 'mini' | 'full'

const LYRIC_BOUNDS: Record<
  LyricMode,
  { width: number; height: number; minWidth: number; minHeight: number }
> = {
  mini: { width: 760, height: 62, minWidth: 380, minHeight: 62 },
  full: { width: 980, height: 200, minWidth: 480, minHeight: 140 }
}

let lyricMode: LyricMode = 'mini'

/** 桌面歌词：透明、无边框、置顶、不占任务栏、默认鼠标穿透 */
export function createLyricWindow(mode: LyricMode = lyricMode): BrowserWindow {
  if (lyricWindow && !lyricWindow.isDestroyed()) {
    lyricWindow.show()
    return lyricWindow
  }

  lyricMode = mode
  const box = LYRIC_BOUNDS[mode]
  const fixedHeight = mode === 'mini'

  lyricWindow = new BrowserWindow({
    width: box.width,
    height: box.height,
    minWidth: box.minWidth,
    minHeight: box.minHeight,
    // 迷你条是单行布局，高度必须锁死；大字模式可自由拉伸
    ...(fixedHeight ? { maxHeight: box.height } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // level 参数只在 macOS 生效；Windows/Linux 用默认层级即可
  if (isMac) {
    lyricWindow.setAlwaysOnTop(true, 'screen-saver')
    lyricWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    lyricWindow.setAlwaysOnTop(true)
  }
  lyricWindow.setIgnoreMouseEvents(true, { forward: true })

  lyricWindow.on('ready-to-show', () => lyricWindow?.showInactive())
  lyricWindow.on('closed', () => {
    lyricWindow = null
    mainWindow?.webContents.send('lyric-window:state', { closed: true })
  })

  const target = rendererUrl('#/desktop-lyric')
  if (target.url) {
    void lyricWindow.loadURL(target.url)
  } else if (target.file) {
    void lyricWindow.loadFile(target.file, { hash: '/desktop-lyric' })
  }

  return lyricWindow
}

export function getLyricWindow(): BrowserWindow | null {
  return lyricWindow
}

export function getLyricMode(): LyricMode {
  return lyricMode
}

/**
 * 切换桌面歌词形态。
 * 顺序很重要：先把最大尺寸放开（否则旧的高度锁会挡住缩放），
 * 再设新的最小尺寸，最后才 setBounds。
 */
export function setLyricMode(mode: LyricMode): LyricMode {
  lyricMode = mode
  if (!lyricWindow || lyricWindow.isDestroyed()) return lyricMode

  const box = LYRIC_BOUNDS[mode]
  try {
    lyricWindow.setMaximumSize(4000, 4000)
    lyricWindow.setMinimumSize(box.minWidth, box.minHeight)
    if (mode === 'mini') lyricWindow.setMaximumSize(4000, box.height)
    const [x, y] = lyricWindow.getPosition()
    lyricWindow.setBounds({ x, y, width: box.width, height: box.height })
  } catch {
    // 个别 Linux 合成器不支持尺寸约束，忽略——布局仍会按 mode 渲染
  }
  return lyricMode
}

export function destroyLyricWindow(): void {
  if (lyricWindow && !lyricWindow.isDestroyed()) lyricWindow.close()
  lyricWindow = null
}

export function setLyricLocked(locked: boolean): void {
  if (!lyricWindow || lyricWindow.isDestroyed()) return
  // 锁定 = 鼠标穿透（不挡桌面操作）；解锁后才能拖动/关闭。
  // 注：Wayland 下是否支持穿透取决于合成器，X11 正常。
  try {
    lyricWindow.setIgnoreMouseEvents(locked, { forward: true })
  } catch {
    lyricWindow.setIgnoreMouseEvents(locked)
  }
}

export const platformFlags = { isMac, isLinux }
