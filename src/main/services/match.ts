import type { AlternativeTrack, Song } from '@shared/types'

/**
 * 歌名归一化：小写 + 去掉空格、括号与常见标点。
 * 让「晴天（Live）」「晴天 live」「晴天」能对上——换源和歌词匹配都靠它。
 */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\-_（）()【】[\]·,，.。'’!！?？]/g, '')
}

/**
 * 歌名 / 歌手 / 时长的相似度打分，按分数从高到低返回。
 *
 * 换源（`findAlternative`）与「手动换版本」面板共用同一套打分——两处标准不同的话，
 * 会出现「自动换源换得到、手动面板却列不出来」的怪事。
 *
 * 实际档位（`pickBest` 的阈值是 70，以下都是实测值）：
 * - 100 同名 + 同歌手 + 时长接近
 * - 90  同名 + 同歌手，时长差 5–30 秒
 * - 75  名字包含 + 同歌手 + 时长接近（现场版、remix 可能落在这里）
 * - 70  只有同名、歌手不同，但时长接近——靠时长兜底，这是阈值故意留宽的口子
 * - 65  名字包含 + 同歌手，时长差 5–30 秒
 * - 60  只有同名、歌手不同，时长差 5–30 秒
 * - 50  名字包含 + 同歌手 + 时长差 30 秒以上
 * - 45  只有同名 + 歌手不同 + 时长差 30 秒以上
 * - 35  只有名字包含
 *
 * 注意「名字包含」这一类：只要时长够接近就会摸到 75，高于阈值。这是有意的——
 * 现场版与录音室版确实经常是同一个内容，宁可让用户换过去再听，也不要在原源挂掉时无路可走。
 *
 * 纯函数，不碰网络也不碰评分板，可以直接单测。
 */
export function rankMatches(target: Song, candidates: Song[]): Array<{ song: Song; score: number }> {
  const targetName = normalize(target.name)
  const targetArtists = target.artists.map(normalize)
  const ranked: Array<{ song: Song; score: number }> = []

  for (const candidate of candidates) {
    const name = normalize(candidate.name)
    let score = 0
    if (name === targetName) score += 60
    else if (name.includes(targetName) || targetName.includes(name)) score += 35
    // 名字完全不沾边：直接不参与排序，免得一堆「同名专辑里的别的歌」混进来
    else continue

    const artists = candidate.artists.map(normalize)
    if (artists.some((artist) => targetArtists.some((t) => artist.includes(t) || t.includes(artist)))) {
      score += 30
    }
    if (target.duration && candidate.duration) {
      const diff = Math.abs(target.duration - candidate.duration)
      if (diff < 5_000) score += 10
      // 差 30 秒以上基本可以确定是另一个版本（现场、加长、串烧）
      else if (diff > 30_000) score -= 15
    }
    ranked.push({ song: candidate, score })
  }
  return ranked.sort((a, b) => b.score - a.score)
}

/**
 * 换版本候选的收尾：按 `platform:id` 去重、保持分数降序、截断到 limit。
 *
 * 去重是必需的：同一首歌会被多个源同时命中（同名同歌手同平台不同 id 的翻唱也会），
 * 而 UI 用 `platform:id` 当 key —— 不唯一就是重复行 + Vue 的 key 冲突警告。
 * 传入前应已按分数排序，这里保留首个（即最高分）出现的那个。
 */
export function dedupeAlternatives(items: AlternativeTrack[], limit = 12): AlternativeTrack[] {
  const seen = new Set<string>()
  const result: AlternativeTrack[] = []
  for (const item of items) {
    const key = `${item.song.platform}:${item.song.id}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= limit) break
  }
  return result
}
