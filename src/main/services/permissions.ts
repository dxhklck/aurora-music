/**
 * 权限判定（纯函数，无 Electron 依赖，方便 Node 单测守着）。
 *
 * 两个权限 handler 的 details **不是同一个结构**，这点是 Electron 45 的 .d.ts 里写的：
 * - setPermissionRequestHandler → MediaAccessPermissionRequest.mediaTypes: Array<'video'|'audio'>
 * - setPermissionCheckHandler  → PermissionCheckHandlerHandlerDetails.mediaType: 'video'|'audio'|'unknown'
 *
 * 曾经把两者统一按单数 mediaType 读，request handler 里恒为 undefined，
 * 导致 getUserMedia({ audio: true }) 被拒 → 听歌识曲的「麦克风」入口整个不可用。
 * 系统声音走 display-capture 分支，不受影响，所以实测时没暴露。
 */

/** setPermissionRequestHandler 的 details：mediaTypes 是数组 */
export function requestMediaTypes(details: unknown): string[] {
  if (!details || typeof details !== 'object' || !('mediaTypes' in details)) return []
  const value = (details as { mediaTypes?: unknown }).mediaTypes
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** setPermissionCheckHandler 的 details：mediaType 是单数字符串 */
export function checkMediaType(details: unknown): string | undefined {
  if (!details || typeof details !== 'object' || !('mediaType' in details)) return undefined
  const value = (details as { mediaType?: unknown }).mediaType
  return typeof value === 'string' ? value : undefined
}

/**
 * 本项目只放行三样：
 * - speaker-selection：选音频输出设备（拒了 enumerateDevices 就只剩「系统默认」）
 * - media 的**纯音频**：听歌识曲读麦克风
 * - display-capture：听歌识曲抓系统输出，且只给主窗口
 * 其余（摄像头/定位/通知/串口/HID，以及 media 里的视频）全部拒绝。
 */
export function permissionAllowed(
  permission: string,
  media: string[],
  isMainWindow: boolean
): boolean {
  if (permission === 'speaker-selection') return true
  if (permission === 'media') return media.length > 0 && media.every((type) => type === 'audio')
  if (permission === 'display-capture') return isMainWindow
  return false
}
