import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Lyric, PlayMode, Song } from '@shared/types'
import { findLyricIndex } from '@shared/lyric'
import { audio } from '../core/audio'
import { plain } from '../core/plain'
import { friendlyError } from '../core/error'
import { useAppStore } from './app'
import { useStatsStore } from './stats'
import { createLatestGate } from '../core/latest'

const HISTORY_KEY = 'aurora.recent'
/** 榜单队列断点：记录「哪份榜单 + 第几首 + 播到几毫秒」，跨重启续播 */
const RESUME_KEY = 'aurora.hero.resume'
/** 歌词手动对齐记忆：{ "platform:id": 毫秒偏移 }，只记用户调过的歌 */
const LYRIC_OFFSET_KEY = 'aurora.lyric-offsets'

interface ResumeSnapshot {
  tag: string
  index: number
  time: number
  at: number
}

function loadResume(): ResumeSnapshot | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY)
    return raw ? (JSON.parse(raw) as ResumeSnapshot) : null
  } catch {
    return null
  }
}

/** 音源可能返回 name 缺失或字面 "Undefined" 的脏数据：入队前统一兜底 */
function sanitizeSongs(songs: Song[]): Song[] {
  return songs.map((song) =>
    !song.name || song.name.toLowerCase() === 'undefined'
      ? { ...song, name: '未知曲目' }
      : song
  )
}

export const usePlayerStore = defineStore('player', () => {
  const queue = ref<Song[]>([])
  const index = ref(-1)
  const playing = ref(false)
  const loading = ref(false)
  const waiting = ref(false)
  const error = ref('')
  const notice = ref('')
  const time = ref(0)
  const duration = ref(0)
  const buffered = ref(0)
  const volume = ref(0.75)
  const muted = ref(false)
  const mode = ref<PlayMode>('loop')
  const lyric = ref<Lyric | null>(null)
  const lyricLoading = ref(false)
  /** 用户微调的歌词偏移（毫秒），按歌记忆，见 LYRIC_OFFSET_KEY */
  const lyricOffsetAdj = ref(0)
  const streamLabel = ref('')
  /** 实际播放的曲目（可能与队列里的原平台不同：换源后） */
  const resolvedSong = ref<Song | null>(null)
  const showNowPlaying = ref(false)
  const showQueue = ref(false)
  const recent = ref<Song[]>(loadRecent())
  /** 当前队列的来源标签（如 hero:qq:榜id）；空 = 普通队列，不记断点 */
  const queueTag = ref('')

  /* ---------------- 睡眠定时 ----------------
     15/30/60 分钟倒计时，或「播完当前这首」。
     到点只暂停不 stop：队列与进度保留，第二天点播放能接着听。 */
  const sleepMode = ref<'off' | '15' | '30' | '60' | 'eof'>('off')
  /** 剩余秒数；eof 模式恒为 -1（表示按曲目结束触发） */
  const sleepRemain = ref(0)
  let sleepTick: number | null = null

  let engineBound = false
  let volumeTimer: number | null = null
  /** 原生媒体面板位置同步节流 */
  let lastNativeSync = 0
  /** 连续播放失败计数：用于自动跳过损坏/无版权曲目，避免无限连跳 */
  let failureStreak = 0
  /** 停滞自愈进度：0 未发生 / 1 已同源重取 / 2 已跨源（同一首歌最多两段，防循环） */
  let stallCount = 0
  /** startHero 续播时要跳转的毫秒数，等 duration 就绪后消费 */
  let pendingSeek: number | null = null
  let lastResumeSave = 0
  /**
   * 播放入口门闩。取址是网络请求（引擎音源要几秒），连点两首歌时后发的请求可能先回来，
   * 先发的后回来就会把正在放的那首顶掉。每次 playAt 领号，await 之后校验。
   */
  const playGate = createLatestGate()

  const current = computed<Song | null>(() =>
    index.value >= 0 ? queue.value[index.value] ?? null : null
  )
  const displaySong = computed<Song | null>(() => current.value ?? resolvedSong.value)
  const hasNext = computed(() => queue.value.length > 1)
  const progress = computed(() => (duration.value ? Math.min(time.value / duration.value, 1) : 0))
  const activeLyricIndex = computed(() =>
    lyric.value ? findLyricIndex(lyric.value.lines, time.value + totalLyricOffset.value) : -1
  )
  /** 源偏移 + 用户微调的合成偏移（毫秒）；LyricPane 与这里共用，保证两处节奏一致 */
  const totalLyricOffset = computed(
    () => (lyric.value?.offset ?? 0) + lyricOffsetAdj.value
  )

  function loadRecent(): Song[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY)
      return raw ? (JSON.parse(raw) as Song[]) : []
    } catch {
      return []
    }
  }

  function pushRecent(song: Song): void {
    const next = [song, ...recent.value.filter((item) => !(item.id === song.id && item.platform === song.platform))]
    recent.value = next.slice(0, 24)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(recent.value))
  }

  function bindEngine(): void {
    if (engineBound) return
    engineBound = true
    audio.on('time', (value: number) => {
      time.value = value
      // 断点快照：5 秒一记，只在带标签的队列（首页榜单）下生效
      if (queueTag.value && Date.now() - lastResumeSave > 5000) {
        lastResumeSave = Date.now()
        saveResume()
      }
      // 系统媒体面板（MediaSession）状态同步：5 秒一推即可
      if (Date.now() - lastNativeSync > 5000) {
        lastNativeSync = Date.now()
        syncPlaybackState(playing.value)
      }
    })
    audio.on('duration', (value: number) => {
      duration.value = value
      // 续播跳转：load() 时 duration 还没就绪，seek 会被忽略，必须等这一刻
      if (pendingSeek != null && value > 0) {
        audio.seek(pendingSeek)
        time.value = pendingSeek
        pendingSeek = null
      }
    })
    audio.on('buffered', (value: number) => {
      buffered.value = value
    })
    audio.on('playing', (value: boolean) => {
      playing.value = value
      // 同步给系统媒体面板（Windows SMTC 等），暂停/播放状态要跟手
      syncPlaybackState(value)
    })
    audio.on('waiting', (value: boolean) => {
      waiting.value = value
    })
    audio.on('ended', () => {
      void handleEnded()
    })
    audio.on('error', (message: string) => {
      error.value = message
      playing.value = false
    })
    audio.on('stall', () => {
      waiting.value = false
      playing.value = false
      const song = displaySong.value
      if (!song) return
      // 数据流停滞（连接正常但数据不来）两段式自愈：
      // 第一次重取原平台地址（可能只是 CDN 抽风），第二次强制跨平台换源
      if (stallCount === 0) {
        stallCount = 1
        useAppStore().toast(`《${song.name}》网络停滞，正在自动重试…`, 'info')
        void playAt(index.value, { isRetry: true })
        return
      }
      if (stallCount === 1) {
        stallCount = 2
        useAppStore().toast(`《${song.name}》重试仍停滞，正在自动换源…`, 'info')
        void playAt(index.value, { isRetry: true, forceSwitch: true })
        return
      }
      error.value = '音频流停滞：重试与换源后仍无数据，请检查网络或手动切换音源'
    })
  }

  async function playAt(
    target: number,
    opts: { isRetry?: boolean; forceSwitch?: boolean } = {}
  ): Promise<void> {
    const song = queue.value[target]
    if (!song) return
    const app = useAppStore()
    bindEngine()
    const token = playGate.next()
    if (!opts.isRetry) stallCount = 0
    index.value = target
    loading.value = true
    error.value = ''
    notice.value = ''
    time.value = 0
    duration.value = 0
    buffered.value = 0
    lyric.value = null
    try {
      const resolved = await window.api.resolveTrack({
        song: plain(song),
        autoSwitch: app.settings?.autoSwitchSource !== false,
        forceSwitch: opts.forceSwitch === true
      })
      // 期间用户又点了别的歌：这次的结果已经过期，丢弃，别把正在放的那首顶掉
      if (!playGate.isCurrent(token)) return
      resolvedSong.value = sanitizeSongs([resolved.song])[0]
      streamLabel.value = resolved.stream.label
      if (resolved.switchedFrom) {
        notice.value = resolved.notice ?? '已自动切换音源'
        window.setTimeout(() => {
          notice.value = ''
        }, 6000)
      }
      audio.load(resolved.stream.url, { autoplay: true })
      failureStreak = 0
      pushRecent(song)
      // 收听统计：与最近播放同一个成功点（拿到流并开始播放才记）
      useStatsStore().recordPlay(song)
      void loadLyric(resolved.song)
      updateMediaSession(song)
    } catch (err) {
      // 过期请求的失败不该报错、也不该触发自动跳过（用户已经去点别的歌了）
      if (!playGate.isCurrent(token)) return
      error.value = friendlyError(err)
      playing.value = false
      failureStreak += 1
      // 一首歌播不了就自动跳下一首，连续 3 次失败后停下来等用户处理
      if (failureStreak <= 3 && queue.value.length > 1) {
        useAppStore().toast(`《${song.name}》无法播放，已自动跳过`, 'error')
        window.setTimeout(() => {
          void next(false)
        }, 900)
      }
    } finally {
      if (playGate.isCurrent(token)) loading.value = false
    }
  }

  /* ---------------- 歌词手动对齐 ----------------
     源给的歌词整体偏早/偏晚时 ±0.5s 微调，按 platform:id 记住。
     与 lyric.offset 相加后统一生效，正数 = 歌词提前。 */

  function loadLyricOffsetAdj(song: Song): number {
    try {
      const map = JSON.parse(localStorage.getItem(LYRIC_OFFSET_KEY) ?? '{}') as Record<string, number>
      return map[`${song.platform}:${song.id}`] ?? 0
    } catch {
      return 0
    }
  }

  /** 微调当前歌的歌词偏移（毫秒），范围 ±5s，落盘记忆 */
  function nudgeLyric(delta: number): void {
    const song = current.value
    if (!song) return
    setLyricOffset(lyricOffsetAdj.value + delta)
  }

  /** 复位当前歌的歌词偏移（回到源偏移） */
  function resetLyricOffset(): void {
    setLyricOffset(0)
  }

  function setLyricOffset(ms: number): void {
    const song = current.value
    if (!song) return
    lyricOffsetAdj.value = Math.min(5000, Math.max(-5000, Math.round(ms)))
    try {
      const map = JSON.parse(localStorage.getItem(LYRIC_OFFSET_KEY) ?? '{}') as Record<string, number>
      const key = `${song.platform}:${song.id}`
      if (lyricOffsetAdj.value === 0) delete map[key]
      else map[key] = lyricOffsetAdj.value
      localStorage.setItem(LYRIC_OFFSET_KEY, JSON.stringify(map))
    } catch {
      /* localStorage 满 / 被禁用：微调仅本次生效 */
    }
  }

  async function loadLyric(song: Song): Promise<void> {
    lyricLoading.value = true
    lyricOffsetAdj.value = loadLyricOffsetAdj(song)
    try {
      lyric.value = await window.api.lyric(plain(song))
    } catch {
      lyric.value = null
    } finally {
      lyricLoading.value = false
    }
  }

  function saveResume(): void {
    if (!queueTag.value || index.value < 0) return
    try {
      localStorage.setItem(
        RESUME_KEY,
        JSON.stringify({
          tag: queueTag.value,
          index: index.value,
          time: Math.round(time.value),
          at: Date.now()
        } satisfies ResumeSnapshot)
      )
    } catch {
      /* 存储失败不影响播放 */
    }
  }

  function setQueue(songs: Song[], startIndex = 0, tag = ''): void {
    queue.value = sanitizeSongs([...songs])
    queueTag.value = tag
    if (queue.value.length) void playAt(Math.max(0, Math.min(startIndex, queue.value.length - 1)))
  }

  /**
   * 首页「立即播放」：带标签建队列；localStorage 里有同一标签的断点
   * （跨重启）就直接从上次那首那一秒继续。
   */
  async function startHero(
    songs: Song[],
    tag: string
  ): Promise<{ resumed: boolean; song: Song | null }> {
    queue.value = sanitizeSongs([...songs])
    queueTag.value = tag
    const snap = loadResume()
    if (snap && snap.tag === tag && snap.index >= 0 && snap.index < songs.length) {
      pendingSeek = snap.time > 3000 ? snap.time : null
      await playAt(snap.index)
      return { resumed: true, song: queue.value[snap.index] ?? null }
    }
    await playAt(0)
    return { resumed: false, song: queue.value[0] ?? null }
  }

  function playSong(song: Song): void {
    const existing = queue.value.findIndex(
      (item) => item.id === song.id && item.platform === song.platform
    )
    if (existing >= 0) {
      void playAt(existing)
      return
    }
    queue.value.push(song)
    void playAt(queue.value.length - 1)
  }

  function playNext(song: Song): void {
    const insertAt = index.value + 1
    queue.value.splice(insertAt, 0, song)
    // 插队是静默操作，不给反馈用户会以为没点上（与「加入播放列表」的提示对齐）
    useAppStore().toast(`下一首播放：${song.name}`, 'success')
  }

  function appendToQueue(song: Song): void {
    if (queue.value.some((item) => item.id === song.id && item.platform === song.platform)) return
    queue.value.push(song)
    useAppStore().toast('已添加到播放列表', 'success')
  }

  function removeAt(target: number): void {
    if (target < 0 || target >= queue.value.length) return
    queue.value.splice(target, 1)
    if (target < index.value) index.value -= 1
    else if (target === index.value) {
      if (!queue.value.length) {
        stop()
        return
      }
      const nextIndex = Math.min(index.value, queue.value.length - 1)
      void playAt(nextIndex)
    }
  }

  function clearQueue(): void {
    queue.value = []
    stop()
  }

  async function toggle(): Promise<void> {
    if (!current.value) {
      if (queue.value.length) await playAt(0)
      return
    }
    if (playing.value) audio.pause()
    else {
      try {
        await audio.play()
      } catch (err) {
        // 缓冲中用户又点了暂停：play() 会以 AbortError 拒绝，不是播放失败
        if ((err as Error)?.name !== 'AbortError') error.value = '播放失败，请重试'
      }
    }
  }

  async function next(auto = false): Promise<void> {
    if (!queue.value.length) return
    if (mode.value === 'single' && auto) {
      audio.seek(0)
      await audio.play()
      return
    }
    let target: number
    if (mode.value === 'shuffle' && queue.value.length > 1) {
      do {
        target = Math.floor(Math.random() * queue.value.length)
      } while (target === index.value)
    } else {
      target = index.value + 1
      if (target >= queue.value.length) {
        if (mode.value === 'order') {
          stop()
          return
        }
        target = 0
      }
    }
    await playAt(target)
  }

  async function prev(): Promise<void> {
    if (!queue.value.length) return
    const target = index.value <= 0 ? queue.value.length - 1 : index.value - 1
    await playAt(target)
  }

  async function handleEnded(): Promise<void> {
    // 「播完这首就停」：自然结束时不进下一首，停在原位等用户
    if (sleepMode.value === 'eof') {
      stopSleep()
      audio.pause()
      playing.value = false
      useAppStore().toast('睡眠定时：本曲已播完，已暂停播放', 'info')
      return
    }
    await next(true)
  }

  /** 清空睡眠定时（含计时器），不改播放状态 */
  function stopSleep(): void {
    if (sleepTick !== null) {
      window.clearInterval(sleepTick)
      sleepTick = null
    }
    sleepMode.value = 'off'
    sleepRemain.value = 0
  }

  function setSleep(next: 'off' | '15' | '30' | '60' | 'eof'): void {
    stopSleep()
    if (next === 'off') return
    sleepMode.value = next
    if (next === 'eof') {
      sleepRemain.value = -1
      return
    }
    sleepRemain.value = Number(next) * 60
    sleepTick = window.setInterval(() => {
      sleepRemain.value -= 1
      if (sleepRemain.value > 0) return
      stopSleep()
      audio.pause()
      playing.value = false
      useAppStore().toast('睡眠时间到，已暂停播放', 'info')
    }, 1000)
  }

  function seekTo(ms: number): void {
    audio.seek(ms)
    time.value = ms
    // 拖动后立即推一次位置，锁屏进度条跟手
    lastNativeSync = Date.now()
    syncPlaybackState(playing.value)
  }

  function setVolume(value: number): void {
    volume.value = Math.max(0, Math.min(1, value))
    audio.setVolume(volume.value)
    if (volume.value > 0 && muted.value) {
      muted.value = false
      audio.setMuted(false)
    }
    if (volumeTimer) window.clearTimeout(volumeTimer)
    volumeTimer = window.setTimeout(() => {
      void useAppStore().patchSettings({ volume: volume.value })
    }, 350)
  }

  function toggleMute(): void {
    muted.value = !muted.value
    audio.setMuted(muted.value)
  }

  function cycleMode(): void {
    const order: PlayMode[] = ['loop', 'single', 'shuffle', 'order']
    const nextMode = order[(order.indexOf(mode.value) + 1) % order.length]
    mode.value = nextMode
    void useAppStore().patchSettings({ playMode: nextMode })
    const labels: Record<PlayMode, string> = {
      loop: '列表循环',
      single: '单曲循环',
      shuffle: '随机播放',
      order: '顺序播放'
    }
    useAppStore().toast(labels[nextMode], 'info')
  }

  function stop(): void {
    // 让还在路上的取址请求作废，否则它回来会把已经停掉的队列重新播起来
    playGate.invalidate()
    audio.pause()
    audio.seek(0)
    playing.value = false
    time.value = 0
    index.value = -1
    resolvedSong.value = null
    lyric.value = null
    queueTag.value = ''
  }

  function hydrate(config: { volume: number; playMode: PlayMode }): void {
    volume.value = config.volume
    mode.value = config.playMode
    audio.setVolume(config.volume)
  }

  function updateMediaSession(song: Song): void {
    if (!('mediaSession' in navigator)) return
    try {
      const artwork = song.coverUrl
        ? [{ src: song.coverUrl, sizes: '512x512', type: 'image/jpeg' }]
        : undefined
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name,
        artist: song.artists.join(' / '),
        album: song.album,
        ...(artwork ? { artwork } : {})
      })
      navigator.mediaSession.setActionHandler('play', () => void toggle())
      navigator.mediaSession.setActionHandler('pause', () => void toggle())
      navigator.mediaSession.setActionHandler('nexttrack', () => void next())
      navigator.mediaSession.setActionHandler('previoustrack', () => void prev())
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) seekTo(details.seekTime * 1000)
      })
      syncPlaybackState(playing.value)
    } catch {
      /* 部分环境不支持 */
    }
  }

  /** 把播放/暂停状态同步到系统媒体面板（不支持的浏览器是 no-op） */
  function syncPlaybackState(isPlaying: boolean): void {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
      } catch {
        /* ignore */
      }
    }
  }

  return {
    queue,
    index,
    playing,
    loading,
    waiting,
    error,
    notice,
    time,
    duration,
    buffered,
    volume,
    muted,
    mode,
    lyric,
    lyricLoading,
    lyricOffsetAdj,
    totalLyricOffset,
    nudgeLyric,
    resetLyricOffset,
    streamLabel,
    resolvedSong,
    showNowPlaying,
    showQueue,
    recent,
    current,
    displaySong,
    hasNext,
    progress,
    activeLyricIndex,
    queueTag,
    sleepMode,
    sleepRemain,
    setSleep,
    stopSleep,
    setQueue,
    startHero,
    playAt,
    playSong,
    playNext,
    appendToQueue,
    removeAt,
    clearQueue,
    toggle,
    next,
    prev,
    seekTo,
    setVolume,
    toggleMute,
    cycleMode,
    stop,
    hydrate,
    loadLyric,
    bindEngine
  }
})
