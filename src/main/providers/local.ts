import type {
  Lyric,
  ProviderInfo,
  Quality,
  SearchPage,
  Song,
  StreamInfo
} from '@shared/types'
import { parseLrc } from '@shared/lyric'
import { readFile } from 'node:fs/promises'
import { BaseProvider } from './base'
import { ProviderError, type SearchArgs } from './types'
import { localUrl } from '../media'
import { library } from '../services/library'
import { fileSize } from '../utils'

/**
 * 本地音乐音源：把「已下载/导入的文件 + 元数据」也当成一个 Provider。
 * 这样播放层完全不需要关心一首歌来自网络还是磁盘。
 */
export class LocalProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'local',
    name: '本地音乐',
    short: '本地',
    color: '#3fb6ff',
    gradient: ['#4facfe', '#0f3f66'],
    capabilities: { search: true, charts: false, stream: true, lyric: true },
    description: '已下载到本地的曲目，离线可播',
    // 不作为可选音源出现在切换列表；仅承担本地文件播放/歌词的底层职责
    hidden: true
  }

  protected baseHeaders(): Record<string, string> {
    return {}
  }

  async search({ keyword, page, limit }: SearchArgs): Promise<SearchPage> {
    const key = keyword.trim().toLowerCase()
    // 缺失文件不进搜索结果：点开必然报「文件已被移动或删除」，只会添堵
    const all = library.list().filter((item) => !item.missing)
    const matched = key
      ? all.filter(
          (item) =>
            item.song.name.toLowerCase().includes(key) ||
            item.song.album.toLowerCase().includes(key) ||
            item.song.artists.join(' ').toLowerCase().includes(key)
        )
      : all
    const start = (page - 1) * limit
    return {
      items: matched
        .slice(start, start + limit)
        .map((item) => ({
          ...item.song,
          id: item.id,
          platform: this.info.id,
          qualityLabel: item.qualityLabel ?? item.ext.toUpperCase(),
          extra: { ...(item.song.extra ?? {}), filePath: item.filePath }
        })),
      total: matched.length,
      page,
      hasMore: start + limit < matched.length
    }
  }

  async resolveStream(song: Song, _quality: Quality): Promise<StreamInfo> {
    const record = library.findById(song.id)
    const filePath = record?.filePath ?? String(song.extra?.filePath ?? '')
    if (!filePath) throw new ProviderError('empty', '本地文件记录不存在', this.info.id)
    const size = await fileSize(filePath)
    if (!size) throw new ProviderError('empty', '本地文件已被移动或删除', this.info.id)
    return {
      url: localUrl(filePath),
      quality: 'lossless',
      label: record?.qualityLabel ?? '本地文件',
      format: record?.ext ?? 'mp3',
      expiresAt: Number.MAX_SAFE_INTEGER
    }
  }

  async lyric(song: Song): Promise<Lyric | null> {
    const record = library.findById(song.id)
    if (!record?.lyricPath) return null
    try {
      const raw = await readFile(record.lyricPath, 'utf8')
      const parsed = parseLrc(raw)
      if (!parsed.lines.length && !parsed.plain) return null
      return {
        lines: parsed.lines,
        offset: parsed.offset,
        translated: false,
        source: '本地歌词',
        plain: parsed.plain
      }
    } catch {
      return null
    }
  }
}
