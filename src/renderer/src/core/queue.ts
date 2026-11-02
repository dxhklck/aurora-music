import type { Song } from '@shared/types'

/**
 * 队列项 = 歌曲 + 会话内唯一的 uid。
 *
 * 为什么需要：队列允许同一首歌出现多次（「下一首播放」重复点、从不同页面反复加），
 * 列表 `v-for` 的 key 如果只用 `platform:id` 就会撞 key，重排后行状态错乱。
 * 也没有 `index` 可用——重排一次所有 key 都变，等于整段重渲染（封面重新请求、
 * 正在播那行的 .eq 动画重启）。
 */
export type QueueItem = Song & { uid: string }

/**
 * 生成队列项的 uid。
 *
 * 不用 `crypto.randomUUID()`：渲染层的构建目标是 es2017（历史上为兼容 Android
 * WebView 老内核压低的，现在 Electron 端本身不需要，但配置没改回来），
 * `randomUUID` 要 Chrome 92+，在旧内核里会直接抛错甚至白屏。
 * 计数器足够——uid 只在当前会话内用于定位，不跨会话使用。
 */
export function createUidFactory(prefix = 'q'): () => string {
  let seed = 0
  return () => {
    seed += 1
    return `${prefix}${seed}`
  }
}

/** 把一项从 from 移到 to。越界或原地不动时返回原数组的副本 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * 重排之后「正在播放那一首」的新下标。
 *
 * 三种情况：动的就是当前这首（跟着走）、从前面移到后面（当前项前移一位）、
 * 从后面移到前面（当前项后移一位）。算错的后果是拖一下队列，正在播的变成别的歌。
 */
export function moveIndex(current: number, from: number, to: number): number {
  if (current < 0 || from === to) return current
  if (current === from) return to
  if (from < current && to >= current) return current - 1
  if (from > current && to <= current) return current + 1
  return current
}
