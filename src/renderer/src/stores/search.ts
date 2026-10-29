import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Song } from '@shared/types'
import { useAppStore } from './app'
import { friendlyError } from '../core/error'

const HISTORY_KEY = 'aurora.search.history'

function keyOf(song: Song): string {
  return `${song.platform}:${song.id}`
}

export const useSearchStore = defineStore('search', () => {
  const keyword = ref('')
  const results = ref<Song[]>([])
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref('')
  const page = ref(1)
  const total = ref(0)
  const hasMore = ref(false)
  const history = ref<string[]>(loadHistory())
  const cost = ref(0)
  /** 本次搜索是否走了「边搜边出」（慢音源才会） */
  const streaming = ref(false)

  const isEmpty = computed(() => !loading.value && !results.value.length)

  /**
   * 增量结果：慢音源每解析出一首就推一条。
   * 只认当前这次搜索的 streamId，切换关键词后旧的推送直接丢弃。
   */
  let activeStream = ''
  let unsubscribe: (() => void) | null = null
  /**
   * 搜索请求序号。连续回车 / 切音源会并发发出多个搜索，先发的可能后回来，
   * 直接落地就会「关键词是 B、列表是 A」。每次 run 领号，回来时号变了就丢弃。
   */
  let runToken = 0

  function ensureSubscription(): void {
    if (unsubscribe) return
    unsubscribe = window.api.onSearchPartial(({ streamId, items }) => {
      if (!streamId || streamId !== activeStream) return
      const seen = new Set(results.value.map(keyOf))
      const fresh: Song[] = []
      for (const song of items) {
        const key = keyOf(song)
        if (seen.has(key)) continue
        seen.add(key)
        fresh.push(song)
      }
      if (fresh.length) {
        results.value = [...results.value, ...fresh]
        streaming.value = true
      }
    })
  }

  function loadHistory(): string[] {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as string[]
    } catch {
      return []
    }
  }

  function remember(query: string): void {
    history.value = [query, ...history.value.filter((item) => item !== query)].slice(0, 10)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.value))
  }

  function clearHistory(): void {
    history.value = []
    localStorage.removeItem(HISTORY_KEY)
  }

  async function run(query?: string): Promise<void> {
    const app = useAppStore()
    const q = (query ?? keyword.value).trim()
    if (!q) return
    keyword.value = q
    loading.value = true
    error.value = ''
    page.value = 1
    results.value = []
    streaming.value = false
    ensureSubscription()
    const token = (runToken += 1)
    activeStream = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const result = await window.api.search({
        platform: app.platform,
        keyword: q,
        page: 1,
        limit: app.settings?.searchLimit ?? 30,
        streamId: activeStream
      })
      if (token !== runToken) return
      // 增量推送已经铺好了同样的歌，就别再整体替换——顺序跳变比顺序不完美更刺眼
      const incoming = result.items
      const current = results.value
      const sameSet =
        current.length === incoming.length &&
        incoming.every((song) => current.some((item) => keyOf(item) === keyOf(song)))
      results.value = sameSet ? current : incoming
      total.value = result.total
      hasMore.value = result.hasMore
      cost.value = result.cost ?? 0
      remember(q)
    } catch (err) {
      if (token !== runToken) return
      error.value = friendlyError(err)
      results.value = []
    } finally {
      if (token === runToken) {
        activeStream = ''
        loading.value = false
      }
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || loadingMore.value) return
    const app = useAppStore()
    const token = runToken
    loadingMore.value = true
    try {
      const next = page.value + 1
      const result = await window.api.search({
        platform: app.platform,
        keyword: keyword.value,
        page: next,
        limit: app.settings?.searchLimit ?? 30
      })
      // 翻页期间又搜了别的词/换了音源：这一页不属于当前结果集，丢弃
      if (token !== runToken) return
      page.value = next
      // 补一页时按 platform:id 去重：平台翻页偶有重叠，直接拼接会出现重复行
      const seen = new Set(results.value.map(keyOf))
      const fresh = result.items.filter((song) => {
        const key = keyOf(song)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      results.value = [...results.value, ...fresh]
      hasMore.value = result.hasMore
    } catch {
      /* 忽略分页错误 */
    } finally {
      loadingMore.value = false
    }
  }

  function reset(): void {
    runToken += 1
    activeStream = ''
    results.value = []
    total.value = 0
    hasMore.value = false
    error.value = ''
    streaming.value = false
  }

  return {
    keyword,
    results,
    loading,
    loadingMore,
    error,
    page,
    total,
    hasMore,
    history,
    cost,
    streaming,
    isEmpty,
    run,
    loadMore,
    reset,
    clearHistory,
    remember
  }
})
