import { cleanText, md5Hex, normalizeForMatch, toInt } from './text'
import type { SongInfo } from './types'

/**
 * 进程内缓存：token 句柄、搜索结果、同 key 并发合并。
 *
 * 三者的作用各不相同，别混在一起看：
 *
 * - **token**：把已解析好的 SongInfo 留在内存，播放时不必再搜一遍。引擎重启会
 *   丢 token，所以另有 `pickBest` 按元信息重新定位同一首歌；
 * - **搜索缓存**：同一关键词 180 秒内直接返回，避免用户来回切页时反复打平台；
 * - **并发锁**：搜索页与「自动换源」可能同时请求同一个词，让后到的等前一个，
 *   不要重复打接口。
 */

const SEARCH_TTL_MS = 180_000
const SEARCH_CACHE_MAX = 200

const tokens = new Map<string, SongInfo>()
const tokenById = new Map<string, string>()

/**
 * 稳定 id：跨引擎重启不变。
 *
 * 缺少 identifier 时用「歌名|歌手|专辑」的 **md5 前 16 位**。本地库与歌单靠这个
 * id 做去重与引用，换一种算法会让同一首歌在升级前后被判成两首。
 */
export function stableId(song: SongInfo): string {
  // identifier 先按上游 `_clean` 归一：纯空白与 'NULL' 都视为没有 id
  const identifier = cleanText(song.identifier)
  if (identifier) return `${song.source}:${identifier}`
  const raw = `${song.songName}|${song.singers}|${song.album}`
  return `${song.source}:${md5Hex(raw).slice(0, 16)}`
}

let sequence = 0

/** 记住一首歌并返回句柄；同一首歌复用同一个 token */
export function remember(song: SongInfo): string {
  const id = stableId(song)
  let token = tokenById.get(id)
  if (!token) {
    sequence += 1
    token = `${Date.now().toString(36)}${sequence.toString(36)}`
    tokenById.set(id, token)
  }
  tokens.set(token, song)
  return token
}

export function recall(token: string): SongInfo | null {
  return tokens.get(token) ?? null
}

export function dropToken(token: string): void {
  const song = tokens.get(token)
  if (!song) return
  tokens.delete(token)
  const id = stableId(song)
  if (tokenById.get(id) === token) tokenById.delete(id)
}

/**
 * 模糊匹配：引擎重启后 token 失效，按「歌名 + 歌手 + 时长」重新定位。
 *
 * 打分规则沿用上游：歌名完全相同 60 分、包含 35 分；歌手命中 +30；
 * 时长差 5 秒内 +10、超过 30 秒 -15。低于 60 分视为没找到——
 * 这个阈值保证「只有歌名擦边匹配」的结果不会被误当成目标曲目。
 */
export function pickBest(target: { name?: string; artists?: string; durationMs?: number }, items: SongInfo[]): SongInfo | null {
  const name = normalizeForMatch(target.name ?? '')
  const artists = String(target.artists ?? '')
    .replace(/\//g, ',')
    .split(',')
    .map((item) => normalizeForMatch(item))
    .filter(Boolean)
  const duration = toInt(target.durationMs ?? 0)

  let best: SongInfo | null = null
  let bestScore = 0
  for (const item of items) {
    const itemName = normalizeForMatch(item.songName)
    if (!itemName) continue
    let score = 0
    if (itemName === name) score += 60
    else if (name && (name.includes(itemName) || itemName.includes(name))) score += 35
    else continue

    const singers = normalizeForMatch(item.singers)
    if (artists.length && artists.some((artist) => artist && (artist.includes(singers) || singers.includes(artist)))) {
      score += 30
    }
    if (duration && item.durationS) {
      const diff = Math.abs(item.durationS * 1000 - duration)
      if (diff < 5000) score += 10
      else if (diff > 30_000) score -= 15
    }
    if (score > bestScore) {
      best = item
      bestScore = score
    }
  }
  return bestScore >= 60 ? best : null
}

interface CacheEntry {
  at: number
  value: unknown
}

const searchCache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<unknown>>()

export function readSearchCache<T>(key: string): T | null {
  const entry = searchCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.at >= SEARCH_TTL_MS) {
    searchCache.delete(key)
    return null
  }
  return entry.value as T
}

export function writeSearchCache(key: string, value: unknown): void {
  searchCache.set(key, { at: Date.now(), value })
  if (searchCache.size <= SEARCH_CACHE_MAX) return
  // 超限时淘汰最旧的一条（等价上游按时间戳取 min 后 pop）
  let oldestKey = ''
  let oldestAt = Number.POSITIVE_INFINITY
  for (const [entryKey, entry] of searchCache) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at
      oldestKey = entryKey
    }
  }
  if (oldestKey) searchCache.delete(oldestKey)
}

/**
 * 同一个 key 的并发请求合并：先到的执行，后到的等它的结果。
 * 注意任务本身失败时要把锁清掉，否则后续请求会一直拿到同一个失败结果。
 */
export function withSearchLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const promise = task().finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

export function clearCaches(): void {
  tokens.clear()
  tokenById.clear()
  searchCache.clear()
  inflight.clear()
}
