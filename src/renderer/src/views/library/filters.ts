/**
 * 本地库的筛选、排序与**删除判定**（纯函数）。
 *
 * 从 `LibraryView.vue` 抽出来的原因是那一条：
 * `isInDownloadDir` 是整个应用里唯一决定「能不能真删用户文件」的判断，
 * 而它原来零测试。下载目录内的文件会被 `shell.trashItem` 真删，导入目录的只从库移除——
 * 判错一边是删掉用户的原始文件，不可挽回。
 *
 * 规则必须与主进程 `utils.isInsideDir`（`relative(resolve())`）语义一致：
 * 主进程才是权威，渲染层算错只会让确认框的数量对不上，不会造成误删；但「说删 3 个、
 * 实际删 2 个」本身就是 bug，所以两边按同一套语义实现。
 *
 * 零外部依赖（只有 type-only import），能被 `node --test` 直接跑。
 */
import type { LibraryTrack } from '@shared/types'

export type SortKey = 'added' | 'name' | 'artist' | 'album' | 'duration' | 'size' | 'ext'
export type SortDir = 'asc' | 'desc'
export type SourceFilter = '' | 'download' | 'imported'

export interface FilterCriteria {
  keyword: string
  artist: string
  album: string
  ext: string
  folder: string
  source: SourceFilter
}

export const EMPTY_FILTERS: FilterCriteria = {
  keyword: '',
  artist: '',
  album: '',
  ext: '',
  folder: '',
  source: ''
}

/** 所在文件夹：下载目录与导入目录常常混在一起，按目录收敛比翻列表快 */
export function dirOf(filePath: string): string {
  const index = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return index > 0 ? filePath.slice(0, index) : ''
}

/**
 * 归一化路径用于比较：统一分隔符、去尾斜杠、小写。
 *
 * 不做 `..` 折叠：文件路径来自扫描结果，一定是绝对路径；含 `..` 的输入按「不在
 * 下载目录内」处理（最保守的方向 —— 宁可只移除，也不误删）。
 */
export function normalizePath(filePath: string): string {
  return filePath.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 这个文件是否落在下载目录内（落在里面才允许真删）。
 *
 * 用 `root + '/'` 前缀而不是 `startsWith(root)`：后者会把
 * `D:/Music/Aurora Music2/a.mp3` 判成在 `D:/Music/Aurora Music` 里面。
 *
 * 下载目录是盘符根（`D:\`）时返回 false：那种设置下整个盘都算「下载目录」，
 * 一旦判断出错代价是删掉整盘的音乐。宁可全部走「仅从库移除」。
 */
export function isInDownloadDir(filePath: string, downloadDir: string): boolean {
  const root = normalizePath(downloadDir || '')
  if (!root || root.length <= 2) return false
  const target = normalizePath(filePath)
  if (!target) return false
  if (target.includes('/../') || target.endsWith('/..')) return false
  return target.startsWith(`${root}/`)
}

/** 导入条目的 id 是 local:<绝对路径>，下载条目是 <平台>:<songId>；比路径判断稳，改了下载目录也不会串 */
export function isImported(trackId: string): boolean {
  return trackId.startsWith('local:')
}

export function matchesFilters(track: LibraryTrack, criteria: FilterCriteria): boolean {
  if (criteria.artist && !track.song.artists.includes(criteria.artist)) return false
  if (criteria.album && track.song.album !== criteria.album) return false
  if (criteria.ext && track.ext !== criteria.ext) return false
  if (criteria.folder && dirOf(track.filePath) !== criteria.folder) return false
  if (criteria.source === 'download' && isImported(track.id)) return false
  if (criteria.source === 'imported' && !isImported(track.id)) return false
  const key = criteria.keyword.trim().toLowerCase()
  if (!key) return true
  return (
    track.song.name.toLowerCase().includes(key) ||
    track.song.album.toLowerCase().includes(key) ||
    track.song.artists.join(' ').toLowerCase().includes(key) ||
    track.fileName.toLowerCase().includes(key) ||
    track.filePath.toLowerCase().includes(key)
  )
}

export function applyFilters(items: LibraryTrack[], criteria: FilterCriteria): LibraryTrack[] {
  return items.filter((item) => matchesFilters(item, criteria))
}

/** 空值（空专辑 / 时长未知 / 无歌手）不参与比较，永远沉底 */
function isBlank(track: LibraryTrack, key: SortKey): boolean {
  if (key === 'album') return !track.song.album
  if (key === 'artist') return !track.song.artists.length
  if (key === 'duration') return !track.song.duration
  return false
}

export function compareTracks(
  a: LibraryTrack,
  b: LibraryTrack,
  key: SortKey,
  collator: Intl.Collator
): number {
  switch (key) {
    case 'name':
      return collator.compare(a.song.name, b.song.name)
    case 'artist':
      return collator.compare(a.song.artists.join('/'), b.song.artists.join('/'))
    case 'album':
      return collator.compare(a.song.album, b.song.album)
    case 'duration':
      return a.song.duration - b.song.duration
    case 'size':
      return a.size - b.size
    case 'ext':
      return collator.compare(a.ext, b.ext)
    default:
      return a.downloadedAt - b.downloadedAt
  }
}

export function sortTracks(
  items: LibraryTrack[],
  key: SortKey,
  dir: SortDir,
  collator: Intl.Collator
): LibraryTrack[] {
  const direction = dir === 'asc' ? 1 : -1
  return [...items].sort((a, b) => {
    const blankA = isBlank(a, key)
    const blankB = isBlank(b, key)
    // 空值沉底与排序方向无关：正序反序都在最后，否则反序时「无专辑」会跑到最前
    if (blankA !== blankB) return blankA ? 1 : -1
    return compareTracks(a, b, key, collator) * direction
  })
}

export interface PendingSplit {
  /** 落在下载目录内：可以真删（进回收站） */
  deletable: LibraryTrack[]
  /** 其余：只从库移除，磁盘上的文件不动 */
  imported: LibraryTrack[]
  /** 可删文件的总字节数；缺失文件不计入 */
  bytes: number
}

export function splitPending(items: LibraryTrack[], downloadDir: string): PendingSplit {
  const deletable: LibraryTrack[] = []
  const imported: LibraryTrack[] = []
  for (const item of items) {
    if (isInDownloadDir(item.filePath, downloadDir)) deletable.push(item)
    else imported.push(item)
  }
  const bytes = deletable.reduce((sum, item) => sum + (item.missing ? 0 : item.size), 0)
  return { deletable, imported, bytes }
}

/** 确认按钮文案：数字必须与实际会发生的操作一致，用户是照着它按下去的 */
export function confirmSummary(
  split: Pick<PendingSplit, 'deletable' | 'imported'>,
  mode: 'delete' | 'remove'
): string {
  const removable = split.deletable.length + split.imported.length
  if (mode === 'remove' || !split.deletable.length) return `从库移除 ${removable} 首`
  if (!split.imported.length) return `删除 ${split.deletable.length} 个文件`
  return `删除 ${split.deletable.length} 个 · 移除 ${split.imported.length} 个`
}
