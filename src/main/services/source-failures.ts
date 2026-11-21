import type { SourceFailureView, SourceFailuresView } from '@shared/api'
import type { Song } from '@shared/types'
import type { ProviderErrorCode } from '../providers/types'

/**
 * 单曲播放失败记录。
 *
 * 与 source-health 不同：这里记「哪首歌在哪个源失败过、为什么」，只用于设置页解释
 * 「为什么刚才能播现在不能」，不参与平台级熔断。样本有界，不落盘。
 */
interface FailureEntry extends SourceFailureView {}

const MAX_PER_SONG = 3
const MAX_ITEMS = 60

/** 只有传输/解析类失败才进记录；版权/空结果/不支持是「这首歌的问题」 */
const CODES: ReadonlySet<ProviderErrorCode> = new Set(['network', 'parse'])

const entries = new Map<string, FailureEntry[]>()

const songKey = (song: Song): string => `${song.platform}:${song.id}`

export function recordFailure(
  song: Song,
  code: ProviderErrorCode,
  message: string,
  provider = song.platform,
  at = Date.now()
): void {
  if (!CODES.has(code)) return
  const key = songKey(song)
  const list = entries.get(key) ?? []
  const entry: FailureEntry = {
    key: `${key}:${provider}`,
    name: song.name,
    artists: [...song.artists],
    platform: provider || song.platform,
    code,
    message: String(message || '').slice(0, 200),
    at
  }
  const existing = list.findIndex((item) => item.platform === entry.platform && item.code === code)
  if (existing >= 0) list.splice(existing, 1)
  list.unshift(entry)
  if (list.length > MAX_PER_SONG) list.length = MAX_PER_SONG
  entries.set(key, list)

  if (entries.size > MAX_ITEMS) {
    const oldest = [...entries.entries()].sort(
      (a, b) => (b[1][0]?.at ?? 0) - (a[1][0]?.at ?? 0)
    )[MAX_ITEMS]
    if (oldest) entries.delete(oldest[0])
  }
}

export function clearFailures(): void {
  entries.clear()
}

/** 渲染层 catch 到的任意错误：只取 ProviderError 的结构化字段，避免把 Error 对象跨 IPC */
export function recordUnknownFailure(song: Song, error: unknown): void {
  const payload = error as { code?: ProviderErrorCode; provider?: string; message?: string } | null
  const code = payload?.code
  const message = payload?.message ?? (error instanceof Error ? error.message : String(error ?? ''))
  if (code && CODES.has(code)) recordFailure(song, code, message, payload?.provider)
}

export function snapshotFailures(preferLoggedIn = false): SourceFailuresView {
  const items = [...entries.values()]
    .flatMap((list) => list)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_ITEMS)
  return { items, preferLoggedIn }
}

/** 换源候选排序用：当前登录态优先，其次交给 scoreboard 判断 */
export function loggedInPriorities(cookies: { neteaseCookie?: string; qqCookie?: string }): string[] {
  const result: string[] = []
  if (cookies.neteaseCookie) result.push('netease')
  if (cookies.qqCookie) result.push('qq')
  return result
}
