/**
 * 媒体代理地址。渲染进程不能直接带 Referer/Cookie 请求平台 CDN，
 * 因此统一走主进程注册的 muse:// 协议，由主进程补齐请求头并透传 Range。
 */
export const MEDIA_SCHEME = 'muse'

/**
 * URL 重写器（可选注入）。桌面版为 null——muse:// 交给 protocol.ts 处理；
 * 移动端桥（Capacitor）注入后把 muse:// 改写为 http://127.0.0.1:<port>/…，
 * 由原生本地代理接管（provider 代码零改动，音频与封面 URL 一次性全部生效）。
 */
let rewriter: ((url: string) => string) | null = null

export function setMediaUrlRewriter(fn: ((url: string) => string) | null): void {
  rewriter = fn
}

/** 远程资源（音频/图片）代理 */
export function mediaUrl(target: string, referer?: string): string {
  // 防重入：已经是代理地址（本地代理/CapacitorHttp 内部缓存）时不再包裹，
  // 否则会产生 media?u=http://127.0.0.1:47654/media?u=... 这种死链
  if (isMediaUrl(target) || /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(target)) {
    return target
  }
  const params = new URLSearchParams()
  params.set('u', target)
  if (referer) params.set('r', referer)
  const url = `${MEDIA_SCHEME}://media/?${params.toString()}`
  return rewriter ? rewriter(url) : url
}

/** 本地文件（演示音源、已下载歌曲、本地歌词） */
export function localUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://local/?p=${encodeURIComponent(filePath)}`
}

export function isMediaUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith(`${MEDIA_SCHEME}://`)
}
