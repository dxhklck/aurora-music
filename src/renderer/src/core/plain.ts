/**
 * Vue 的 reactive Proxy 无法通过 Electron 的结构化克隆（会抛 "An object could not be cloned"）。
 * 所有跨进程传递的对象参数先转成纯数据。
 */
export function plain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return JSON.parse(JSON.stringify(value)) as T
}
