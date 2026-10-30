import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Song } from '@shared/types'
import { usePlayerStore } from './player'

/**
 * 收听统计：只记「谁听了多少次、哪天听了多久」两件事。
 * - songs：按 platform:id 聚合播放次数（点开即记，在播放成功点埋）
 * - days：按本地日期聚合收听时长（15 秒心跳，仅在真正出声时累计）
 * 数据量可控（歌曲封顶 300 条 / 天数封顶 90 条），localStorage 足够。
 */
const STATS_KEY = 'aurora.stats'
/** 心跳步长（毫秒）：颗粒度 15 秒，够用且不打扰 */
const HEARTBEAT_MS = 15_000
const MAX_SONGS = 300
const MAX_DAYS = 90
/** 一周口径：7 天内有收听的歌才进「本周最常听」 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

interface SongStat {
  /** 播放次数 */
  count: number
  /** 最近一次播放时间戳（周榜按它过滤） */
  lastAt: number
  /** 重建 Song 用的最小元数据 */
  song: Pick<Song, 'id' | 'platform' | 'name' | 'artists' | 'album' | 'coverUrl' | 'duration'>
}

interface StatsData {
  songs: Record<string, SongStat>
  /** 本地日期 → 当日收听毫秒数 */
  days: Record<string, number>
}

function emptyData(): StatsData {
  return { songs: {}, days: {} }
}

function load(): StatsData {
  try {
    const raw = localStorage.getItem(STATS_KEY)
    if (!raw) return emptyData()
    const parsed = JSON.parse(raw) as StatsData
    if (!parsed.songs || !parsed.days) return emptyData()
    return parsed
  } catch {
    return emptyData()
  }
}

/** 本地日期键（不用 toISOString：那是 UTC，凌晨统计会记错天） */
function dayKey(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 修剪：歌取最近 300 首，天留最近 90 天，防 localStorage 无限膨胀 */
function trim(data: StatsData): void {
  const songEntries = Object.entries(data.songs)
  if (songEntries.length > MAX_SONGS) {
    songEntries.sort((a, b) => b[1].lastAt - a[1].lastAt)
    data.songs = Object.fromEntries(songEntries.slice(0, MAX_SONGS))
  }
  const dayEntries = Object.entries(data.days).sort(([a], [b]) => (a < b ? 1 : -1))
  if (dayEntries.length > MAX_DAYS) {
    data.days = Object.fromEntries(dayEntries.slice(0, MAX_DAYS))
  }
}

export const useStatsStore = defineStore('stats', () => {
  const data = ref<StatsData>(load())
  let heartbeat: number | null = null

  function persist(): void {
    trim(data.value)
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(data.value))
    } catch {
      /* 写不进去就只在内存里记着，不影响播放 */
    }
  }

  /** 播放成功点调用（player store 埋）：次数 +1，并启动时长心跳 */
  function recordPlay(song: Song): void {
    const key = `${song.platform}:${song.id}`
    const prev = data.value.songs[key]
    data.value.songs[key] = {
      count: (prev?.count ?? 0) + 1,
      lastAt: Date.now(),
      song: {
        id: song.id,
        platform: song.platform,
        name: song.name,
        artists: song.artists,
        album: song.album,
        coverUrl: song.coverUrl,
        duration: song.duration
      }
    }
    persist()
    startHeartbeat()
  }

  function addListen(ms: number): void {
    const key = dayKey()
    data.value.days[key] = (data.value.days[key] ?? 0) + ms
    // 心跳不需要每次落盘，10 次一写（2.5 分钟）足够，减少 localStorage 抖动
    const n = data.value.days[key]
    if (n % (HEARTBEAT_MS * 10) === 0 || n < HEARTBEAT_MS * 2) persist()
  }

  /** 出声才算听：暂停/加载中/等待缓冲都不计 */
  function startHeartbeat(): void {
    if (heartbeat !== null) return
    heartbeat = window.setInterval(() => {
      const player = usePlayerStore()
      if (player.playing && !player.loading && !player.waiting && !player.error) {
        addListen(HEARTBEAT_MS)
      }
    }, HEARTBEAT_MS)
  }

  /** 累计收听时长（毫秒） */
  const totalListenMs = computed(() =>
    Object.values(data.value.days).reduce((sum, n) => sum + n, 0)
  )

  /** 今天听了多久（毫秒） */
  const todayListenMs = computed(() => data.value.days[dayKey()] ?? 0)

  /** 本周最常听：7 天内播过的歌按次数排序，取前 8 */
  const weeklyTop = computed<Song[]>(() => {
    const cutoff = Date.now() - WEEK_MS
    return Object.values(data.value.songs)
      .filter((item) => item.lastAt >= cutoff)
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, 8)
      .map((item) => ({ ...item.song }))
  })

  return { data, recordPlay, totalListenMs, todayListenMs, weeklyTop }
})
