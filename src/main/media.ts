/**
 * 媒体代理地址。渲染进程不能直接带 Referer/Cookie 请求平台 CDN，
 * 因此统一走主进程注册的 muse:// 协议，由主进程补齐请求头并透传 Range。
 */
export const MEDIA_SCHEME = 'muse'

/** 远程资源（音频/图片）代理 */
export function mediaUrl(target: string, referer?: string): string {
  const params = new URLSearchParams()
  params.set('u', target)
  if (referer) params.set('r', referer)
  return `${MEDIA_SCHEME}://media/?${params.toString()}`
}

/** 本地文件（演示音源、已下载歌曲、本地歌词） */
export function localUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://local/?p=${encodeURIComponent(filePath)}`
}

export function isMediaUrl(url: string): boolean {
  return typeof url === 'string' && url.startsWith(`${MEDIA_SCHEME}://`)
}
