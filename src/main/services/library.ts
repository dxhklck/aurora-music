import { join } from 'node:path'
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { LibraryTrack, Song } from '@shared/types'
import { ensureDir, fileSize } from '../utils'
import { musicdl } from '../engine/musicdl'

/** 本地库识别的音频格式（与 Muse 播放支持的格式保持一致） */
const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'opus'])

/** 最多扫描两层目录：音乐文件夹常见「流派/专辑」两级分类，再深就是滥用 */
const MAX_SCAN_DEPTH = 2

/**
 * 本地音乐库：下载完成后的文件索引（元数据 sidecar 的真正来源）。
 * 用单个 JSON 文件原子落盘，避免引入额外依赖；条目以 `platform:songId` 去重。
 *
 * 除下载目录外还扫描「导入的本地目录」（settings.musicDirs）：
 * 这些文件没有 `platform:songId`，id 用 `local:<绝对路径>`，与下载条目天然区分。
 */
class LibraryService {
  private items: LibraryTrack[] = []
  private filePath = ''
  private loaded = false
  /** 要扫描的本地目录：下载目录 + 用户导入的目录 */
  private scanDirs: string[] = []

  configure(userDataDir: string): void {
    this.filePath = join(userDataDir, 'library.json')
  }

  /** 设置扫描目录（下载目录 + settings.musicDirs，调用方负责去重） */
  setScanDirs(dirs: string[]): void {
    this.scanDirs = dirs.filter(Boolean)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.filePath || !existsSync(this.filePath)) return
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as LibraryTrack[]
      if (Array.isArray(parsed)) this.items = parsed
    } catch {
      this.items = []
    }
    await this.prune()
  }

  /** 启动时校验文件是否还在，丢了就清理索引 */
  private async prune(): Promise<void> {
    const alive: LibraryTrack[] = []
    for (const item of this.items) {
      if (await fileSize(item.filePath)) alive.push(item)
    }
    if (alive.length !== this.items.length) {
      this.items = alive
      await this.persist()
    }
  }

  list(): LibraryTrack[] {
    return [...this.items].sort((a, b) => b.downloadedAt - a.downloadedAt)
  }

  findById(id: string): LibraryTrack | undefined {
    return this.items.find((item) => item.id === id)
  }

  findBySong(platform: string, songId: string): LibraryTrack | undefined {
    return this.findById(`${platform}:${songId}`)
  }

  async add(track: LibraryTrack): Promise<void> {
    this.items = this.items.filter((item) => item.id !== track.id)
    this.items.push(track)
    await this.persist()
  }

  async remove(id: string): Promise<LibraryTrack | undefined> {
    const target = this.findById(id)
    if (!target) return undefined
    this.items = this.items.filter((item) => item.id !== id)
    await this.persist()
    return target
  }

  async refresh(): Promise<LibraryTrack[]> {
    this.loaded = false
    await this.load()
    return this.list()
  }

  /** 元数据编辑允许改的三个字段；artist 用 `/` 或 `、` 分隔多个歌手 */
  async updateMeta(
    id: string,
    patch: { name?: string; artists?: string; album?: string }
  ): Promise<LibraryTrack | undefined> {
    const track = this.findById(id)
    if (!track) return undefined

    const name = (patch.name ?? track.song.name).trim()
    const album = (patch.album ?? track.song.album).trim()
    const rawArtists = (patch.artists ?? track.song.artists.join('/')).trim()
    const artists = rawArtists
      .split(/[\/、,，]/)
      .map((item) => item.trim())
      .filter(Boolean)

    track.song = { ...track.song, name: name || track.song.name, artists, album }
    await this.persist()

    // sidecar 决定「重启/重装后还能不能看到改动」，音频标签决定「换个播放器认不认」。
    // 两个都写，各写各的，一个失败不推翻另一个。
    const metaPath = track.metaPath ?? track.filePath.replace(/\.[^.]+$/, '.meta.json')
    try {
      let payload: Record<string, unknown> = {}
      if (existsSync(metaPath)) {
        payload = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      }
      // 只覆盖用户改的三个字段：sidecar 里还存着原始平台、音质、下载时间，别一起冲掉
      const previous = (payload.song as Record<string, unknown> | undefined) ?? {}
      payload.song = { ...previous, name: track.song.name, artists, album }
      await writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8')
      track.metaPath = metaPath
    } catch {
      /* sidecar 写失败不影响文件标签，继续往下走 */
    }

    try {
      await musicdl.tag({
        path: track.filePath,
        title: track.song.name,
        artists: artists.join('/'),
        album
      })
    } catch {
      /* 标签写入失败（不支持的容器/文件被占用）不阻断编辑，sidecar 已记住改动 */
    }

    return track
  }

  /**
   * 扫描本地目录，把新发现的音频文件登记进库。返回新增条目数。
   * 幂等：已登记的 filePath 直接跳过；无 sidecar 时从文件名猜「歌手 - 歌名」。
   */
  async scanLocalDirs(): Promise<number> {
    await this.load()
    const known = new Set(this.items.map((item) => item.filePath))
    const discovered: LibraryTrack[] = []

    for (const dir of this.scanDirs) {
      for await (const filePath of this.walkAudio(dir, 0)) {
        if (known.has(filePath)) continue
        known.add(filePath)
        const track = await this.buildFromFile(filePath)
        if (track) discovered.push(track)
      }
    }

    for (const track of discovered) {
      this.items = this.items.filter((item) => item.id !== track.id)
      this.items.push(track)
    }
    if (discovered.length) await this.persist()
    return discovered.length
  }

  /** 逐层列出目录里的音频文件（跳过子目录里的 .meta.json 等非音频） */
  private async *walkAudio(dir: string, depth: number): AsyncGenerator<string> {
    if (depth > MAX_SCAN_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // 目录不存在/无权限：跳过（用户可能已删除导入的文件夹）
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        yield* this.walkAudio(full, depth + 1)
      } else if (AUDIO_EXTS.has(entry.name.split('.').pop()?.toLowerCase() ?? '')) {
        yield full
      }
    }
  }

  /** 从磁盘文件构造库条目：优先读下载服务写的 .meta.json，其次按文件名猜 */
  private async buildFromFile(filePath: string): Promise<LibraryTrack | null> {
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath
    const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
    const size = (await fileSize(filePath)) ?? 0
    if (!size) return null

    const metaPath = filePath.replace(/\.[^.]+$/, '.meta.json')
    let song: Song | null = null
    let qualityLabel: string | undefined
    let lyricPath: string | undefined
    let downloadedAt = Date.now()
    try {
      if (existsSync(metaPath)) {
        const payload = JSON.parse(await readFile(metaPath, 'utf8')) as {
          song?: Song
          quality?: string
          downloadedAt?: number
        }
        if (payload.song?.name) {
          song = { ...payload.song, platform: 'local' }
          qualityLabel = payload.quality
          downloadedAt = payload.downloadedAt ?? downloadedAt
        }
      }
    } catch {
      /* sidecar 损坏不影响导入，退回文件名解析 */
    }
    if (!song) song = parseFileName(fileName)
    if (existsSync(filePath.replace(/\.[^.]+$/, '.lrc'))) {
      lyricPath = filePath.replace(/\.[^.]+$/, '.lrc')
    }

    return {
      id: `local:${filePath}`,
      song,
      filePath,
      fileName,
      size,
      ext,
      qualityLabel,
      lyricPath,
      metaPath: existsSync(metaPath) ? metaPath : undefined,
      downloadedAt
    }
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return
    await ensureDir(join(this.filePath, '..'))
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.items, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }
}

/** 从「歌手 - 歌名.mp3」这类常见命名里猜元数据；猜不出来就用文件名当歌名 */
function parseFileName(fileName: string): Song {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim()
  const dash = base.match(/^(.+?)\s+-\s+(.+)$/)
  return {
    id: `local:${fileName}`,
    platform: 'local',
    name: dash ? dash[2].trim() : base,
    artists: dash ? [dash[1].trim()] : [],
    album: '',
    coverUrl: null,
    duration: 0
  }
}

export const library = new LibraryService()
