import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateStatusView } from '@shared/api'

/**
 * 自动更新（electron-updater + GitHub Releases）。
 *
 * 范围刻意做小：
 *  - 只有 Windows 开启（NSIS 目标支持自动更新；mac 未签名装不了更新包，Linux 无统一更新渠道）；
 *  - 启动后半分钟静默检查一次，失败（无网络等）静默，不打扰用户；
 *  - 检查到新版本自动下载，下载完成后广播状态，由设置页提示「重启并安装」；
 *  - 更新元数据 latest.yml 由 CI 打包时生成并随 Release 分发（见 build.yml）。
 */

let initialized = false

function currentStatus(state: UpdateStatusView['state'], extra: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return { supported: initialized, state, currentVersion: app.getVersion(), ...extra }
}

function broadcast(payload: UpdateStatusView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateStatus, payload)
  }
}

function bindEvents(): void {
  autoUpdater.on('checking-for-update', () => broadcast(currentStatus('checking')))
  autoUpdater.on('update-available', (info) => broadcast(currentStatus('available', { version: info.version })))
  autoUpdater.on('update-not-available', () => broadcast(currentStatus('none')))
  autoUpdater.on('download-progress', (progress) =>
    broadcast(currentStatus('downloading', { percent: Math.round(progress.percent) }))
  )
  autoUpdater.on('update-downloaded', (info) => broadcast(currentStatus('ready', { version: info.version })))
  autoUpdater.on('error', (error) =>
    broadcast(currentStatus('error', { message: (error as Error).message ?? String(error) }))
  )
}

export function initUpdater(): void {
  if (initialized) return
  if (!app.isPackaged || process.platform !== 'win32') return
  initialized = true
  bindEvents()
  autoUpdater.autoDownload = true
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {})
  }, 30_000)
}

/** 设置页手动检查。dev / 非平台直接返回不支持状态 */
export async function checkForUpdate(): Promise<UpdateStatusView> {
  if (!app.isPackaged || process.platform !== 'win32') {
    return currentStatus('none', { supported: false })
  }
  initUpdater()
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo?.version
    if (version && version !== app.getVersion()) return currentStatus('available', { version })
    return currentStatus('none')
  } catch (error) {
    return currentStatus('error', { message: (error as Error).message })
  }
}

export function installUpdate(): void {
  if (!initialized) return
  autoUpdater.quitAndInstall()
}
