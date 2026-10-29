import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateStatusView } from '@shared/api'
import { markQuitting } from './tray'

/**
 * 自动更新（electron-updater + GitHub Releases）。
 *
 * 渠道策略：国内直连 api.github.com / objects.githubusercontent.com 经常超时，
 * 这里维护一个镜像前缀列表（ghproxy 系列的反代服务），检查更新时依次探测：
 * 直连成功就用直连，否则落到第一个能拉到 latest.yml 的镜像；选定后本会话固定，
 * 出错（比如镜像失效）时清空记忆让下次重新探测。
 * 镜像走 `releases/latest/download/<asset>` 稳定重定向，发新版无需改任何配置。
 *
 * 范围刻意做小：
 *  - 只有 Windows 开启（NSIS 目标支持自动更新；mac 未签名装不了更新包，Linux 无统一更新渠道）；
 *  - 启动后半分钟静默检查一次，失败（无网络等）静默，不打扰用户；
 *  - 检查到新版本自动下载，下载完成后广播状态，由设置页提示「重启并安装」；
 *  - 更新元数据 latest.yml 由 CI 打包时生成并随 Release 分发（见 build.yml）。
 */

const REPO = 'dxhklck/aurora-music'

/** 更新渠道：空串 = GitHub 直连；其余为反代镜像前缀（代理完整 GitHub URL）。
 *  渠道可用性实测会变（mirror.ghproxy.com 已下线），失效的直接删行即可 */
const CHANNELS = [
  '',
  'https://ghfast.top/',
  'https://gh-proxy.com/'
]

/** 渠道探测超时：国内对被墙端点通常是快速重置或长时间挂起，12s 足够分辨 */
const PROBE_TIMEOUT = 12_000

let initialized = false
/** 已验证可用的渠道；null = 尚未选定（下次检查时重新探测） */
let activeChannel: string | null = null

function currentStatus(state: UpdateStatusView['state'], extra: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return { supported: initialized, state, currentVersion: app.getVersion(), ...extra }
}

function broadcast(payload: UpdateStatusView): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.updateStatus, payload)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（>${ms / 1000}s）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 切换到指定渠道。直连用 electron-builder 配置的 github provider；镜像走 generic + 稳定重定向 */
function applyChannel(channel: string): void {
  if (channel === '') {
    // setFeedURL 传 github provider 需要完整配置，等于 electron-builder.yml 的 publish 段
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: REPO.split('/')[0],
      repo: REPO.split('/')[1]
    })
    return
  }
  autoUpdater.setFeedURL({
    provider: 'generic',
    // releases/latest/download 会被 GitHub 302 到最新 release 的资产，镜像原样跟随
    url: `${channel}https://github.com/${REPO}/releases/latest/download`
  })
}

/**
 * 确保选定可用渠道并切到位。
 * - 已有记忆且未失效：直接应用（不重复探测）；
 * - 无记忆：按 CHANNELS 顺序探测，第一个能拉到 latest.yml 的胜出；
 * - 全部失败：抛错，调用方决定提示方式。
 */
async function ensureChannel(): Promise<void> {
  if (activeChannel !== null) {
    applyChannel(activeChannel)
    return
  }
  const failures: string[] = []
  for (const channel of CHANNELS) {
    try {
      applyChannel(channel)
      await withTimeout(autoUpdater.checkForUpdates(), PROBE_TIMEOUT)
      activeChannel = channel
      return
    } catch (error) {
      failures.push(`${channel || '直连'}：${(error as Error).message?.slice(0, 80) ?? '未知错误'}`)
    }
  }
  throw new Error(`所有更新渠道均不可达。${failures.join('；')}`)
}

function bindEvents(): void {
  autoUpdater.on('checking-for-update', () => broadcast(currentStatus('checking')))
  autoUpdater.on('update-available', (info) => broadcast(currentStatus('available', { version: info.version })))
  autoUpdater.on('update-not-available', () => broadcast(currentStatus('none')))
  autoUpdater.on('download-progress', (progress) =>
    broadcast(currentStatus('downloading', { percent: Math.round(progress.percent) }))
  )
  autoUpdater.on('update-downloaded', (info) => broadcast(currentStatus('ready', { version: info.version })))
  autoUpdater.on('error', (error) => {
    // 渠道中途失效（镜像挂了/直连被断）：忘掉当前选择，下次检查重新探测
    activeChannel = null
    broadcast(currentStatus('error', { message: (error as Error).message ?? String(error) }))
  })
}

export function initUpdater(): void {
  if (initialized) return
  if (!app.isPackaged || process.platform !== 'win32') return
  initialized = true
  bindEvents()
  autoUpdater.autoDownload = true
  setTimeout(() => {
    void checkForUpdate().catch(() => {})
  }, 30_000)
}

/** 设置页手动检查 / 启动静默检查共用。dev / 非平台直接返回不支持状态 */
export async function checkForUpdate(): Promise<UpdateStatusView> {
  if (!app.isPackaged || process.platform !== 'win32') {
    return currentStatus('none', { supported: false })
  }
  initUpdater()
  try {
    await ensureChannel()
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
  // quitAndInstall 内部走 app.quit()。默认开着「关闭到托盘」时，主窗口的 close 会被
  // 拦成隐藏 → 退出流程走不完，安装器只能一直等进程结束。先置退出标记，让 close 放行。
  markQuitting()
  autoUpdater.quitAndInstall()
}
