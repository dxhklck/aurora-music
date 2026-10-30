import { join, basename, extname } from 'node:path'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { DuplicateGroup, LibraryOpItem, LibraryOpReport, LibraryTrack, Song } from '@shared/types'
import { ensureDir, fileSize, isInsideDir } from '../utils'
import { trashFiles, companionFiles } from './fileops'
import { musicdl } from '../engine/musicdl'

/** 本地库识别的音频格式（与 Muse 播放支持的格式保持一致） */
const AUDIO_EXTS = new Set(['mp3', 'flac', 'wav', 'm4a', 'ogg', 'aac', 'opus'])

/** 最多扫描两层目录：音乐文件夹常见「流派/专辑」两级分类，再深就是滥用 */
const MAX_SCAN_DEPTH = 2

/** 哈希并发：机械盘上开太多会互相拖慢，3 个足够吃满顺序读 */
const HASH_CONCURRENCY = 3

/** 「仅从库移除」的黑名单：同一路径、同大小、同修改时间才跳过，重新下载能正常回来 */
interface IgnoredEntry {
  path: string
  size: number
  mtime: number
}

interface FileStamp {
  size: number
  mtime: number
}

async function fileStamp(path: string): Promise<FileStamp | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtime: info.mtimeMs }
  } catch {
    return null
  }
}

/** 全量 sha256：只在同 size 的小组里算，成本可控 */
function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 有上限的并发映射：结果顺序与输入一致 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      result[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return result
}

function summarize(items: LibraryOpItem[], targetDir?: string): LibraryOpReport {
  const ok = items.filter((item) => item.ok).length
  return { ok, failed: items.length - ok, items, targetDir }
}

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
  private ignoredPath = ''
  private ignored: IgnoredEntry[] = []
  private loaded = false
  /** 要扫描的本地目录：下载目录 + 用户导入的目录 */
  private scanDirs: string[] = []

  configure(userDataDir: string): void {
    this.filePath = join(userDataDir, 'library.json')
    this.ignoredPath = join(userDataDir, 'library-ignored.json')
  }

  /** 设置扫描目录（下载目录 + settings.musicDirs，调用方负责去重） */
  setScanDirs(dirs: string[]): void {
    this.scanDirs = dirs.filter(Boolean)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!this.filePath) return
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as LibraryTrack[]
        if (Array.isArray(parsed)) this.items = parsed
      } catch {
        this.items = []
      }
    }
    if (existsSync(this.ignoredPath)) {
      try {
        const parsed = JSON.parse(await readFile(this.ignoredPath, 'utf8')) as IgnoredEntry[]
        if (Array.isArray(parsed)) this.ignored = parsed.filter((item) => typeof item?.path === 'string')
      } catch {
        this.ignored = []
      }
    }
    await this.prune()
  }

  /**
   * 启动时校验文件是否还在。
   * 找不到的条目不再直接删除——外接盘没插、文件夹被移动都会误伤，
   * 先前「移动一下目录就丢掉改好的元数据」就是这么来的。改为标记 missing，
   * 用户可以用「重新定位」救回来，或者主动清理。
   */
  private async prune(): Promise<void> {
    let changed = false
    for (const item of this.items) {
      const stamp = await fileStamp(item.filePath)
      if (stamp) {
        if (item.missing) {
          item.missing = false
          item.lastSeenPath = undefined
          changed = true
        }
      } else if (!item.missing) {
        item.missing = true
        item.lastSeenPath = item.filePath
        changed = true
      }
    }
    if (changed) await this.persist()
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

  /** 仅从库移除：文件留在磁盘，但记进黑名单，避免下次扫描又冒出来 */
  async remove(id: string): Promise<LibraryTrack | undefined> {
    const target = this.findById(id)
    if (!target) return undefined
    await this.forget(target)
    await this.persist()
    return target
  }

  async refresh(): Promise<LibraryTrack[]> {
    this.loaded = false
    await this.load()
    return this.list()
  }

  /**
   * 把补丁合并进条目：只覆盖 patch 里出现过的字段。
   * 返回值表示有没有实际变化——没变就不落盘、不写文件，批量操作才不会白跑。
   */
  private mergeMeta(
    track: LibraryTrack,
    patch: { name?: string; artists?: string; album?: string }
  ): boolean {
    const next = { ...track.song }
    if (patch.name !== undefined) next.name = patch.name.trim() || track.song.name
    if (patch.album !== undefined) next.album = patch.album.trim()
    if (patch.artists !== undefined) {
      next.artists = patch.artists
        .split(/[\/、,，]/)
        .map((item) => item.trim())
        .filter(Boolean)
    }
    const changed =
      next.name !== track.song.name ||
      next.album !== track.song.album ||
      next.artists.join('\u0000') !== track.song.artists.join('\u0000')
    if (changed) track.song = next
    return changed
  }

  /**
   * sidecar 决定「重启/重装后还能不能看到改动」，音频标签决定「换个播放器认不认」。
   * 两个都写，各写各的，一个失败不推翻另一个；返回给用户看的备注。
   */
  private async writeMetaFiles(track: LibraryTrack): Promise<string | undefined> {
    const notes: string[] = []
    const metaPath = track.metaPath ?? track.filePath.replace(/\.[^.]+$/, '.meta.json')
    try {
      let payload: Record<string, unknown> = {}
      if (existsSync(metaPath)) {
        payload = JSON.parse(await readFile(metaPath, 'utf8')) as Record<string, unknown>
      }
      // 只覆盖用户改的三个字段：sidecar 里还存着原始平台、音质、下载时间，别一起冲掉
      const previous = (payload.song as Record<string, unknown> | undefined) ?? {}
      payload.song = {
        ...previous,
        name: track.song.name,
        artists: track.song.artists,
        album: track.song.album
      }
      await writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8')
      track.metaPath = metaPath
    } catch {
      notes.push('元数据文件写入失败')
    }

    try {
      await musicdl.tag({
        path: track.filePath,
        title: track.song.name,
        artists: track.song.artists.join('/'),
        album: track.song.album
      })
    } catch {
      notes.push('音频标签写入失败（索引已更新）')
    }
    return notes.length ? notes.join('，') : undefined
  }

  /**
   * 元数据编辑允许改的三个字段；artist 用 `/` 或 `、` 分隔多个歌手
   */
  async updateMeta(
    id: string,
    patch: { name?: string; artists?: string; album?: string }
  ): Promise<LibraryTrack | undefined> {
    const track = this.findById(id)
    if (!track) return undefined
    if (this.mergeMeta(track, patch)) {
      await this.persist()
      await this.writeMetaFiles(track)
    }
    return track
  }

  /**
   * 批量改标签：只处理歌手/专辑（歌名逐首不同），缺省字段保持原样。
   * 索引统一落盘一次，文件标签逐首写——两百首也不会触发两百次全量 JSON 写。
   */
  async updateMetaMany(
    ids: string[],
    patch: { artists?: string; album?: string }
  ): Promise<LibraryOpReport> {
    const items: LibraryOpItem[] = []
    const dirty: LibraryTrack[] = []

    for (const id of ids) {
      const track = this.findById(id)
      if (!track) {
        items.push({ id, name: id, ok: false, note: '条目已不在库中' })
        continue
      }
      if (!this.mergeMeta(track, patch)) {
        items.push({ id, name: track.song.name, ok: true, action: 'meta', note: '内容未变化' })
        continue
      }
      dirty.push(track)
      items.push({ id, name: track.song.name, ok: true, action: 'meta' })
    }

    if (dirty.length) {
      await this.persist()
      for (const track of dirty) {
        const note = await this.writeMetaFiles(track)
        if (!note) continue
        const row = items.find((item) => item.id === track.id)
        if (row) row.note = note
      }
    }

    return {
      ok: items.filter((item) => item.ok).length,
      failed: items.filter((item) => !item.ok).length,
      items
    }
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
        if (await this.isIgnored(filePath)) continue
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

  // ---------------- 删除 / 批量移除 ----------------

  /**
   * 真删。
   * 只有落在下载目录内的文件才会动磁盘（走系统回收站）；
   * 导入目录是用户自己的原始文件，可能是唯一副本，只从索引里移除。
   */
  async deleteFiles(ids: string[], allowedDir: string): Promise<LibraryOpReport> {
    await this.load()
    const items: LibraryOpItem[] = []

    for (const id of ids) {
      const track = this.findById(id)
      if (!track) {
        items.push({ id, name: id, ok: false, note: '记录已不存在' })
        continue
      }
      const name = track.song.name || track.fileName

      if (!allowedDir || !isInsideDir(track.filePath, allowedDir)) {
        await this.forget(track)
        items.push({
          id,
          name,
          ok: true,
          action: 'remove',
          note: '不在下载目录内（导入文件），仅从库移除'
        })
        continue
      }

      if (track.missing) {
        this.drop(id)
        items.push({ id, name, ok: true, action: 'remove', note: '文件已不在磁盘，已清理条目' })
        continue
      }

      const companions = [
        ...new Set([
          ...companionFiles(track.filePath),
          ...[track.metaPath, track.lyricPath].filter((path): path is string => !!path && existsSync(path))
        ])
      ]
      const result = await trashFiles(track.filePath, companions)
      if (!result.ok) {
        // 主文件没删成功就保留条目：失败的不能算删过
        items.push({ id, name, ok: false, note: result.error })
        continue
      }
      this.drop(id)
      items.push({
        id,
        name,
        ok: true,
        action: 'trash',
        note: result.extras ? `含 ${result.extras} 个附属文件` : undefined
      })
    }

    await this.persist()
    return summarize(items)
  }

  /** 批量仅移除：不碰磁盘文件 */
  async removeMany(ids: string[]): Promise<LibraryOpReport> {
    await this.load()
    const items: LibraryOpItem[] = []
    for (const id of ids) {
      const track = this.findById(id)
      if (!track) {
        items.push({ id, name: id, ok: false, note: '记录已不存在' })
        continue
      }
      await this.forget(track)
      items.push({ id, name: track.song.name || track.fileName, ok: true, action: 'remove' })
    }
    await this.persist()
    return summarize(items)
  }

  /** 清理所有缺失条目 */
  async purgeMissing(): Promise<number> {
    await this.load()
    const before = this.items.length
    this.items = this.items.filter((item) => !item.missing)
    const removed = before - this.items.length
    if (removed) await this.persist()
    return removed
  }

  /**
   * 重新定位：按文件名把缺失条目重新绑定到新目录。
   * id 保持不变——id 只是索引键，播放时靠 findById 取 filePath，
   * 改了 id 反而会让歌单里的引用全部失效。
   */
  async relocate(dir: string): Promise<number> {
    await this.load()
    const missing = this.items.filter((item) => item.missing)
    if (!missing.length) return 0

    const pool = new Map<string, string[]>()
    for await (const path of this.walkAudio(dir, 0)) {
      const key = basename(path).toLowerCase()
      const list = pool.get(key) ?? []
      list.push(path)
      pool.set(key, list)
    }

    const used = new Set(
      this.items.filter((item) => !item.missing).map((item) => item.filePath.toLowerCase())
    )
    let fixed = 0
    for (const track of missing) {
      const candidates = pool.get(track.fileName.toLowerCase()) ?? []
      const target = candidates.find((path) => !used.has(path.toLowerCase()))
      if (!target) continue
      used.add(target.toLowerCase())
      const stem = target.replace(/\.[^.]+$/, '')
      track.filePath = target
      track.fileName = basename(target)
      track.ext = extname(target).replace('.', '').toLowerCase() || track.ext
      track.size = (await fileSize(target)) || track.size
      track.missing = false
      track.lastSeenPath = undefined
      track.metaPath = existsSync(`${stem}.meta.json`) ? `${stem}.meta.json` : undefined
      track.lyricPath = existsSync(`${stem}.lrc`) ? `${stem}.lrc` : undefined
      fixed += 1
    }
    if (fixed) await this.persist()
    return fixed
  }

  // ---------------- 重复识别 ----------------

  /**
   * 重复文件扫描。
   * 先按大小分组（免费的粗筛），只对同 size 的组算 sha256，
   * 避免为几千首没重复的歌白读一遍磁盘。
   */
  async duplicates(): Promise<DuplicateGroup[]> {
    await this.load()
    const alive = this.items.filter((item) => !item.missing && item.size > 0)

    const bySize = new Map<number, LibraryTrack[]>()
    for (const track of alive) {
      const list = bySize.get(track.size) ?? []
      list.push(track)
      bySize.set(track.size, list)
    }
    const candidates: LibraryTrack[] = []
    for (const list of bySize.values()) if (list.length > 1) candidates.push(...list)

    const hashes = await mapLimit(candidates, HASH_CONCURRENCY, async (track) => {
      try {
        return await hashFile(track.filePath)
      } catch {
        return ''
      }
    })

    const byHash = new Map<string, LibraryTrack[]>()
    candidates.forEach((track, index) => {
      const hash = hashes[index]
      if (!hash) return
      const key = `${track.size}:${hash}`
      const list = byHash.get(key) ?? []
      list.push(track)
      byHash.set(key, list)
    })

    const groups: DuplicateGroup[] = []
    const identicalIds = new Set<string>()
    for (const list of byHash.values()) {
      if (list.length < 2) continue
      list.forEach((track) => identicalIds.add(track.id))
      groups.push({
        kind: 'identical',
        label: `${list[0].song.name} · 完全一致 ×${list.length}`,
        ids: list.map((track) => track.id)
      })
    }

    // 同曲不同音质：歌名+歌手一致、时长接近（都已知）但内容不同
    const bySong = new Map<string, LibraryTrack[]>()
    for (const track of alive) {
      if (identicalIds.has(track.id)) continue
      if (!track.song.duration) continue
      const artists = [...track.song.artists].sort().join('/')
      const key = `${track.song.name.trim().toLowerCase()}|${artists.toLowerCase()}`
      const list = bySong.get(key) ?? []
      list.push(track)
      bySong.set(key, list)
    }
    for (const list of bySong.values()) {
      if (list.length < 2) continue
      const durations = list.map((item) => item.song.duration)
      if (Math.max(...durations) - Math.min(...durations) > 2000) continue
      groups.push({
        kind: 'similar',
        label: `${list[0].song.name} · 不同音质 ×${list.length}`,
        ids: list.map((track) => track.id)
      })
    }

    return groups.sort((a, b) => b.ids.length - a.ids.length)
  }

  // ---------------- 内部 ----------------

  private drop(id: string): void {
    this.items = this.items.filter((item) => item.id !== id)
  }

  /** 移除索引 + 记黑名单 */
  private async forget(track: LibraryTrack): Promise<void> {
    this.drop(track.id)
    const stamp = await fileStamp(track.filePath)
    if (!stamp) return
    this.ignored = this.ignored.filter((entry) => entry.path !== track.filePath)
    this.ignored.push({ path: track.filePath, size: stamp.size, mtime: stamp.mtime })
    // 黑名单只保留最近 2000 条：它只防「误移除后又自动回来」，没有长期价值
    if (this.ignored.length > 2000) this.ignored = this.ignored.slice(-2000)
  }

  private async isIgnored(filePath: string): Promise<boolean> {
    if (!this.ignored.length) return false
    const entry = this.ignored.find((item) => item.path === filePath)
    if (!entry) return false
    const stamp = await fileStamp(filePath)
    if (!stamp) return false
    return stamp.size === entry.size && stamp.mtime === entry.mtime
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return
    await ensureDir(join(this.filePath, '..'))
    await writeAtomic(this.filePath, JSON.stringify(this.items, null, 2))
    await writeAtomic(this.ignoredPath, JSON.stringify(this.ignored, null, 2))
  }
}

/** 单文件原子落盘：先写 .tmp 再 rename，避免写一半掉电留下半个 JSON */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
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
