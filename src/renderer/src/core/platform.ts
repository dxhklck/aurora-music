/**
 * 运行环境判断（渲染层共用）。
 *
 * Capacitor 原生容器（Android/iOS）= 移动端：桌面专属 UI
 * （窗口控制、桌面歌词、文件管理器选目录等）一律按此隐藏，
 * 避免用户点进「移动端开发中」的死按钮。
 */
type CapacitorGlobal = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

function capacitor(): CapacitorGlobal | undefined {
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
}

/** 是否 Capacitor 原生容器（Android/iOS 移动端） */
export function isNativeMobile(): boolean {
  return typeof window !== 'undefined' && capacitor()?.isNativePlatform?.() === true
}

/** 是否 Android 原生容器 */
export function isAndroidNative(): boolean {
  return isNativeMobile() && capacitor()?.getPlatform?.() === 'android'
}
