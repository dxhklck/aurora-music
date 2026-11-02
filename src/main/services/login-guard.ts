/**
 * 登录窗的导航白名单。
 *
 * 为什么需要：登录窗加载的是真实站点（y.qq.com / music.163.com），站点自己的脚本
 * 可以触发 window.open。原来的实现把这个 URL 直接 `loadURL` 到同一个窗口 —— 于是
 * 任意页面都能顶替登录页，而它继承着该 partition 里已经登录的 Cookie。
 *
 * 规则用「域名后缀」而不是逐个列子域：登录链路会经过 ptlogin2.qq.com、
 * xui.ptlogin2.qq.com、graph.qq.com 等多个子域，逐个列举必然漏，漏一个就是
 * 用户登不上。这里只做「是不是这个平台自己的域」这个粗粒度判断。
 *
 * 单独成文件是为了能单测：weblogin.ts 依赖 electron，直接 import 会拖起整个 Electron。
 */
import type { QrLoginPlatform } from '@shared/types'

/** 每个平台允许的根域；子域自动放行 */
const ALLOWED_SUFFIX: Record<QrLoginPlatform, readonly string[]> = {
  qq: ['qq.com'],
  netease: ['163.com']
}

/**
 * 这个 URL 是否允许在登录窗里打开。
 *
 * 只放行 http(s) 与上述根域（含子域）。`evilqq.com` 这类「后缀像但不是子域」的
 * 域名必须被挡住，所以判断用 `.qq.com` 而不是 `endsWith('qq.com')`。
 */
export function isAllowedLoginUrl(platform: QrLoginPlatform, rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  // 允许 http 是因为部分登录跳转历史上走过明文；域名白名单才是主要防线
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  return ALLOWED_SUFFIX[platform].some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`)
  )
}
