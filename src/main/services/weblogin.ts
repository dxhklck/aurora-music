/**
 * 浏览器内登录。
 *
 * 与扫码、手动粘贴同一条合规底线：**不碰用户密码**——应用内开一个加载平台官网的
 * 窗口，用户像平时一样在网页里登录（密码只交给官网），主进程只从该窗口的会话里
 * 读 Cookie 落库，等价于用户在浏览器 F12 里复制粘贴，只是省了那几步。
 *
 * 实现要点：
 * - 每个平台一个独立 session partition，登录态不串台；成功后/关窗都清空该 partition。
 * - 轮询目标 Cookie 判断登录成功：QQ 看 qm_keyst / qqmusic_key，网易云看 MUSIC_U。
 * - 落库复用 settings.set + qrlogin 的 notifyLoginSuccess（provider 即时生效并广播）。
 * - 站点自己的登录弹窗（window.open）在同一窗口内接过来，不新开窗外泄到系统浏览器。
 */

import { BrowserWindow, session } from 'electron'
import { getMainWindow } from '../windows'
import { settings } from './settings'
import { notifyLoginSuccess } from './qrlogin'
import { isAllowedLoginUrl } from './login-guard'
import { IPC } from '@shared/ipc'
import type { QrLoginPlatform } from '@shared/types'

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

interface LoginSpec {
  /** 官网首页：登录入口由站点自己的 UI 给出，不猜具体登录页 URL */
  url: string
  /** 取 Cookie 的 URL */
  cookieUrl: string
  /** 任一存在且非空即视为登录成功 */
  successCookies: string[]
  name: string
}

const SPECS: Record<QrLoginPlatform, LoginSpec> = {
  qq: {
    url: 'https://y.qq.com/',
    cookieUrl: 'https://y.qq.com/',
    successCookies: ['qm_keyst', 'qqmusic_key'],
    name: 'QQ 音乐'
  },
  netease: {
    url: 'https://music.163.com/',
    cookieUrl: 'https://music.163.com/',
    successCookies: ['MUSIC_U'],
    name: '网易云音乐'
  }
}

/** 轮询间隔（ms） */
const POLL_INTERVAL = 1500

let loginWindow: BrowserWindow | null = null
let pollTimer: NodeJS.Timeout | null = null
let currentPlatform: QrLoginPlatform | null = null

function partitionOf(platform: QrLoginPlatform): string {
  return `login-${platform}`
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function clearPartition(platform: QrLoginPlatform): Promise<void> {
  // 登录态已取走，partition 里不留裸 Cookie
  await session.fromPartition(partitionOf(platform)).clearStorageData().catch(() => undefined)
}

async function captureCookie(spec: LoginSpec): Promise<string> {
  const cookies = await session.fromPartition(partitionOf(currentPlatform!)).cookies.get({ url: spec.cookieUrl })
  // 同名 Cookie 只保留一个；按名字排序保证落库值稳定可比对
  const seen = new Map<string, string>()
  for (const item of cookies) {
    if (item.value && !seen.has(item.name)) seen.set(item.name, `${item.name}=${item.value}`)
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, pair]) => pair).join('; ')
}

function report(platform: QrLoginPlatform, ok: boolean, message: string): void {
  getMainWindow()?.webContents.send(IPC.loginWindowResult, { platform, ok, message })
}

/** 打开（或聚焦）浏览器登录窗口 */
export async function openLoginWindow(platform: QrLoginPlatform): Promise<{ opened: boolean }> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    return { opened: true }
  }
  const spec = SPECS[platform]
  currentPlatform = platform

  // 登录窗只需要「把密码交给官网」，不该有任何设备权限。Electron 的默认行为是
  // **放行全部权限请求**，不显式关掉的话，登录页里的任意内容都能要摄像头/麦克风/定位。
  // 按 partition 单独设：defaultSession 的处理器不影响 fromPartition 出来的会话。
  session
    .fromPartition(partitionOf(platform))
    .setPermissionRequestHandler((_contents, _permission, done) => done(false))

  loginWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    parent: getMainWindow() ?? undefined,
    autoHideMenuBar: true,
    title: `${spec.name}登录`,
    webPreferences: {
      partition: partitionOf(platform),
      // 登录页就是普通网页，不需要 node 能力
      nodeIntegration: false,
      contextIsolation: true
    }
  })
  loginWindow.setMenu(null)

  // 站点自己的登录弹窗也在应用内接过来，不外泄到系统浏览器。
  // 但必须限定该平台自己的域：否则登录页里的任何脚本都能把窗口导航到任意地址，
  // 而那个页面继承着本 partition 里已经登录的 Cookie。
  // 取舍：第三方登录（微信/微博）会被挡住，只保留平台自己的账号密码登录。
  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedLoginUrl(platform, url)) void loginWindow?.loadURL(url)
    return { action: 'deny' }
  })

  // 渲染层自己发起的跳转同样走白名单（will-navigate 不拦 loadURL 与非主框架）
  loginWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedLoginUrl(platform, url)) event.preventDefault()
  })

  loginWindow.on('closed', () => {
    stopPolling()
    const platform = currentPlatform
    loginWindow = null
    currentPlatform = null
    if (platform) {
      void clearPartition(platform)
      report(platform, false, '登录窗口已关闭')
    }
  })

  void loginWindow.loadURL(spec.url, { userAgent: UA_PC })

  pollTimer = setInterval(() => {
    void (async () => {
      if (!currentPlatform || !loginWindow || loginWindow.isDestroyed()) return
      const cookies = await session
        .fromPartition(partitionOf(currentPlatform))
        .cookies.get({ url: SPECS[currentPlatform].cookieUrl })
        .catch(() => [])
      const loggedIn = SPECS[currentPlatform].successCookies.some(
        (name) => cookies.some((item) => item.name === name && item.value)
      )
      if (!loggedIn) return
      const cookie = await captureCookie(SPECS[currentPlatform])
      if (!cookie) return
      const platform = currentPlatform
      stopPolling()
      await settings.set(platform === 'qq' ? { qqCookie: cookie } : { neteaseCookie: cookie })
      notifyLoginSuccess(platform, cookie)
      loginWindow?.close()
      loginWindow = null
      currentPlatform = null
      void clearPartition(platform)
      report(platform, true, '登录成功')
    })()
  }, POLL_INTERVAL)

  return { opened: true }
}

/** 主动关闭浏览器登录窗口（用户点「取消」时由渲染层调用） */
export function closeLoginWindow(): void {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close()
  else {
    stopPolling()
    loginWindow = null
    currentPlatform = null
  }
}
