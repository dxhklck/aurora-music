import type { App } from 'vue'

/**
 * 渲染层错误上报。
 *
 * 三个入口都要拦：Vue 组件内异常、全局 window.onerror（资源加载 / 事件回调）、
 * 未捕获的 Promise rejection（异步链路最常见的漏网之鱼）。
 *
 * 同一条错误 60 秒内只写一次：组件渲染循环里出错时，不节流会在几秒内刷出几千行，
 * 把真正重要的上下文挤出日志窗口。
 */

const COOLDOWN_MS = 60_000
const seen = new Map<string, number>()

function messageOf(error: unknown): string {
  if (error instanceof Error) return `${error.message}\n${error.stack ?? ''}`.trim()
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function reportError(scope: string, error: unknown, extra = ''): void {
  const message = `${extra ? `[${extra}] ` : ''}${messageOf(error)}`.slice(0, 6000)
  const key = `${scope}:${message.slice(0, 120)}`
  const now = Date.now()
  const last = seen.get(key) ?? 0
  if (now - last < COOLDOWN_MS) return
  seen.set(key, now)

  // 上报失败不能再抛错（比如 preload 尚未就绪），静默即可
  try {
    void window.api?.logWrite?.('error', scope, message).catch(() => undefined)
  } catch {
    /* ignore */
  }
  // 控制台留一份：Electron 里它会进主进程 stdout，排查现场时不用翻日志文件
  console.error(`[${scope}]`, error)
}

/** 给一个 Vue 应用实例装上全套兜底 */
export function installErrorReporting(app: App, scope = 'renderer'): void {
  app.config.errorHandler = (error, _instance, info) => {
    reportError(scope, error, info)
  }
  window.addEventListener('error', (event) => {
    // 资源加载失败没有 error 对象，只有 target，这类噪音不记
    if (!event.error && !event.message) return
    reportError(scope, event.error ?? event.message, `${event.filename}:${event.lineno}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    reportError(`${scope}:rejection`, event.reason)
  })
}
