import { ref } from 'vue'
import { searchKeywords } from '@shared/recognize-text'

/**
 * 「这次搜索是从听歌识曲跳过来的」这一小段上下文。
 *
 * 为什么需要它：识别弹窗跳走后本身会被卸载，出口（去别的平台）就没了。
 * 如果音源里搜出 30 条无关结果，用户只能重新打开识别弹窗——而重新打开是拿不到上次结果的
 * （要重新录 20 秒）。所以在跳转那一刻把结果留在这里，搜索页据此显示一条可关闭的提示条。
 *
 * 刻意做得很轻：没有持久化、没有 IPC，进程内一个 ref 就够。10 分钟自动作废，
 * 免得几天后搜索页还挂着一条「识别结果」。
 */

export interface RecognizeOrigin {
  title: string
  artist: string
  /** 跳转时实际用的关键词，用于判断当前搜索结果是不是这次识别带来的 */
  keyword: string
  at: number
}

export const RECOGNIZE_ORIGIN_TTL = 10 * 60 * 1000

const origin = ref<RecognizeOrigin | null>(null)
let ttlTimer: ReturnType<typeof setTimeout> | null = null

export function setRecognizeOrigin(input: {
  title: string
  artist: string
  keyword: string
}): void {
  origin.value = { ...input, at: Date.now() }
  // computed 里读 Date.now() 不是响应式依赖，页面静止时提示条永远不会自己消失；
  // 用定时器主动清空，搜索页的 computed 才会重算
  if (ttlTimer) clearTimeout(ttlTimer)
  ttlTimer = setTimeout(() => {
    origin.value = null
    ttlTimer = null
  }, RECOGNIZE_ORIGIN_TTL)
}

export function clearRecognizeOrigin(): void {
  origin.value = null
  if (ttlTimer) {
    clearTimeout(ttlTimer)
    ttlTimer = null
  }
}

/** 搜索页消费这个 ref；只读不改，改动一律走上面两个函数 */
export function useRecognizeOrigin(): typeof origin {
  return origin
}

/** 当前关键词是否仍属于这次识别（用户换词搜就别再挂提示条了） */
export function belongsToOrigin(item: RecognizeOrigin | null, keyword: string): boolean {
  if (!item) return false
  if (Date.now() - item.at > RECOGNIZE_ORIGIN_TTL) return false
  const current = keyword.trim()
  if (!current) return false
  // 只认「这次识别实际用过的关键词」：带歌手、只搜歌名两档都算。
  // 原来用 current.includes(title)，用户手动搜「暧昧 陈奕迅」也会挂上一次识别的
  // 标题与外链，把结果指向别的歌。
  const keywords = [item.keyword, ...searchKeywords(item.title, item.artist)]
    .map((value) => value.trim())
    .filter(Boolean)
  return keywords.includes(current)
}
