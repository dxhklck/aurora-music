/**
 * 原生媒体面板桥（Android 前台服务 + MediaSession，C3）。
 *
 * WebView 里 Web MediaSession 不可靠（通知栏不出媒体控件、锁屏即被冻结），
 * 播放状态与系统级控制改走 Capacitor 插件 AuroraMedia → 原生前台服务。
 * 桌面环境没有该插件，所有导出函数都是 no-op，player.ts 无条件调用即可。
 */

interface NativeMediaInfo {
  title: string
  artist: string
  album: string
  cover: string | null
  playing: boolean
  /** 当前播放位置（毫秒）：锁屏/通知进度条展示与 SEEK_TO 回跳基准 */
  positionMs?: number
}

interface ControlEvent {
  action?: string
  position?: number
}

type ControlHandlers = {
  toggle: () => void
  next: () => void
  prev: () => void
  /** 明确的播放/暂停意图（耳机线控/蓝牙），避免 toggle 语义翻转错乱 */
  play?: () => void
  pause?: () => void
  /** 锁屏进度条拖动 */
  seek?: (positionMs: number) => void
}

let controlHandlers: ControlHandlers | null = null
let bound = false

function plugin(): {
  session?: (info: NativeMediaInfo) => unknown
  addListener?: (event: string, cb: (e: ControlEvent) => void) => unknown
} | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  return (cap?.Plugins?.AuroraMedia as never) ?? null
}

/** 把当前曲目元数据与播放状态同步到原生通知栏媒体面板 */
export function syncNativeMedia(info: NativeMediaInfo): void {
  try {
    plugin()?.session?.(info)
  } catch {
    /* 原生层异常不影响播放 */
  }
}

/** 注册系统媒体控制回调（通知按钮 / 耳机线控 / 蓝牙 / 锁屏拖动），由 player store 提供动作 */
export function bindNativeMediaControl(handlers: ControlHandlers): void {
  controlHandlers = handlers
  const p = plugin()
  if (!p?.addListener || bound) return
  bound = true
  p.addListener('control', (event: ControlEvent) => {
    const action = event?.action
    if (action === 'toggle' || action === 'next' || action === 'prev') {
      controlHandlers?.[action]?.()
    } else if (action === 'play') {
      controlHandlers?.play?.()
    } else if (action === 'pause') {
      controlHandlers?.pause?.()
    } else if (action === 'seek') {
      const position = Number(event?.position ?? 0)
      if (Number.isFinite(position)) controlHandlers?.seek?.(position)
    }
  })
}
