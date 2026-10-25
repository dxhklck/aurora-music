import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { TrayState } from '@shared/api'
import { settings } from './services/settings'
import { getLyricWindow, getMainWindow, setLyricLocked } from './windows'

/**
 * 系统托盘。
 *
 * 职责边界刻意做小：
 *  - 托盘只负责「显示主窗口 / 播放控制 / 退出」，播放控制命令转发给渲染进程执行
 *    （播放状态只存在于 renderer 的 player store，主进程不持有）；
 *  - renderer 通过 tray:state 推送歌名与播放状态，托盘用它更新 tooltip 与菜单文案；
 *  - Linux 的 AppIndicator 依赖发行版扩展，Tray 构造失败时静默降级——此时窗口
 *    关闭按钮恢复为真正的关闭（见 windows.ts），绝不能出现「关不掉又没托盘」的死局。
 */

let tray: Tray | null = null
/** 托盘可用时才允许「关闭窗口 = 隐藏」 */
export let trayReady = false

/** 退出流程标记：置位后窗口关闭不再被拦截（app.quit 会走 close 事件链） */
let quitting = false

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

function resolveIconPath(): string {
  // 托盘与任务栏、exe 统一用同一个品牌图标（多尺寸 ico，16-256），
  // tray.png 仅作历史兜底。以前托盘用独立小图，三个来源看起来不一致。
  const names = ['icon.ico', 'tray.png']
  // getAppPath() 在 dev（electron-vite）下是项目根，直接 `electron out/main` 启动时是 out/main，
  // 所以与 resolveDemoDir 一样列多个候选逐个探测
  const dirs = app.isPackaged
    ? [join(process.resourcesPath, 'icons')]
    : [
        join(app.getAppPath(), 'resources', 'icons'),
        join(__dirname, '../../resources/icons'),
        join(process.cwd(), 'resources', 'icons')
      ]
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return join(dirs[0], names[0])
}

/** 播放控制命令转发到主窗口渲染进程 */
function sendCommand(command: 'toggle' | 'next' | 'prev'): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC.trayCommand, command)
}

function showMainWindow(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * 桌面歌词锁定后鼠标完全穿透，窗口里的按钮点不到——托盘必须留一个解锁出口，
 * 否则用户一旦点了「锁定」就再也解不开（连关闭按钮都点不到）。
 * 这里直接改设置并广播，避免 import ipc.ts 造成循环依赖。
 */
function unlockLyric(): void {
  const win = getLyricWindow()
  if (!win || win.isDestroyed()) return
  setLyricLocked(false)
  void settings.set({ desktopLyricLocked: false })
  win.webContents.send(IPC.lyricWindowState, { locked: false })
  for (const target of BrowserWindow.getAllWindows()) {
    target.webContents.send(IPC.settingsChanged, settings.get())
  }
}

function buildMenu(state: TrayState): Menu {
  const nowPlaying = state.title
    ? `${state.title}${state.artist ? ` — ${state.artist}` : ''}`
    : '尚未播放'
  return Menu.buildFromTemplate([
    { label: nowPlaying, enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: showMainWindow },
    { label: state.playing ? '暂停' : '播放', click: () => sendCommand('toggle') },
    { label: '下一首', click: () => sendCommand('next') },
    { label: '上一首', click: () => sendCommand('prev') },
    { type: 'separator' },
    { label: '解锁桌面歌词（锁定后点不到窗口时用）', click: unlockLyric },
    { type: 'separator' },
    {
      label: '退出 Aurora Music',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ])
}

/** renderer 推送的最新状态（托盘菜单每次弹开都重建，必须缓存最近一份） */
let lastState: TrayState = { title: '', artist: '', playing: false }

export function createTray(): void {
  const iconPath = resolveIconPath()
  if (!existsSync(iconPath)) {
    process.stdout.write('[tray] 跳过：图标不存在\n')
    return
  }
  try {
    const icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      process.stdout.write('[tray] 跳过：图标解码为空\n')
      return
    }
    tray = new Tray(icon)
  } catch (error) {
    // Linux 无 AppIndicator 支持等场景：不建托盘，窗口关闭行为自动回退
    process.stdout.write(`[tray] 创建失败：${(error as Error).message}\n`)
    tray = null
    return
  }

  trayReady = true
  tray.setToolTip('Aurora Music')
  tray.setContextMenu(buildMenu(lastState))
  process.stdout.write('[tray] 托盘已创建\n')

  // 左键单击：显示/聚焦主窗口（Windows / Linux 常见习惯）
  tray.on('click', showMainWindow)
}

/** 渲染进程推送状态（IPC 入口，main/ipc.ts 调用） */
export function updateTrayState(state: TrayState): void {
  if (!tray || tray.isDestroyed()) return
  lastState = state
  const playing = state.title
    ? `${state.playing ? '正在播放' : '已暂停'}：${state.title}${state.artist ? ` — ${state.artist}` : ''}`
    : 'Aurora Music'
  tray.setToolTip(playing)
  tray.setContextMenu(buildMenu(state))
}
