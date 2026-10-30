import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { IPC } from '@shared/ipc'
import type { UpdateStatusView } from '@shared/api'
import { markQuitting } from './tray'
import { settings } from './services/settings'

/**
 * 自动更新（electron-updater + GitHub Releases + 可选国内对象存储）。
 *
 * 渠道策略：按 STORAGE_FEED → GitHub 直连 → ghproxy 系镜像 的顺序探测，
 * 第一个能拉到 latest.yml 的胜出，并跨启动记在 settings.updateChannel——
 * 国内直连通常被墙，不记忆的话每次启动都要白等直连超时。渠道中途失效时
 * 清掉记忆重新探测。
 * 镜像走 `releases/latest/download/<asset>` 稳定重定向，发新版无需改任何配置。
 * 对象存储源（STORAGE_FEED）配置后优先级最高：自建可信、速度快，且旧版本文件
 * 保留在桶里，差量更新（blockmap）只有在这个渠道才能真正生效。
 *
 * 范围刻意做小：
 *  - 只有 Windows 开启（NSIS 目标支持自动更新；mac 未签名装不了更新包，Linux 无统一更新渠道）；
 *  - 启动后半分钟静默检查一次，失败（无网络等）静默，不打扰用户；
 *  - 检查到新版本自动下载，下载完成后广播状态，由设置页提示「重启并安装」；
 *  - 更新元数据 latest.yml 由 CI 打包时生成并随 Release 分发（见 build.yml），
 *    配置了 COS secrets 时同步一份到对象存储（见「Sync update files to COS」步骤）。
 */

const REPO = 'dxhklck/aurora-music'
const MANUAL_URL = `https://github.com/${REPO}/releases/latest`

/**
 * 国内对象存储源（可选）。
 *
 * 填上桶的公开读地址后自动成为第一优先渠道，例如：
 *   https://aurora-1250000000.cos.ap-guangzhou.myqcloud.com
 * 桶里是 CI 同步的 Windows 更新资产（latest.yml + exe + blockmap），扁平结构、旧版本不删——
 * 差量更新要拿「上一个版本」的 blockmap 和安装包按 Range 取旧字节，GitHub 镜像
 * （releases/latest/download/）只指向最新版，差量必然失败，桶是唯一能让差量生效的渠道。
 * 对应的 CI 同步步骤见 build.yml 的「Sync update files to COS」。
 */
const STORAGE_FEED = ''

/** 更新渠道：空串 = GitHub 直连；其余为反代镜像前缀（代理完整 GitHub URL）。
 *  渠道可用性实测会变（mirror.ghproxy.com 已下线），失效的直接删行即可 */
const CHANNELS: string[] = [
  ...(STORAGE_FEED ? [STORAGE_FEED] : []),
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

/** 切换到指定渠道。三种形态：对象存储 = 静态目录；直连 = github provider；镜像 = 前缀代理 */
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
  if (channel === STORAGE_FEED) {
    // 桶是普通静态目录：latest.yml 与安装包就在 URL 根下
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: channel.endsWith('/') ? channel : `${channel}/`
    })
    return
  }
  autoUpdater.setFeedURL({
    provider: 'generic',
    // 镜像是前缀代理：完整 GitHub URL 拼在前缀后面；
    // releases/latest/download 会被 GitHub 302 到最新 release 的资产，镜像原样跟随
    url: `${channel}https://github.com/${REPO}/releases/latest/download`
  })
}

/**
 * 确保选定可用渠道并切到位。
 * - 上次验证过的渠道记在 settings.updateChannel 里（跨启动生效）：直接应用，不重复探测。
 *   国内直连 GitHub 通常被墙，不记忆的话每次启动都要白等直连超时 12s；
 * - 无记忆：按 CHANNELS 顺序探测，第一个能拉到 latest.yml 的胜出，并写回设置；
 * - 全部失败：抛错，调用方决定提示方式。
 */
async function ensureChannel(): Promise<void> {
  if (activeChannel === null) {
    const saved = settings.get().updateChannel
    activeChannel = CHANNELS.includes(saved) ? saved : null
  }
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
      // 渠道验证成本高（坏渠道要等满超时才换下一个），必须跨启动记住
      void settings.set({ updateChannel: channel }).catch(() => undefined)
      return
    } catch (error) {
      failures.push(`${channel || '直连'}：${(error as Error).message?.slice(0, 80) ?? '未知错误'}`)
    }
  }
  throw new Error(`所有更新渠道均不可达。${failures.join('；')}`)
}

/** 把 electron-updater 的原始错误翻成能看懂的文案，并在确定性失败时给出兜底地址 */
function failureStatus(error: unknown): UpdateStatusView {
  const message = (error as Error)?.message ?? String(error)
  // 下载 404 几乎只有一种原因：latest.yml 指向的文件名与 Release 上的资产名不一致。
  // 这类错重试一百次还是 404，直接把「手动下载」的地址给用户，别让他困在英文文案里。
  const missingAsset = /404|not found|cannot download/i.test(message)
  return currentStatus('error', {
    message: missingAsset ? `安装包下载失败（HTTP 404）：${message.slice(0, 120)}` : message,
    ...(missingAsset ? { manualUrl: MANUAL_URL } : {})
  })
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
    // 渠道中途失效（镜像挂了/直连被断/桶被清）：忘掉当前选择——内存与设置一起清，
    // 否则下次启动还会「记住」这个死渠道，每次都失败在同一个地方
    activeChannel = null
    void settings.set({ updateChannel: '' }).catch(() => undefined)
    broadcast(failureStatus(error))
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
    return failureStatus(error)
  }
}

export function installUpdate(): void {
  if (!initialized) return
  // quitAndInstall 内部走 app.quit()。默认开着「关闭到托盘」时，主窗口的 close 会被
  // 拦成隐藏 → 退出流程走不完，安装器只能一直等进程结束。先置退出标记，让 close 放行。
  markQuitting()
  autoUpdater.quitAndInstall()
}
