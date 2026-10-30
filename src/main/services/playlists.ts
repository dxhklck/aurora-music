import { join } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { Playlist, Song } from '@shared/types'
import { FAVORITES_ID } from '@shared/types'
import { ensureDir } from '../utils'

const MAX_NAME = 40

const keyOf = (song: Song): string => `${song.platform}:${song.id}`

function isPlaylist(value: unknown): value is Playlist {
  const item = value as Playlist
  return !!item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.songs)
}

/** 同一首歌可能在多个平台存在，按 platform:id 去重 */
function dedupe(songs: Song[]): Song[] {
  const seen = new Set<string>()
  const result: Song[] = []
  for (const song of songs) {
    if (!song?.id || !song.platform) continue
    const key = keyOf(song)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
  }
  return result
}

/**
 * 收藏与自建歌单。
 * 和 library.json 一样用单文件原子写入；收藏夹是内置条目，始终存在且排在最前。
 */
class PlaylistService {
  private items: Playlist[] = []
  private filePath = ''
  private loaded = false

  configure(userDataDir: string): void {
    this.filePath = join(userDataDir, 'playlists.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (this.filePath && existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
        if (Array.isArray(parsed)) this.items = parsed.filter(isPlaylist)
      } catch {
        this.items = []
      }
    }
    this.ensureFavorites()
  }

  private ensureFavorites(): void {
    if (this.items.some((item) => item.id === FAVORITES_ID)) return
    const now = Date.now()
    this.items.unshift({
      id: FAVORITES_ID,
      name: '我喜欢',
      builtin: true,
      songs: [],
      createdAt: now,
      updatedAt: now
    })
  }

  /** 收藏夹固定置顶，其余按最近更新排序 */
  list(): Playlist[] {
    return [...this.items].sort((a, b) => {
      if (a.id === FAVORITES_ID) return -1
      if (b.id === FAVORITES_ID) return 1
      return b.updatedAt - a.updatedAt
    })
  }

  async create(name: string, songs: Song[] = []): Promise<Playlist[]> {
    const now = Date.now()
    this.items.push({
      id: `pl_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: this.normalizeName(name),
      songs: dedupe(songs),
      createdAt: now,
      updatedAt: now
    })
    await this.persist()
    return this.list()
  }

  async rename(id: string, name: string): Promise<Playlist[]> {
    const target = this.find(id)
    if (!target || target.builtin) return this.list()
    target.name = this.normalizeName(name)
    target.updatedAt = Date.now()
    await this.persist()
    return this.list()
  }

  async remove(id: string): Promise<Playlist[]> {
    const target = this.find(id)
    if (!target || target.builtin) return this.list()
    this.items = this.items.filter((item) => item.id !== id)
    await this.persist()
    return this.list()
  }

  async addSongs(id: string, songs: Song[]): Promise<Playlist[]> {
    const target = this.find(id)
    if (!target || !songs.length) return this.list()
    const merged = dedupe([...target.songs, ...songs])
    if (merged.length === target.songs.length) return this.list()
    target.songs = merged
    target.updatedAt = Date.now()
    await this.persist()
    return this.list()
  }

  async removeSong(id: string, platform: string, songId: string): Promise<Playlist[]> {
    const target = this.find(id)
    if (!target) return this.list()
    const next = target.songs.filter((song) => keyOf(song) !== `${platform}:${songId}`)
    if (next.length === target.songs.length) return this.list()
    target.songs = next
    target.updatedAt = Date.now()
    await this.persist()
    return this.list()
  }

  /**
   * 本地文件被真删后，把各歌单里指向它的条目一起清掉。
   * 不清就会留下永远播不了的死条目（local 音源找不到记录直接报错）。
   * 返回实际清掉的条目数。
   */
  async dropLocalTracks(libraryIds: string[]): Promise<number> {
    const keys = new Set(libraryIds.map((id) => `local:${id}`))
    let removed = 0
    for (const playlist of this.items) {
      const next = playlist.songs.filter((song) => !keys.has(keyOf(song)))
      if (next.length === playlist.songs.length) continue
      removed += playlist.songs.length - next.length
      playlist.songs = next
      playlist.updatedAt = Date.now()
    }
    if (removed) await this.persist()
    return removed
  }

  /**
   * 歌单内换位（手动排序）。
   * 边界不越界：已在顶/底时原样返回，避免 splice 出负索引或越界插入。
   */
  async moveSong(
    id: string,
    platform: string,
    songId: string,
    direction: 'up' | 'down'
  ): Promise<Playlist[]> {
    const target = this.find(id)
    if (!target) return this.list()
    const key = `${platform}:${songId}`
    const from = target.songs.findIndex((song) => keyOf(song) === key)
    const to = direction === 'up' ? from - 1 : from + 1
    if (from < 0 || to < 0 || to >= target.songs.length) return this.list()
    const [moved] = target.songs.splice(from, 1)
    target.songs.splice(to, 0, moved)
    // 不改 updatedAt：手动调序不应该让歌单在侧栏里跳到最前面
    await this.persist()
    return this.list()
  }

  /** 返回操作后是否处于「已收藏」状态 */
  async toggleFavorite(song: Song): Promise<{ list: Playlist[]; favorited: boolean }> {
    const favorites = this.find(FAVORITES_ID) ?? this.items[0]
    const key = keyOf(song)
    const exists = favorites.songs.some((item) => keyOf(item) === key)
    favorites.songs = exists
      ? favorites.songs.filter((item) => keyOf(item) !== key)
      : [song, ...favorites.songs]
    favorites.updatedAt = Date.now()
    await this.persist()
    return { list: this.list(), favorited: !exists }
  }

  private find(id: string): Playlist | undefined {
    return this.items.find((item) => item.id === id)
  }

  private normalizeName(name: string): string {
    const trimmed = (name || '').trim().slice(0, MAX_NAME)
    return trimmed || '新建歌单'
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return
    await ensureDir(join(this.filePath, '..'))
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.items, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }
}

export const playlists = new PlaylistService()
