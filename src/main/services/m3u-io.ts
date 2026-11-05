/**
 * M3U 的读写编排（文件系统 + 库匹配）。
 *
 * 纯格式逻辑在 `m3u.ts`，这里只做三件事：把歌单翻译成 M3U、把 M3U 里的路径
 * 匹配回库内条目、落盘/读盘。对话框留在 IPC 层，服务不碰 UI。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, extname, dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { LibraryTrack, Song } from '@shared/types'
import { library } from './library'
import { playlists } from './playlists'
import { buildM3u, parseM3u, resolveLocation } from './m3u'

export interface M3uExportResult {
  /** 写进文件的条数 */
  saved: number
  /** 无法写进 M3U 的条数（在线曲目、文件已不存在的本地曲目） */
  skipped: number
  path: string
}

export interface M3uImportResult {
  /** 新建的歌单 id；一条都没匹配上时为 null */
  playlistId: string | null
  name: string
  /** 文件里的总条数 */
  total: number
  /** 匹配回库并写进歌单的条数 */
  matched: number
  /** 库里找不到对应文件的条数 */
  missing: number
}

/** 比较用的路径归一化：分隔符统一、去尾斜杠、小写（Windows 语义） */
function normalize(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 歌单里的一首歌 → 磁盘路径。只认本地曲目；在线曲目没法写进 M3U。
 *
 * 两套 id 都要认：
 * - 库条目 id 是 `local:<绝对路径>`；
 * - 而 `song.id` 是 `local:<文件名>`（历史原因，见 library 的 fromTagsOrName）。
 * 只按其中一个查会漏掉另一半，表现为「导出 0 首」。
 */
function localPathOf(song: Song, byId: Map<string, LibraryTrack>): string | null {
  if (song.platform !== 'local') return null
  const track = byId.get(song.id)
  if (track) return track.filePath
  // 兜底：song.id 就是路径的老数据
  if (!song.id.startsWith('local:')) return null
  const raw = song.id.slice('local:'.length)
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(raw) ? raw : null
}

/**
 * 导出歌单到 M3U。
 *
 * 在线曲目一律跳过并计数：M3U 里写一个 http 地址，别的播放器既播不了（需要
 * 本项目的主进程代理与鉴权）也会误导用户「导出成功」。所以宁可明确告诉
 * 用户「N 首在线曲目未导出，先下载」。
 */
export async function exportPlaylistToM3u(id: string, filePath: string): Promise<M3uExportResult> {
  const playlist = playlists.list().find((item) => item.id === id)
  const byId = new Map<string, LibraryTrack>()
  for (const track of library.list()) {
    byId.set(track.id, track)
    // song.id 与条目 id 不一定相同（本地导入的 song.id 用的是文件名）
    if (!byId.has(track.song.id)) byId.set(track.song.id, track)
  }
  const entries: Array<{ path: string; durationMs: number; title: string; artist: string }> = []
  let skipped = 0

  for (const song of playlist?.songs ?? []) {
    const path = localPathOf(song, byId)
    if (!path || !existsSync(path)) {
      skipped += 1
      continue
    }
    entries.push({
      path,
      durationMs: song.duration,
      title: song.name,
      artist: song.artists.join(' / ')
    })
  }

  await writeFile(filePath, buildM3u(entries), 'utf8')
  return { saved: entries.length, skipped, path: filePath }
}

/**
 * 从 M3U 导入。
 *
 * 给了 `targetId` 就追加到那个歌单（收藏夹也允许），否则新建一个。
 * 路径匹配优先按完整路径（大小写与分隔符不敏感），失败再按「同目录 + 同文件名」
 * 兜一次——用户在另一台机器上导出的 M3U 往往目录不同但文件名不变。
 * 两次都匹配不上就算 missing，并在返回值里如实报数量。
 */
export async function importM3uFromFile(
  filePath: string,
  targetId?: string
): Promise<M3uImportResult> {
  const text = await readFile(filePath, 'utf8')
  const entries = parseM3u(text)
  const baseDir = dirname(resolve(filePath))

  const byPath = new Map<string, LibraryTrack>()
  const byName = new Map<string, LibraryTrack>()
  const duplicated = new Set<string>()
  for (const track of library.list()) {
    byPath.set(normalize(track.filePath), track)
    // 文件名只在唯一时可用：重名会让「按文件名兜底」随机匹配到错的曲目
    const key = track.fileName.toLowerCase()
    if (byName.has(key)) duplicated.add(key)
    else byName.set(key, track)
  }
  for (const key of duplicated) byName.delete(key)

  const songs: Song[] = []
  let missing = 0
  const seen = new Set<string>()

  for (const entry of entries) {
    // 远程地址（http/https）在本项目里无法直接播放，算缺失
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry.location)) {
      missing += 1
      continue
    }
    const absolute = resolveLocation(entry.location, baseDir)
    const track = byPath.get(normalize(absolute)) ?? byName.get(basename(absolute).toLowerCase())
    if (!track) {
      missing += 1
      continue
    }
    if (seen.has(track.id)) continue
    seen.add(track.id)
    songs.push(track.song)
  }

  const rawName = basename(filePath, extname(filePath)).trim() || '导入的歌单'
  if (!songs.length) {
    return { playlistId: targetId ?? null, name: rawName, total: entries.length, matched: 0, missing }
  }

  const target = targetId ? playlists.list().find((item) => item.id === targetId) : null
  if (target) {
    await playlists.addSongs(target.id, songs)
    return {
      playlistId: target.id,
      name: target.name,
      total: entries.length,
      matched: songs.length,
      missing
    }
  }

  const before = new Set(playlists.list().map((item) => item.id))
  const list = await playlists.create(rawName, songs)
  const created = list.find((item) => !item.builtin && !before.has(item.id))
  return {
    playlistId: created?.id ?? null,
    name: created?.name ?? rawName,
    total: entries.length,
    matched: songs.length,
    missing
  }
}
