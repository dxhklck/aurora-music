import type { Song } from '@shared/types'
import { providers } from '../providers'
import { mediaUrl } from '../media'
import { TtlCache } from './cache'

/**
 * 封面补全：当某首歌的 `coverUrl` 为空（酷我部分曲目、QQ 榜单封面、演示曲目）
 * 时，按「歌名 + 首位歌手」到其它平台搜一遍，取一条同名同歌手的结果拿封面。
 *
 * 设计取舍：
 * - 只在渲染层「缺封面」时按需调用，不在搜索结果返回时批量补——批量补会放大
 *   上游请求量，且大部分封面其实平台自己就有，只是某些字段没填。
 * - 命中后缓存 24 小时（封面很少变），未命中缓存 10 分钟（避免反复打）。
 * - 用 `normalize(name|artist)` 做 key，跨平台共用同一份缓存。
 */
class CoverService {
  private cache = new TtlCache<string | null>(24 * 60 * 60_000, 400)
  private readonly negativeTtl = 10 * 60_000

  private key(song: Pick<Song, 'name' | 'artists'>): string {
    const artist = (song.artists[0] ?? '').trim()
    return `${normalize(stripSuffix(song.name))}|${normalize(artist)}`
  }

  async resolve(song: Song): Promise<string | null> {
    if (song.coverUrl) return song.coverUrl
    const key = this.key(song)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    const result = await this.searchAcross(song)
    // 命中走 24h 默认 TTL；未命中走 10 分钟负缓存，避免反复打上游。
    this.cache.set(key, result, result ? 24 * 60 * 60_000 : this.negativeTtl)
    return result
  }

  /**
   * 依次尝试网易云、QQ。
   * - 用纯歌名搜（不带歌手）：跨平台翻唱多，带歌手反而召回变差；
   *   封面只取专辑封面，同名曲大概率是同一张专辑，张冠李戴也比占位强。
   * - 网易云封面最全且免登录可读，优先；QQ 与之互补。
   */
  private async searchAcross(song: Song): Promise<string | null> {
    // 用去后缀的歌名搜：带 "(Live版)"/"(DJ版)" 的翻唱，主干相同就拿同一张专辑封面
    const keyword = stripSuffix(song.name) || song.name.trim()
    if (!keyword) return null

    for (const platformId of ['netease', 'qq'] as const) {
      const provider = providers.get(platformId)
      if (!provider.info.capabilities.search) continue
      try {
        const page = await provider.search({ keyword, page: 1, limit: 8 })
        const hit = this.pickBest(page.items, song)
        if (hit?.coverUrl) return hit.coverUrl
      } catch {
        // 单平台失败不影响下一个
      }
    }
    return null
  }

  private pickBest(items: Song[], target: Song): Song | null {
    if (!items.length) return null
    // 用去后缀的主干做匹配，提高翻唱/版本曲的命中率
    const tn = normalize(stripSuffix(target.name))
    const ta = normalize(target.artists[0] ?? '')
    const sameName = items.filter((item) => normalize(stripSuffix(item.name)) === tn)
    if (!sameName.length) return null
    if (!ta) return sameName[0]
    const artistMatch = sameName.find(
      (item) => normalize(item.artists[0] ?? '') === ta
    )
    if (artistMatch) return artistMatch
    return (
      sameName.find((item) => normalize(item.artists[0] ?? '').includes(ta)) ??
      sameName.find((item) => ta.includes(normalize(item.artists[0] ?? ''))) ??
      sameName[0]
    )
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\-_（）()【】[\]·,，.。'’!！?？]/g, '')
}

/** 去掉「歌名 (后缀)」里的版本/语种后缀，用主干去搜封面 */
function stripSuffix(name: string): string {
  return name
    .replace(/\s*[（(]\s*[^)）]*[)）]\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export const coverService = new CoverService()

/** 给 ipc 用：返回经 muse 代理的封面地址，或 null */
export async function resolveCover(song: Song): Promise<string | null> {
  const url = await coverService.resolve(song)
  if (!url) return null
  // provider 返回的 coverUrl 可能已经是 mediaUrl(...) 形式（网易云/QQ 都在 provider 里包过），
  // 也可能是裸 URL（兜底场景）。统一再过一层 mediaUrl，保证 Referer 与 CORS 正确。
  if (url.startsWith('muse://')) return url
  return mediaUrl(url, 'https://music.163.com/')
}
