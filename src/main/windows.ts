import { app, BrowserWindow, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { MiniVolumeState } from '@shared/types'
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
    if (volumePopup && !volumePopup.isDestroyed()) volumePopup.destroy()
    volumePopup = null
  })

  // 迷你条位置改变时音量气泡跟随（只在气泡可见时生效）
  mainWindow.on('move', () => positionVolumePopup())
  mainWindow.on('resize', () => positionVolumePopup())

  // 关闭行为可配置（settings.closeToTray，默认开）：
  //  - 开 + 托盘可用：点关闭按钮 = 隐藏到托盘（音乐播放器惯例：后台继续播）
  //  - 关，或托盘不可用（Linux 无 AppIndicator 等）：保持原生关闭，避免「关不掉又没托盘」
  mainWindow.on('close', (event) => {
    if (trayReady && settings.get().closeToTray && !isQuitting() && mainWindow && !mainWindow.isDestroyed()) {
      // 退出前把当前形态的位置存下来，下次启动原样恢复
      const bounds = { ...settings.get().windowBounds }
      const rect = mainWindow.getNormalBounds()
      // 迷你态只记「收起后的尺寸」：面板展开时会话不持久化，否则下次启动会以 376 高打开
      if (settings.get().miniMode) bounds.mini = { ...rect, width: MINI_SIZE.width, height: MINI_SIZE.height }
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
/**
 * 迷你条：宽度按「封面 56 + 播放控制 90 + 图标组 137 + 留白」定的。
 * 参考图是 320~330，这里取 380 是为了 hover 时三键控制与六个图标能同时放下，
 * 不必靠挤压缩小点击热区。
 */
const MINI_SIZE = { width: 380, height: 56 }
/** 迷你窗口的临时附加区（歌词/队列/音量），仅内存态，不持久化 */
type MiniExtra = { height: number; direction: 'up' | 'down' }
let miniExtra: MiniExtra | null = null

/** 从当前 bounds 反推「收起态迷你条」的顶边：面板向上生长时条在底部，需要换算 */
function miniBaseTop(win: BrowserWindow): number {
  const bounds = win.getBounds()
  if (!miniExtra) return bounds.y
  return miniExtra.direction === 'up'
    ? bounds.y + bounds.height - MINI_SIZE.height
    : bounds.y
}

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
    // 每次进入迷你态都从收起态开始，避免带着上次的展开高度
    miniExtra = null
    // 只有从完整形态切过去时才记录常规位置；已在迷你态（如重启恢复）时保留旧值
    if (win.getBounds().width > MINI_SIZE.width) {
      bounds.normal = win.getNormalBounds()
    }
    const miniRect = bounds.mini ?? {
      // 首次进入：贴着当前显示器右下角
      x: win.getBounds().x + 240,
      y: win.getBounds().y + 320,
      ...MINI_SIZE
    }
    // 用**当前**的 MINI_SIZE 参与边界纠正：旧版本存的是 240×56，
    // 直接拿旧宽度 clamp 会让 380 宽的新窗口右边超出屏幕 140px
    const pos = clampRect({ ...miniRect, ...MINI_SIZE })
    // 顺序敏感：先清掉旧上限（0,0 = 不限制），再设新的上下限——
    // 若先设 min 再改 max，min>max 的中间态会让 Windows 忽略 max 更新，展开时窗口会被 320 上限钳死
    win.setMaximumSize(0, 0)
    win.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height)
    win.setMaximumSize(MINI_SIZE.width, MINI_SIZE.height)
    win.setAlwaysOnTop(true, 'floating')
    win.setResizable(false)
    win.setBounds({ ...pos, ...MINI_SIZE })
    bounds.mini = { ...pos, ...MINI_SIZE }
  } else {
    // 切回完整窗口：音量气泡没有意义了，直接收起
    closeVolumePopup()
    if (win.getBounds().width <= MINI_SIZE.width) {
      bounds.mini = win.getNormalBounds()
    }
    // 顺序敏感（Windows 实测）：setResizable(false) 之后 setMaximumSize/setMinimumSize
    // 会被系统忽略，必须先恢复 resizable，再清最大尺寸锁（0,0 = 不限制）、设最小尺寸，
    // 最后 setBounds——否则窗口永远钳在 240×56
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

/**
 * 迷你窗口的临时附加区（歌词 / 队列 / 音量）。
 *
 * - 只改高度、不改宽度；
 * - `direction` 是期望的生长方向：歌词/队列向下，音量向上（浮在迷你条上方）；
 * - 空间不足时自动翻到另一侧，翻转后的实际方向记进 `miniExtra`，
 *   下次收起/切换才能按正确的「条的位置」换算；
 * - 任何切换都以「收起态迷你条的顶边」为锚点，所以面板之间互切时
 *   迷你条本身不会跳动（376 的歌词 ↔ 206 的音量，条的位置不变）。
 *
 * 顺序敏感：先把最大尺寸放开到无限制，再设新的上下限。否则上次
 * `setMaximumSize(380, 56)` 会让后续 setBounds 的高度被系统钳掉。
 */
export function setMiniExtra(extra: number, direction: 'up' | 'down' = 'down'): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (!settings.get().miniMode) return

  const wanted = Math.max(0, Math.round(extra))
  if (wanted === 0 && !miniExtra) return
  if (miniExtra && miniExtra.height === wanted && miniExtra.direction === direction) return

  const bounds = win.getBounds()
  const top = miniBaseTop(win)
  const area = screen.getDisplayMatching(bounds).workArea
  const total = MINI_SIZE.height + wanted
  let actual = direction
  let y = top

  if (wanted > 0) {
    if (actual === 'up') {
      y = top - wanted
      // 上方放不下：改到下方
      if (y < area.y) {
        actual = 'down'
        y = top
      }
    }
    if (actual === 'down' && y + total > area.y + area.height) {
      // 下方放不下：优先翻到上方，上下都不够就贴着底边
      if (top - wanted >= area.y) {
        actual = 'up'
        y = top - wanted
      } else {
        y = Math.max(area.y, area.y + area.height - total)
      }
    }
  }

  miniExtra = wanted > 0 ? { height: wanted, direction: actual } : null
  win.setMaximumSize(0, 0)
  win.setMinimumSize(MINI_SIZE.width, MINI_SIZE.height)
  win.setMaximumSize(MINI_SIZE.width, total)
  win.setBounds({ x: bounds.x, y, width: MINI_SIZE.width, height: total })
}

/** 当前是否有附加区展开（供自检/调试读取） */
export function isMiniExpanded(): boolean {
  return miniExtra !== null
}

/* ---------------- 迷你窗口：音量气泡 ----------------
   参考设计是「白色气泡 + 横向滑块」，浮在迷你条**外面**。
   主窗口不透明，画在窗口内会露出深色底，所以单独开一个透明无边框窗口承载。 */

/**
 * 气泡窗口尺寸。高度按内容算：上下各 8px 留白 + 40px 卡片 + 8px 三角 = 56，
 * 早先按 70 给会把三角和迷你条之间空出 17px，看起来像「浮在半空」。
 */
const VOLUME_POPUP_SIZE = { width: 236, height: 56 }
/**
 * 气泡右边缘相对迷你条右边缘的偏移。
 * 三角尖端距气泡右边缘 112px（见 VolumePopup.vue 的 `.arrow { right: 105px }` + 7px 半宽），
 * 音量按钮中心距条右边缘约 121px，所以整体左移 9px 才能让尖端对准按钮。
 */
const VOLUME_POPUP_OFFSET = -9

let volumePopup: BrowserWindow | null = null
/** 气泡的状态：音量之外还带主题与强调色，独立窗口靠它对齐主窗口的配色 */
let volumeState: MiniVolumeState = {
  volume: 0.75,
  muted: false,
  accent: '#7c6cff',
  accent2: '#4facfe',
  theme: 'dark',
  placement: 'above'
}
/** 因失焦而隐藏的时间：点音量按钮想关闭时，blur 会先触发，靠它避免「关了又开」 */
let volumeHiddenAt = 0

function createVolumePopup(): BrowserWindow {
  if (volumePopup && !volumePopup.isDestroyed()) return volumePopup

  volumePopup = new BrowserWindow({
    width: VOLUME_POPUP_SIZE.width,
    height: VOLUME_POPUP_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
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

  if (isMac) {
    volumePopup.setAlwaysOnTop(true, 'pop-up-menu')
    volumePopup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  } else {
    volumePopup.setAlwaysOnTop(true)
  }

  // 点气泡外部（桌面/别的窗口）就收起；记录时间给 toggle 去重
  volumePopup.on('blur', () => {
    if (!volumePopup || volumePopup.isDestroyed() || !volumePopup.isVisible()) return
    volumePopup.hide()
    volumeHiddenAt = Date.now()
  })
  volumePopup.on('closed', () => {
    volumePopup = null
  })

  const target = rendererUrl('#/volume-popup')
  if (target.url) {
    void volumePopup.loadURL(target.url)
  } else if (target.file) {
    void volumePopup.loadFile(target.file, { hash: '/volume-popup' })
  }
  return volumePopup
}

/**
 * 把气泡放到迷你条上方（上方空间不足则放到下方），并让三角对准音量按钮。
 *
 * `force` 用于「打开前定位」：此时窗口还没 show，isVisible() 是 false，
 * 早期版本在这里无条件 return，导致气泡落在系统默认位置（离迷你条老远），
 * 用户看到的滑块根本不在迷你条旁边，自然会觉得「调了没反应」。
 */
function positionVolumePopup(force = false): void {
  if (!volumePopup || volumePopup.isDestroyed()) return
  if (!force && !volumePopup.isVisible()) return
  const main = mainWindow
  if (!main || main.isDestroyed()) return

  const bounds = main.getBounds()
  const area = screen.getDisplayMatching(bounds).workArea
  let x = bounds.x + bounds.width - VOLUME_POPUP_SIZE.width + VOLUME_POPUP_OFFSET
  let y = bounds.y - VOLUME_POPUP_SIZE.height - 2
  let placement: 'above' | 'below' = 'above'
  if (y < area.y) {
    // 上方放不下：翻到迷你条下方，三角也要跟着朝上
    y = bounds.y + bounds.height + 2
    placement = 'below'
  }
  // 上下左右都夹进工作区：迷你条贴边时翻转后仍可能越界
  x = Math.min(Math.max(x, area.x), area.x + area.width - VOLUME_POPUP_SIZE.width)
  y = Math.min(Math.max(y, area.y), area.y + area.height - VOLUME_POPUP_SIZE.height)
  volumePopup.setBounds({
    x: Math.round(x),
    y: Math.round(y),
    ...VOLUME_POPUP_SIZE
  })
  if (volumeState.placement !== placement) {
    volumeState = { ...volumeState, placement }
    if (volumePopup.isVisible()) {
      volumePopup.webContents.send(IPC.miniVolumeState, volumeState)
    }
  }
}

/** 打开/关闭音量气泡；返回最终是否可见 */
export function toggleVolumePopup(state: MiniVolumeState): boolean {
  const win = createVolumePopup()
  volumeState = {
    volume: Math.min(1, Math.max(0, Number(state.volume) || 0)),
    muted: Boolean(state.muted),
    accent: state.accent || '#7c6cff',
    accent2: state.accent2 || '#4facfe',
    theme: state.theme === 'light' ? 'light' : 'dark',
    placement: state.placement === 'below' ? 'below' : 'above'
  }

  if (win.isVisible()) {
    win.hide()
    return false
  }
  // 刚因为点击迷你条而失焦隐藏：这次点击的意图是「关闭」，不要再打开
  if (Date.now() - volumeHiddenAt < 300) return false

  // 先定位再显示：位置要在窗口出现前算好，否则会先闪一下系统默认位置
  positionVolumePopup(true)
  win.show()
  // Windows 在 show() 后可能按 DPI 纠正一次窗口尺寸，补一次定位确保贴合迷你条
  positionVolumePopup(true)
  // 重复打开时渲染层不会重新 mount，必须主动推一次完整状态，
  // 否则上次的上下方位（三角朝向）会留在窗口里
  win.webContents.send(IPC.miniVolumeState, volumeState)
  return true
}

export function closeVolumePopup(): void {
  if (volumePopup && !volumePopup.isDestroyed()) volumePopup.hide()
}

export function getVolumeState(): MiniVolumeState {
  return volumeState
}

/** 主窗口音量/主题/强调色变化 → 同步气泡（气泡开着时才发） */
export function pushVolumeState(state: MiniVolumeState): void {
  volumeState = {
    volume: Math.min(1, Math.max(0, Number(state.volume) || 0)),
    muted: Boolean(state.muted),
    accent: state.accent || volumeState.accent,
    accent2: state.accent2 || volumeState.accent2,
    theme: state.theme === 'light' ? 'light' : 'dark',
    // 方位由 positionVolumePopup 决定，主窗口推送时不要覆盖
    placement: volumeState.placement
  }
  if (volumePopup && !volumePopup.isDestroyed() && volumePopup.isVisible()) {
    volumePopup.webContents.send(IPC.miniVolumeState, volumeState)
  }
}

/** 气泡拖动 → 转发给主窗口执行 setVolume */
export function emitVolumeChanged(volume: number): void {
  volumeState = { ...volumeState, volume }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC.miniVolumeChanged, volumeState)
  }
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
  full: { width: 920, height: 172, minWidth: 480, minHeight: 118 }
}

let lyricMode: LyricMode = 'full'

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
  // 锁定 = 默认鼠标穿透（不挡桌面操作），但 forward:true 会把 mousemove 转发给渲染层，
  // 渲染层据此在悬停时通知主进程临时恢复交互（见 setLyricHover）——锁定后仍可直接点解锁
  setLyricLocked(Boolean(settings.get().desktopLyricLocked))

  lyricWindow.on('ready-to-show', () => lyricWindow?.showInactive())
  lyricWindow.on('closed', () => {
    lyricWindow = null
    mainWindow?.webContents.send('lyric-window:state', { closed: true })
  })
  // 右键菜单转发：拖拽区（-webkit-app-region: drag）上的右键在部分平台到不了 DOM，
  // 统一走主进程 context-menu 事件转发给渲染层弹菜单
  lyricWindow.webContents.on('context-menu', (_event, params) => {
    lyricWindow?.webContents.send('lyric-window:context-menu', { x: params.x, y: params.y })
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
  // 锁定 = 鼠标穿透（不挡桌面操作）；forward:true 使 mousemove 仍转发给渲染层，
  // 供悬停恢复交互用。注：Wayland 下是否支持穿透取决于合成器，X11 正常。
  try {
    lyricWindow.setIgnoreMouseEvents(locked, { forward: true })
  } catch {
    lyricWindow.setIgnoreMouseEvents(locked)
  }
}

/**
 * 锁定态的悬停交互：穿透窗口收不到 enter/leave，只收转发的 mousemove。
 * 渲染层 mousemove → hover=true（临时关穿透，按钮可点）；mouseleave → hover=false（恢复穿透）。
 * 未锁定时窗口本就可交互，忽略。
 */
export function setLyricHover(hover: boolean): void {
  if (!lyricWindow || lyricWindow.isDestroyed()) return
  if (!settings.get().desktopLyricLocked) return
  try {
    lyricWindow.setIgnoreMouseEvents(!hover, { forward: true })
  } catch {
    lyricWindow.setIgnoreMouseEvents(!hover)
  }
}

/* ---------------- 手动拖拽 ----------------
   透明无边框窗口上 -webkit-app-region: drag 在 Windows 不可靠（拖拽区整块失效），
   改为渲染层上报鼠标位移、主进程 setPosition —— 不依赖任何系统拖拽机制。 */
let dragOrigin: { winX: number; winY: number; cursorX: number; cursorY: number } | null = null

export function lyricDragStart(): void {
  if (!lyricWindow || lyricWindow.isDestroyed()) return
  const { x, y } = lyricWindow.getBounds()
  const point = screen.getCursorScreenPoint()
  dragOrigin = { winX: x, winY: y, cursorX: point.x, cursorY: point.y }
}

export function lyricDragMove(dx: number, dy: number): void {
  if (!lyricWindow || lyricWindow.isDestroyed() || !dragOrigin) return
  lyricWindow.setPosition(dragOrigin.winX + dx, dragOrigin.winY + dy)
}

export function lyricDragEnd(): void {
  dragOrigin = null
}

export const platformFlags = { isMac, isLinux }
