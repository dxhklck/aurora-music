/**
 * AbortSignal.timeout 垫片（仅移动端桥加载）。
 *
 * 音源适配器（netease/qq/kuwo/catalog）从 Electron 主进程搬进 WebView 复用，
 * 主进程是 Node 20，`AbortSignal.timeout`（Chrome 103+ 才有）在 Android 9
 * 老 WebView（Chromium 66）上不存在——网易云搜索等所有带超时的请求会在
 * 发出前直接抛 TypeError。这里在缺失时补一个 AbortController 实现，
 * 语义对齐：到时 abort，abort reason 为 TimeoutError DOMException。
 */

if (typeof AbortSignal !== 'undefined' && typeof (AbortSignal as unknown as Record<string, unknown>).timeout !== 'function') {
  ;(AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = function (ms: number): AbortSignal {
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'))
    }, Math.max(0, ms))
    return controller.signal
  }
}

export {}
