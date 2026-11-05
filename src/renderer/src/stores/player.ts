import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AlternativeTrack, Lyric, PlayMode, Song } from '@shared/types'
import { findLyricIndex } from '@shared/lyric'
import { audio } from '../core/audio'
import { plain } from '../core/plain'
import { friendlyError } from '../core/error'
import { useAppStore } from './app'
import { useStatsStore } from './stats'
import { createLatestGate } from '../core/latest'
import { artworkSrc } from '../core/artwork'
import { createUidFactory, moveIndex, moveItem, type QueueItem } from '../core/queue'

const HISTORY_KEY = 'aurora.recent'
/** 榜单队列断点：记录「哪份榜单 + 第几首 + 播到几毫秒」，跨重启续播 */
const RESUME_KEY = 'aurora.hero.resume'
/** 歌词手动对齐记忆：{ "platform:id": 毫秒偏移 }，只记用户调过的歌 */
const LYRIC_OFFSET_KEY = 'aurora.lyric-offsets'
/** 手动指定的歌词来源：{ "platform:id": Song }，用于音源自带歌词匹配错时改绑 */
const LYRIC_PICK_KEY = 'aurora.lyric-picks'
/**
 * 整个队列的快照（任意来源，不限于首页榜单）与播放位置。
 * 拆成两个 key：队列内容只在结构变化时写，进度每 5 秒写一次——
 * 合并成一个 key 的话，几百首的 JSON 每 5 秒重写一遍，白耗 IO。
 */
const QUEUE_KEY = 'aurora.queue'
const QUEUE_POS_KEY = 'aurora.queue.pos'

interface QueueSnapshot {
  songs: Song[]
}

interface QueuePosition {
  index: number
  time: number
}

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
function sanitizeSong(song: Song): Song {
  return !song.name || song.name.toLowerCase() === 'undefined'
    ? { ...song, name: '未知曲目' }
    : song
}

function sanitizeSongs(songs: Song[]): Song[] {
  return songs.map(sanitizeSong)
}

export const usePlayerStore = defineStore('player', () => {
  const queue = ref<QueueItem[]>([])
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
  /** 「换一个版本」面板：候选列表 / 加载中 / 是否展开 */
  const alternatives = ref<AlternativeTrack[]>([])
  const alternativesLoading = ref(false)
  const alternativesOpen = ref(false)
  /** 正在为哪首歌找替代版本：可能是当前播放的，也可能是搜索结果里的一首（浏览模式） */
  const alternativeTarget = ref<Song | null>(null)
  /** 候选请求的代次号：换歌或关面板后，在途的旧结果按这个丢弃 */
  let alternativesToken = 0

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

  /** 队列项 uid 的工厂（会话内递增，原因见 core/queue.ts） */
  const nextQueueUid = createUidFactory()
  /**
   * 已取址并交给 audio 的那首 uid。
   * 静默恢复的队列只有「选中」没有「已加载」：此时直接 audio.play() 会因为没有
   * 音源而失败，必须先重新走一次 playAt。
   */
  let loadedUid: string | null = null
  /** 静默恢复时记下的进度，只有用户重新播放「同一首」时才接着跳转 */
  let restoredSeek: { uid: string; time: number } | null = null
  /** 交叉淡化进行中（含下一曲取址）：防止 time 事件每帧重复触发 */
  let crossfading = false

  /**
   * 队列写入的唯一入口：清洁脏数据 + 盖 uid 一起做。
   *
   * 队列有五个写入点（setQueue / startHero / playSong / playNext / appendToQueue），
   * 任何一处漏盖就是 uid undefined，两个 undefined 又会撞 key——而这次没有 index 兜底。
   * 所以全部统一走这里，不要在各调用点各盖一次。
   */
  function toQueueItem(song: Song): QueueItem {
    return { ...sanitizeSong(song), uid: nextQueueUid() }
  }

  function toQueueItems(songs: Song[]): QueueItem[] {
    return songs.map(toQueueItem)
  }

  const current = computed<QueueItem | null>(() =>
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
    // 200 条足够撑起「播放历史」页，又不会把 localStorage 撑爆（每条约 300 字节）
    recent.value = next.slice(0, 200)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(recent.value))
  }

  function clearRecent(): void {
    recent.value = []
    localStorage.removeItem(HISTORY_KEY)
  }

  function bindEngine(): void {
    if (engineBound) return
    engineBound = true
    audio.on('time', (value: number) => {
      time.value = value
      maybeCrossfade()
      // 快照 5 秒一记：带标签的队列额外存榜单断点，任意队列都存播放位置
      if (Date.now() - lastResumeSave > 5000) {
        lastResumeSave = Date.now()
        if (queueTag.value) saveResume()
        saveQueuePos()
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
    opts: { isRetry?: boolean; forceSwitch?: boolean; noSkip?: boolean } = {}
  ): Promise<void> {
    const song = queue.value[target]
    if (!song) return
    const app = useAppStore()
    bindEngine()
    const token = playGate.next()
    if (!opts.isRetry) {
      stallCount = 0
      // 静默恢复的进度：只有点的就是恢复出来那首才沿用，点了别的歌立刻作废
      if (restoredSeek) {
        pendingSeek = restoredSeek.uid === song.uid ? restoredSeek.time : null
        restoredSeek = null
      }
    }
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
      // 记下「这一首是真的加载过音源的」，toggle 据此判断能不能直接 play()
      loadedUid = song.uid
      // 切歌后立刻把位置落盘：否则要等 5 秒后的进度快照，中途关掉会恢复到上一首的下标
      saveQueuePos()
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
      // 一首歌播不了就自动跳下一首，连续 3 次失败后停下来等用户处理。
      // noSkip：用户从「换一个版本」面板主动试播时不能跳——他还在挑，跳走等于把队列进度弄乱
      if (!opts.noSkip && failureStreak <= 3 && queue.value.length > 1) {
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
      const picked = lyricPicks.value[`${song.platform}:${song.id}`]
      // 手动指定过就按指定那首取歌词；没指定才用播放中的这首
      lyric.value = await window.api.lyric(plain(picked ?? song))
    } catch {
      lyric.value = null
    } finally {
      lyricLoading.value = false
    }
  }

  /* ---------------- 歌词手动匹配 ----------------
     「这首歌的歌词对不上」是长尾问题：音源给的歌词可能是另一版编曲。
     允许搜一个正确版本改绑，按歌记忆，下次播放仍然用它。 */
  function loadLyricPicks(): Record<string, Song> {
    try {
      const raw = localStorage.getItem(LYRIC_PICK_KEY)
      const parsed = raw ? (JSON.parse(raw) as unknown) : null
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, Song>) : {}
    } catch {
      return {}
    }
  }

  const lyricPicks = ref<Record<string, Song>>(loadLyricPicks())

  function lyricPickOf(song: Song | null): Song | null {
    return song ? lyricPicks.value[`${song.platform}:${song.id}`] ?? null : null
  }

  /** picked = null 表示恢复自动匹配 */
  async function applyLyricPick(picked: Song | null): Promise<void> {
    const song = current.value
    if (!song) return
    const key = `${song.platform}:${song.id}`
    const next = { ...lyricPicks.value }
    if (picked) next[key] = plain(picked)
    else delete next[key]
    lyricPicks.value = next
    try {
      localStorage.setItem(LYRIC_PICK_KEY, JSON.stringify(next))
    } catch {
      /* 存不下只影响记忆，本首仍然生效 */
    }
    await loadLyric(song)
  }

  /** 队列内容变化时写快照（不含播放进度，进度见 saveQueuePos） */
  function saveQueue(): void {
    if (!queue.value.length) {
      localStorage.removeItem(QUEUE_KEY)
      localStorage.removeItem(QUEUE_POS_KEY)
      return
    }
    try {
      // uid 是会话内的定位标记，落盘前剥掉；恢复时重新生成
      const songs = queue.value.map(({ uid: _uid, ...song }) => song)
      localStorage.setItem(QUEUE_KEY, JSON.stringify({ songs } satisfies QueueSnapshot))
      saveQueuePos()
    } catch {
      /* 存储失败不影响播放 */
    }
  }

  /** 播放位置：每 5 秒写一次，是个几十字节的小对象 */
  function saveQueuePos(): void {
    if (!queue.value.length || index.value < 0) return
    try {
      localStorage.setItem(
        QUEUE_POS_KEY,
        JSON.stringify({ index: index.value, time: Math.round(time.value) } satisfies QueuePosition)
      )
    } catch {
      /* ignore */
    }
  }

  function loadQueueSnapshot(): { items: QueueItem[]; index: number; time: number } | null {
    try {
      const raw = localStorage.getItem(QUEUE_KEY)
      if (!raw) return null
      const snap = JSON.parse(raw) as QueueSnapshot
      if (!Array.isArray(snap?.songs)) return null
      // 存储可能被手改坏：没有 id/platform 的条目直接丢掉，别让一行脏数据把整个恢复搞崩
      const songs = snap.songs.filter(
        (song) => song && typeof song.id === 'string' && typeof song.platform === 'string'
      )
      if (!songs.length) return null
      const posRaw = localStorage.getItem(QUEUE_POS_KEY)
      const pos = posRaw ? (JSON.parse(posRaw) as Partial<QueuePosition>) : null
      const items = toQueueItems(songs)
      const index = Math.max(0, Math.min(Math.floor(Number(pos?.index) || 0), items.length - 1))
      const time = Math.max(0, Number(pos?.time) || 0)
      return { items, index, time }
    } catch {
      return null
    }
  }

  /**
   * 启动时把上次的队列摆回来，但**不出声**：不取址、不调 playAt，
   * 只还原队列与选中项。用户点播放时才真正加载——这也是为什么
   * toggle 里要先看 loadedUid，否则会对着一个没有音源的 audio 调 play()。
   */
  function restoreQueue(): void {
    const snap = loadQueueSnapshot()
    if (!snap) return
    queue.value = snap.items
    index.value = snap.index
    // 进度先不显示：duration 还是 0，显示「1:20 / 0:00」比显示 0:00 更莫名其妙。
    // 记下来等用户点播放时再跳（太靠前就没必要跳）
    restoredSeek = snap.time > 3000 ? { uid: snap.items[snap.index].uid, time: snap.time } : null
    loadedUid = null
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
    queue.value = toQueueItems(songs)
    queueTag.value = tag
    // 用户主动重建队列：恢复时的进度作废
    restoredSeek = null
    saveQueue()
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
    queue.value = toQueueItems(songs)
    queueTag.value = tag
    // 榜单续播有自己的 pendingSeek，别被「静默恢复」那套覆盖掉
    restoredSeek = null
    saveQueue()
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
    queue.value.push(toQueueItem(song))
    saveQueue()
    void playAt(queue.value.length - 1)
  }

  function playNext(song: Song): void {
    const insertAt = index.value + 1
    queue.value.splice(insertAt, 0, toQueueItem(song))
    saveQueue()
    // 插队是静默操作，不给反馈用户会以为没点上（与「加入播放列表」的提示对齐）
    useAppStore().toast(`下一首播放：${song.name}`, 'success')
  }

  function appendToQueue(song: Song): void {
    if (queue.value.some((item) => item.id === song.id && item.platform === song.platform)) return
    queue.value.push(toQueueItem(song))
    saveQueue()
    useAppStore().toast('已添加到播放列表', 'success')
  }

  function removeAt(target: number): void {
    if (target < 0 || target >= queue.value.length) return
    const removed = queue.value[target]
    // 必须在 splice 前判定：删掉当前项后 index 可能恰好等于 target，靠后置比较会误判
    const wasCurrent = target === index.value
    queue.value.splice(target, 1)
    if (target < index.value) index.value -= 1
    else if (wasCurrent) {
      if (!queue.value.length) {
        stop()
        return
      }
      // 后面的项前移了一位，index 位置现在装的就是「原本的下一首」
      index.value = Math.min(index.value, queue.value.length - 1)
    }
    if (removed && removed.uid === loadedUid) loadedUid = null
    // 下标调整完再落盘，快照里才是删除后的真实位置
    saveQueue()
    if (wasCurrent) void playAt(index.value)
  }

  /**
   * 批量移出队列（多选）。按 uid 删，重复曲目不会误伤。
   * 正在播的那首也在选中里时，删完接着播「原位」那一首；删空了就停。
   */
  function removeMany(uids: string[]): void {
    const set = new Set(uids)
    if (!set.size || !queue.value.length) return
    const currentUid = queue.value[index.value]?.uid
    const wasCurrent = !!currentUid && set.has(currentUid)
    const removedBefore = queue.value.reduce(
      (count, item, i) => (i < index.value && set.has(item.uid) ? count + 1 : count),
      0
    )
    queue.value = queue.value.filter((item) => !set.has(item.uid))
    if (wasCurrent) {
      if (!queue.value.length) {
        stop()
        saveQueue()
        return
      }
      index.value = Math.min(index.value, queue.value.length - 1)
      loadedUid = null
      saveQueue()
      void playAt(index.value)
      return
    }
    index.value = Math.max(0, index.value - removedBefore)
    saveQueue()
  }

  /**
   * 拖拽重排。index 必须跟着动，否则「拖一下队列，正在播的变成别的歌」。
   * 下标换算在 core/queue.ts 里，有单测。
   */
  function moveQueueItem(from: number, to: number): void {
    if (from === to) return
    const moved = moveIndex(index.value, from, to)
    queue.value = moveItem(queue.value, from, to)
    index.value = moved
    saveQueue()
  }

  function clearQueue(): void {
    queue.value = []
    saveQueue()
    stop()
  }

  /**
   * 打开「换一个版本」面板并拉候选。
   * 主进程那边只搜索打分、不取址，所以不会熔断音源、也不写换源评分。
   */
  async function findAlternatives(): Promise<void> {
    const song = current.value
    if (!song) return
    await loadAlternatives(song)
  }

  /**
   * 为**任意一首**歌找替代版本（搜索结果里右键/点按钮打开）。
   *
   * 与换源面板的区别只在「点选之后怎么办」：当前播放的那首是替换队列项，
   * 而这里只是浏览，点选等于播放它——不动队列里已有的内容。
   */
  async function findAlternativesFor(song: Song): Promise<void> {
    await loadAlternatives(song)
  }

  async function loadAlternatives(song: Song): Promise<void> {
    alternativeTarget.value = song
    // 搜索要几秒，期间用户可能换歌或重开面板：过期结果不能挂到新歌上
    const token = ++alternativesToken
    alternativesOpen.value = true
    alternativesLoading.value = true
    alternatives.value = []
    try {
      // 可选调用：外部宿主（另一个 WebView 壳）没实现这个方法时退化成空列表，而不是崩掉
      const list = await window.api.findAlternatives?.(plain(song))
      if (token !== alternativesToken) return
      alternatives.value = Array.isArray(list) ? list : []
    } catch {
      if (token === alternativesToken) alternatives.value = []
    } finally {
      if (token === alternativesToken) alternativesLoading.value = false
    }
  }

  function closeAlternatives(): void {
    alternativesOpen.value = false
    alternativeTarget.value = null
    // 关掉面板后回来的结果不该再弹出内容
    alternativesToken += 1
  }

  /**
   * 换到候选版本。
   *
   * 两种语义，由 `alternativeTarget` 决定：
   * - 目标是当前播放的那首 → 用候选替换队列项后重播（失败回退，队列恢复原样）；
   * - 目标是搜索结果里的某首 → 直接播候选（追加到队列尾），不动当前队列。
   *
   * 不预探测——点选即验证，播不了就把错误交给 playAt（它内部已有自愈与跨源兜底）。
   */
  async function switchToAlternative(target: Song): Promise<boolean> {
    const at = index.value
    const browsing = alternativeTarget.value
    const targetIsCurrent =
      !!browsing && !!current.value && browsing.id === current.value.id && browsing.platform === current.value.platform

    if (!targetIsCurrent) {
      const lengthBefore = queue.value.length
      queue.value.push(toQueueItem(target))
      saveQueue()
      await playAt(queue.value.length - 1, { noSkip: true })
      if (!error.value) return true
      const reason = error.value
      queue.value.splice(lengthBefore)
      saveQueue()
      loadedUid = null
      error.value = ''
      useAppStore().toast(`这个版本播不了：${reason}`, 'error')
      return false
    }

    if (at < 0) return false
    const previous = queue.value[at]
    queue.value.splice(at, 1, toQueueItem(target))
    saveQueue()
    await playAt(at, { noSkip: true })
    if (!error.value) return true
    if (!previous) return false

    const reason = error.value
    queue.value.splice(at, 1, previous)
    index.value = at
    // 让 toggle 走一次完整取址：恢复到「干净暂停」的状态，而不是界面显示 0 秒、音频停在 3 分钟
    loadedUid = null
    saveQueue()
    error.value = ''
    useAppStore().toast(`这个版本播不了：${reason}`, 'error')
    return false
  }

  async function toggle(): Promise<void> {
    if (!current.value) {
      if (queue.value.length) await playAt(0)
      return
    }
    if (playing.value) {
      audio.pause()
      return
    }
    // 静默恢复的队列只有「选中」没有「加载」：直接 play() 会因为没有音源而失败，
    // 必须先走一次完整取址。正常播放中两者相等，这里是零成本判断。
    if (loadedUid !== current.value.uid) {
      await playAt(index.value)
      return
    }
    try {
      await audio.play()
    } catch (err) {
      // 缓冲中用户又点了暂停：play() 会以 AbortError 拒绝，不是播放失败
      if ((err as Error)?.name !== 'AbortError') error.value = '播放失败，请重试'
    }
  }

  function computeNextIndex(auto: boolean): number | null {
    if (!queue.value.length) return null
    if (mode.value === 'single' && auto) return index.value
    if (mode.value === 'shuffle' && queue.value.length > 1) {
      let target: number
      do {
        target = Math.floor(Math.random() * queue.value.length)
      } while (target === index.value)
      return target
    }
    const target = index.value + 1
    if (target >= queue.value.length) {
      // 顺序模式播完即停；循环/随机绕回开头
      if (mode.value === 'order') return null
      return 0
    }
    return target
  }

  async function next(auto = false): Promise<void> {
    if (!queue.value.length) return
    if (mode.value === 'single' && auto) {
      audio.seek(0)
      await audio.play()
      return
    }
    const target = computeNextIndex(auto)
    if (target === null) {
      stop()
      return
    }
    await playAt(target)
  }

  /**
   * 交叉淡化触发器：随 time 事件走。所有条件都过了才真正起淡——
   * 淡化只服务「自然临近结束的自动换曲」，手动操作与特殊情况一律不参与。
   */
  function maybeCrossfade(): void {
    if (crossfading) return
    const app = useAppStore()
    const sec = app.settings?.crossfadeSec ?? 0
    if (!sec || loading.value || !playing.value || !duration.value) return
    // 单曲循环是原地重播；「播完这首就停」要停在结尾，都不适合淡化
    if (mode.value === 'single' || sleepMode.value === 'eof') return
    // 太短的歌不淡：还没淡完就结束了，不如正常切
    if (duration.value < sec * 2000) return
    if (duration.value - time.value > sec * 1000) return
    const target = computeNextIndex(true)
    if (target === null) return
    crossfading = true
    void advanceWithCrossfade(target, sec * 1000)
  }

  /** 交叉淡化的取址与状态切换。任何失败都静默回退：旧曲放到自然结束走 handleEnded */
  async function advanceWithCrossfade(target: number, fadeMs: number): Promise<void> {
    const song = queue.value[target]
    if (!song) {
      crossfading = false
      return
    }
    const app = useAppStore()
    const token = playGate.next()
    try {
      const resolved = await window.api.resolveTrack({
        song: plain(song),
        autoSwitch: app.settings?.autoSwitchSource !== false,
        forceSwitch: false
      })
      if (!playGate.isCurrent(token)) {
        crossfading = false
        return
      }
      // 取址期间旧曲被暂停/切走：交给自然 ended 的老路处理
      if (audio.paused) {
        crossfading = false
        return
      }
      const ok = await audio.crossfadeTo(resolved.stream.url, fadeMs)
      if (!ok) {
        crossfading = false
        return
      }
      // 淡化已起：状态切换与 playAt 的成功路径对齐，只是提前到淡入开始这一刻
      resolvedSong.value = sanitizeSongs([resolved.song])[0]
      streamLabel.value = resolved.stream.label
      if (resolved.switchedFrom) {
        notice.value = resolved.notice ?? '已自动切换音源'
        window.setTimeout(() => {
          notice.value = ''
        }, 6000)
      }
      index.value = target
      loadedUid = song.uid
      saveQueuePos()
      failureStreak = 0
      pushRecent(song)
      useStatsStore().recordPlay(song)
      void loadLyric(resolved.song)
      updateMediaSession(song)
      time.value = 0
      duration.value = audio.duration
      buffered.value = 0
      // 新元素的 durationchange 在翻转 active 前就发过（被事件门滤掉），
      // 元数据还没就绪时补一次：多半在淡入的 300ms 里就到了
      if (!duration.value) {
        window.setTimeout(() => {
          duration.value = audio.duration
        }, 500)
      }
      crossfading = false
    } catch {
      crossfading = false
    }
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
    loadedUid = null
    restoredSeek = null
  }

  function hydrate(config: { volume: number; playMode: PlayMode }): void {
    volume.value = config.volume
    mode.value = config.playMode
    audio.setVolume(config.volume)
  }

  function updateMediaSession(song: Song): void {
    if (!('mediaSession' in navigator)) return
    try {
      const src = artworkSrc(song.coverUrl)
      const artwork = src ? [{ src, sizes: '512x512', type: 'image/jpeg' }] : undefined
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
    lyricPickOf,
    applyLyricPick,
    streamLabel,
    resolvedSong,
    showNowPlaying,
    showQueue,
    recent,
    clearRecent,
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
    removeMany,
    clearQueue,
    moveQueueItem,
    restoreQueue,
    saveQueue,
    alternatives,
    alternativesLoading,
    alternativesOpen,
    findAlternatives,
    findAlternativesFor,
    alternativeTarget,
    closeAlternatives,
    switchToAlternative,
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
