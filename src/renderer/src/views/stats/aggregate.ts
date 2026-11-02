/**
 * 收听报告的聚合计算（纯函数）。
 *
 * 数据早就在 `stores/stats.ts` 里存着了（歌曲封顶 300 条、天数封顶 90 天），
 * 但界面只露出「本周最常听」8 首。这里把同一份数据换成几种看法：
 * 日历热力图、本月 Top N、来源分布、连续收听天数。
 *
 * 放纯函数是因为「日期边界」这类 bug 只能靠测试抓：
 * 本地日期不能用 toISOString（UTC 会让凌晨的记录记到前一天），
 * 跨月、跨年、补零都容易写错。
 */
import type { Song } from '@shared/types'

/** 只依赖用得到的字段，便于测试直接构造 */
export interface SongStatLike {
  count: number
  lastAt: number
  song: Song
}

export interface StatsSnapshot {
  songs: Record<string, SongStatLike>
  days: Record<string, number>
}

export interface DayPoint {
  /** `YYYY-MM-DD`（本地时区） */
  key: string
  /** 当日收听毫秒数，没听为 0 */
  ms: number
  /** 该格在热力图里属于第几周（0 = 最早），用于分列 */
  week: number
  /** 星期几：0 = 周日 … 6 = 周六 */
  weekday: number
}

export interface TopEntry {
  key: string
  song: Song
  count: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 本地日期键。**不用** toISOString：那是 UTC，凌晨的记录会记到前一天 */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * 最近 `count` 天的序列，按时间升序、包含今天，缺数据的日期补 0。
 *
 * `week` 是相对最早那天的周序号，供热力图排成列。
 */
export function lastDays(days: Record<string, number>, count: number, today = new Date()): DayPoint[] {
  const total = Math.max(1, Math.trunc(count))
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const points: DayPoint[] = []
  for (let offset = total - 1; offset >= 0; offset -= 1) {
    const date = new Date(base.getTime() - offset * DAY_MS)
    const key = dayKey(date)
    const index = total - 1 - offset
    points.push({
      key,
      ms: Math.max(0, days[key] ?? 0),
      week: Math.floor(index / 7),
      weekday: date.getDay()
    })
  }
  return points
}

/** 最近 `sinceDays` 天内的 Top N（按次数，次数相同则最近听过的靠前） */
export function topSongs(
  songs: Record<string, SongStatLike>,
  limit: number,
  sinceDays: number,
  now = Date.now()
): TopEntry[] {
  const cutoff = now - Math.max(1, sinceDays) * DAY_MS
  return Object.entries(songs)
    .filter(([, stat]) => stat.lastAt >= cutoff)
    .map(([key, stat]) => ({ key, song: stat.song, count: stat.count, lastAt: stat.lastAt }))
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, Math.max(0, Math.trunc(limit)))
    .map(({ key, song, count }) => ({ key, song, count }))
}

/** 按来源统计播放次数，降序 */
export function platformBreakdown(
  songs: Record<string, SongStatLike>
): Array<{ platform: string; count: number }> {
  const totals = new Map<string, number>()
  for (const stat of Object.values(songs)) {
    const platform = stat.song.platform || 'unknown'
    totals.set(platform, (totals.get(platform) ?? 0) + stat.count)
  }
  return [...totals.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count)
}

/** 有收听的日历天数 */
export function activeDays(days: Record<string, number>): number {
  return Object.values(days).filter((ms) => ms > 0).length
}

/**
 * 连续收听天数：从今天往回数，遇到没听的那天就停。
 * 今天还没听不算断（一天才过了一半），从昨天开始数。
 */
export function listenStreak(days: Record<string, number>, today = new Date()): number {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  let streak = 0
  // 今天没听时从昨天起算；今天听了就包含今天
  let cursor = (days[dayKey(base)] ?? 0) > 0 ? 0 : 1
  while (cursor < 400) {
    const date = new Date(base.getTime() - cursor * DAY_MS)
    if ((days[dayKey(date)] ?? 0) <= 0) break
    streak += 1
    cursor += 1
  }
  return streak
}

/** 一天里最常听的那个小时由心跳决定，这里只给日总量格式化 */
export function formatListenTime(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}
