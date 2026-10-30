import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, extname, basename, resolve, relative, isAbsolute } from 'node:path'
import type { LibraryTrack } from '@shared/types'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * remote 是否比 current 新（自动更新用）。
 *
 * 为什么不写 `remote !== current`：两个更新源（GitCode / GitHub）的 latest.yml
 * 不保证同时更新。若当前源还停在旧版本，字符串不等会判成「发现新版本 v1.3.9」，
 * 用户点下去等于降级。必须按版本号逐段比大小。
 *
 * 不追求 semver 全语义（本项目不发预发布版）：逐段取数字，缺位按 0，
 * `1.3.10` 要大于 `1.3.9`（字符串比较会判反）。`-beta.1` 这类后缀按同版本处理。
 */
export function isNewerVersion(remote: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0)
  const next = parse(remote)
  const now = parse(current)
  for (let i = 0; i < 3; i += 1) {
    const left = next[i] ?? 0
    const right = now[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

/** 文件名非法字符（跨平台）+ 保留名 */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g

export function sanitizeFileName(input: string, maxLength = 120): string {
  const cleaned = (input || '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  const safe = cleaned || 'untitled'
  return safe.length > maxLength ? safe.slice(0, maxLength).trim() : safe
}

/** 同名文件自动追加 (1)(2)...，参考 musicdl SongInfo.save_path 的冲突消解 */
export async function uniqueFilePath(dir: string, base: string, ext: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  let candidate = join(dir, `${base}.${ext}`)
  let index = 1
  while (existsSync(candidate)) {
    candidate = join(dir, `${base} (${index}).${ext}`)
    index += 1
    if (index > 999) break
  }
  return candidate
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path)
    return info.size
  } catch {
    return 0
  }
}

export async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* ignore */
  }
}

export async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true })
  try {
    await rename(from, to)
  } catch {
    // 跨盘符时 rename 会失败，退化为复制
    const { copyFile } = await import('node:fs/promises')
    await copyFile(from, to)
    await safeUnlink(from)
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/**
 * 码点转字符。上游偶尔给出越界值（`&#x110000;`），`String.fromCodePoint` 会抛 RangeError，
 * 而这个函数跑在解析搜索结果的主路径上——一个脏实体就能把整次搜索打挂，所以兜住。
 */
function fromCodePointSafe(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** 平台接口大量使用 HTML 实体（酷我 &nbsp;、QQ &#58;），统一还原 */
export function decodeHtml(input: string): string {
  if (!input) return ''
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => fromCodePointSafe(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => fromCodePointSafe(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

export function extOf(path: string, fallback = 'mp3'): string {
  const ext = extname(path).replace('.', '').toLowerCase()
  return ext || fallback
}

export function stemOf(path: string): string {
  return basename(path, extname(path))
}

/** child 是否落在 parent 目录内（parent 自身不算）。win32 下盘符大小写由 path.relative 归一 */
export function isInsideDir(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const rel = relative(resolve(parent), resolve(child))
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 导出命名模板：{artist} {name} {album} {ext} */
export function renderNameTemplate(template: string, track: LibraryTrack): string {
  const fallback = basename(track.fileName, extname(track.fileName))
  const raw = (template || '{name}')
    .replace(/\{artist\}/gi, track.song.artists.join(', ') || '未知歌手')
    .replace(/\{name\}/gi, track.song.name || fallback)
    .replace(/\{album\}/gi, track.song.album || '')
    .replace(/\{ext\}/gi, track.ext)
    // 模板里某个字段为空时会留下「A -  - B」这种残渣，顺手收一下
    .replace(/(\s*-\s*){2,}/g, ' - ')
    .replace(/^[\s-]+|[\s-]+$/g, '')
  // 模板整条渲染为空（例如只写了 {album} 而专辑缺失）时优先回退歌名
  return sanitizeFileName(raw || track.song.name || fallback, 80)
}
