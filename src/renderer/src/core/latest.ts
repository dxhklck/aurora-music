/**
 * 只认最新一次的异步结果。
 *
 * 取址、搜索都是「发请求 → 等 → 落地」的形态。用户连点时会同时有多个请求在飞，
 * 完成顺序不保证等于发出顺序；后完成的旧请求若照常落地，就会覆盖新状态
 * （表现为「点了 B 却在放 A」「关键词是 B 列表是 A」）。
 *
 * 这里只提供「领号 / 校验 / 作废」三件事，编号不承载任何业务语义。
 */
export interface LatestGate {
  /** 领一个新号；本次请求之后领号的一律更新 */
  next(): number
  /** 当前号（只想「跟随」最新一次请求时用，例如翻页；不要用它领号） */
  current(): number
  /** 这个号是否仍是最新的 */
  isCurrent(token: number): boolean
  /** 作废所有在途请求（停止播放、重置搜索时用） */
  invalidate(): void
}

export function createLatestGate(): LatestGate {
  let token = 0
  return {
    next: () => {
      token += 1
      return token
    },
    current: () => token,
    isCurrent: (value: number) => value === token,
    invalidate: () => {
      token += 1
    }
  }
}
