/**
 * 平台登录态（Cookie）运行时仓库。
 *
 * 设计约束：
 * - Aurora 不内置任何账号；Cookie 只可能来自用户在设置里粘贴的自己登录态，
 *   因此这里只是一个「当前生效值」的内存容器 + 请求头拼装 helper。
 * - 音源适配器在每次请求时读取（baseHeaders 里拼），所以设置变更后即时生效，
   不需要重建 provider 实例。
 */

let qqCookie = ''
let neteaseCookie = ''

/** 设置变更时调用；传 undefined 的字段保持原值 */
export function setProviderCookies(next: { qq?: string; netease?: string }): void {
  if (next.qq !== undefined) qqCookie = normalizeCookie(next.qq)
  if (next.netease !== undefined) neteaseCookie = normalizeCookie(next.netease)
}

export function getProviderCookies(): { qq: string; netease: string } {
  return { qq: qqCookie, netease: neteaseCookie }
}

/** QQ 音乐请求头（未配置时返回空对象，不给匿名请求加多余的 Cookie） */
export function qqCookieHeader(): Record<string, string> {
  return qqCookie ? { Cookie: qqCookie } : {}
}

export function neteaseCookieHeader(): Record<string, string> {
  return neteaseCookie ? { Cookie: neteaseCookie } : {}
}

/**
 * 从 QQ Cookie 里取 uin。vkey 接口的 uin 与 Cookie 不一致时，
 * VIP 曲目仍然拿不到播放地址，所以登录态下必须回填真实 uin。
 * 支持 `uin=o12345678`（前端常见）与 `uin=12345678` 两种写法。
 */
export function extractQQUin(cookie = qqCookie): string {
  const match = cookie.match(/(?:^|;\s*)uin=o?(\d{3,})/i)
  return match ? match[1] : ''
}

/** 统一换行/首尾空白，避免用户粘贴时带进 \r\n 把请求头搞坏 */
function normalizeCookie(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}
