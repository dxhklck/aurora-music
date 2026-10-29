/**
 * 音源性价比评分（换源调度用）。
 *
 * 只回答一个问题：**现在先试哪个源**。所以样本只记三件事——耗时、成没成——
 * 不记歌名、不落盘、不出报表。
 *
 * 评分 = 成功率 ÷ 中位耗时（秒）。样本不足时给中性分，否则一次 200ms 的运气
 * 就会把某个源顶到第一位。
 */

export interface SourceSample {
  /** 本次尝试耗时（毫秒），超时也计真实等待时间 */
  ms: number
  /** 是否拿到了可播放的结果 */
  ok: boolean
}

/** 少于这么多条样本时不下判断 */
const MIN_SAMPLES = 3
/** 中性分：没数据 / 样本不足时用它，排序时夹在好源与坏源之间 */
const NEUTRAL = 0.5
/** 中位耗时下限，防止 30ms 的缓存命中把分数除爆 */
const MIN_P50_MS = 250

export class SourceScoreboard {
  private stats = new Map<string, SourceSample[]>()
  /** 窗口长度。注意不能写成构造参数属性（`constructor(private readonly window = 20)`）——
   *  node 的 --experimental-strip-types 只擦类型不生成代码，参数属性会被判为不支持语法 */
  private readonly window: number

  constructor(window = 20) {
    this.window = window
  }

  record(source: string, ms: number, ok: boolean): void {
    const list = this.stats.get(source) ?? []
    list.push({ ms: Math.max(0, Math.round(ms)), ok })
    // 滑动窗口：坏样本会被新样本挤出去，源恢复后分数能自己爬回来
    if (list.length > this.window) list.splice(0, list.length - this.window)
    this.stats.set(source, list)
  }

  /** 成功率 ÷ 中位耗时（秒）。越大越值得先试 */
  score(source: string): number {
    const list = this.stats.get(source)
    if (!list || list.length < MIN_SAMPLES) return NEUTRAL
    const okCount = list.reduce((sum, item) => sum + (item.ok ? 1 : 0), 0)
    const rate = okCount / list.length
    return rate / (Math.max(this.p50(source) ?? MIN_P50_MS, MIN_P50_MS) / 1000)
  }

  /** 中位耗时；没有样本时返回 null */
  p50(source: string): number | null {
    const list = this.stats.get(source)
    if (!list || !list.length) return null
    const sorted = list.map((item) => item.ms).sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  }

  samples(source: string): number {
    return this.stats.get(source)?.length ?? 0
  }

}
