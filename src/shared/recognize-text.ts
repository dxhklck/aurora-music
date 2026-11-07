/**
 * 听歌识曲的「出口」：把识别结果折成可搜、可复制的文本与外链。
 *
 * 为什么需要它：AcoustID 的命中率由它的库决定（实测 127 首命中 43%），代码改不动。
 * 真正能改的是两件事——
 *   1. 认出来了但音源没版权（周杰伦这类），让用户能一键去别的平台找；
 *   2. 没认出来时，别只丢一句「识别失败」，要给一条能走的路。
 * 这里只做纯字符串处理，Node 单测可以直接跑（不要 import 任何 Electron 东西）。
 */

export interface ExternalSearchLink {
  id: 'qq' | 'kugou' | 'bilibili'
  label: string
  url: string
}

/** 关键词上限：和剪贴板取词一致，太长只会把搜索结果带偏 */
export const RECOGNIZE_KEYWORD_MAX = 60

function tidy(value: string): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\s\u3000]+/g, ' ').trim()
}

/**
 * 含至少一个字母或数字：纯标点、纯表情搜出来只有噪音。
 * 不能要求 ≥2 个字符——中文单字歌名（《氧》《殇》）很常见，
 * 那样会让识别成功后「在音源中搜索」点了完全没反应。
 */
function usable(value: string): boolean {
  return value.length >= 1 && /[\p{L}\p{N}]/u.test(value)
}

/** 展示与复制用「歌名 - 歌手」；缺一个就只给有的那个，两个都空返回空串 */
export function trackLabel(title: string, artist: string): string {
  const t = tidy(title)
  const a = tidy(artist)
  if (t && a) return `${t} - ${a}`
  return t || a
}

/**
 * 候选搜索词，按「精确 → 宽松」排序，最多两条。
 *
 * 只退一步，不铺开：实测繁简、词序都不影响音源结果（网易云自己会归一，
 * 「曖昧 王菲」与「暧昧 王菲」返回同样的 90 条），真正会让结果归零的是
 * **歌手名对不上**——AcoustID 会给出「Echo 艾歌」这种写法，或把多个歌手
 * 拼成「A, B」。所以第一次带上歌手，第二次直接只搜歌名。
 */
export function searchKeywords(title: string, artist: string): string[] {
  const t = tidy(title)
  const a = tidy(artist)
  const list: string[] = []
  const push = (value: string): void => {
    const clipped = value.slice(0, RECOGNIZE_KEYWORD_MAX).trim()
    if (usable(clipped) && !list.includes(clipped)) list.push(clipped)
  }
  push(t && a ? `${t} ${a}` : t)
  push(t)
  return list
}

/**
 * 外部平台搜索链接。
 *
 * 只列「本应用搜不到时最可能有的地方」：
 * - QQ 音乐：华语版权最全，在别的平台下架的歌通常在这里
 * - 酷狗：翻唱、网络歌手、DJ 版最多，正好补 AcoustID 的盲区
 * - 哔哩哔哩：OST、现场、翻唱，用户最后往往在这里听
 *
 * 不列网易云——应用内的搜索本身就是它（默认音源）。
 */
export function externalSearchLinks(title: string, artist: string): ExternalSearchLink[] {
  const keyword = searchKeywords(title, artist)[0] ?? ''
  if (!keyword) return []
  const q = encodeURIComponent(keyword)
  return [
    { id: 'qq', label: 'QQ 音乐', url: `https://y.qq.com/n/ryqq/search?w=${q}` },
    {
      id: 'kugou',
      label: '酷狗',
      url: `https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyWord=${q}`
    },
    { id: 'bilibili', label: '哔哩哔哩', url: `https://search.bilibili.com/all?keyword=${q}` }
  ]
}
