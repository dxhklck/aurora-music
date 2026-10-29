/**
 * 引擎业务错误。
 *
 * 错误码被 `providers/musicdl.ts` 的 `toProviderError` 按 code 映射成用户可见文案，
 * 改一个码就会让「没版权」被显示成「网络错误」——增删错误码时必须同步改映射。
 *
 *   unsupported  未知音源 / 加密流 / 引擎能力不支持
 *   invalid      参数缺失
 *   blocked      平台接口异常（签名失效、被风控、接口变更）
 *   notfound     搜索成功但没有匹配曲目
 *   timeout      搜索超时
 *   internal     未捕获异常
 */
export class EngineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

/** HTTP 层失败：非 2xx，或传输中断 */
export class HttpError extends Error {
  readonly status: number
  readonly url: string

  constructor(status: number, url: string, message?: string) {
    super(message ?? `HTTP ${status}：${url}`)
    this.name = 'HttpError'
    this.status = status
    this.url = url
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  )
}
