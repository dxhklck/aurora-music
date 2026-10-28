/**
 * Android 返回手势 / 返回键处理。
 *
 * 默认行为是 WebView.canGoBack() 为 false 时直接 finish Activity——本应用是
 * 单页应用，用户会被一按返回就踹出 App。这里按移动端惯例收敛为三层：
 *   1. 全屏覆盖层（歌词舞台 / 队列抽屉）先关
 *   2. WebView 有历史栈则路由回退
 *   3. 首页再按：2 秒内双击才退出（toast 提示）
 *
 * 经 Capacitor 全局插件代理调用原生 AppPlugin（@capacitor/app 的原生模块，
 * MainActivity 已手工注册）——不直接 import npm 包，避免桌面 bundle 引入移动端依赖。
 */
import { useAppStore } from '../stores/app'
import { usePlayerStore } from '../stores/player'

interface CapAppPlugin {
  addListener?: (event: string, cb: (e: { canGoBack: boolean }) => void) => unknown
  exitApp?: () => void
}

function appPlugin(): CapAppPlugin | null {
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } }).Capacitor
  return (cap?.Plugins?.App as CapAppPlugin) ?? null
}

export async function installAndroidBackButton(): Promise<void> {
  const plugin = appPlugin()
  if (!plugin?.addListener) return
  let lastBackAt = 0
  plugin.addListener('backButton', ({ canGoBack }) => {
    const player = usePlayerStore()
    if (player.showNowPlaying) {
      player.showNowPlaying = false
      return
    }
    if (player.showQueue) {
      player.showQueue = false
      return
    }
    if (canGoBack) {
      window.history.back()
      return
    }
    const now = Date.now()
    if (now - lastBackAt < 2000) {
      plugin.exitApp?.()
      return
    }
    lastBackAt = now
    useAppStore().toast('再按一次退出', 'info')
  })
}
