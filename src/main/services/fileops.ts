import { join, extname, basename } from 'node:path'
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { shell } from 'electron'
import type { LibraryOpItem, LibraryOpReport, LibraryTrack } from '@shared/types'
import { renderNameTemplate, uniqueFilePath } from '../utils'

const run = promisify(execFile)

/**
 * 附属文件：下载服务写的歌词与元数据 sidecar。
 * 按路径推导而不是只读索引里的 metaPath/lyricPath——老条目可能没记这两个字段，
 * 只信记录就会把 sidecar 留成孤儿。
 */
export function companionFiles(filePath: string): string[] {
  const stem = filePath.replace(/\.[^.]+$/, '')
  return [`${stem}.lrc`, `${stem}.meta.json`].filter((path) => existsSync(path))
}

/**
 * 放进系统回收站。
 * 主文件失败就整体算失败（索引要保留）；附属文件失败只影响备注——
 * 音频已经进回收站了，不能因为一个 .lrc 删不掉就说删失败。
 */
export async function trashFiles(
  primary: string,
  extras: string[] = []
): Promise<{ ok: boolean; error?: string; extras: number }> {
  if (existsSync(primary)) {
    try {
      await shell.trashItem(primary)
    } catch (error) {
      return { ok: false, error: `移入回收站失败：${messageOf(error)}`, extras: 0 }
    }
  }
  let extrasDone = 0
  for (const path of extras) {
    if (!path || !existsSync(path)) continue
    try {
      await shell.trashItem(path)
      extrasDone += 1
    } catch {
      /* 附属文件删不掉不阻断主流程 */
    }
  }
  return { ok: true, extras: extrasDone }
}

export interface CopyOptions {
  /** 不传则沿用原文件名 */
  template?: string
  onProgress?: (done: number, total: number, current: string) => void
}

/**
 * 复制 / 导出。
 * 同名不覆盖：一律追加 (1)(2)，宁可留一份多余的，也不替用户做删除决定。
 */
export async function copyTracks(
  tracks: LibraryTrack[],
  targetDir: string,
  options: CopyOptions = {}
): Promise<LibraryOpReport> {
  await mkdir(targetDir, { recursive: true })
  const items: LibraryOpItem[] = []
  const total = tracks.length

  for (const [index, track] of tracks.entries()) {
    const name = track.song.name || track.fileName
    options.onProgress?.(index, total, name)
    if (track.missing) {
      items.push({ id: track.id, name, ok: false, note: '文件缺失，无法复制' })
      continue
    }
    const source = existsSync(track.filePath) ? track.filePath : ''
    if (!source) {
      items.push({ id: track.id, name, ok: false, note: '源文件不存在' })
      continue
    }
    try {
      const base = options.template
        ? renderNameTemplate(options.template, track)
        : basename(track.fileName, extname(track.fileName))
      const dest = await uniqueFilePath(targetDir, base, track.ext)
      await copyFile(source, dest)
      // 附属文件跟着改名，否则目标目录里会留下对不上号的 .lrc
      const destStem = dest.replace(/\.[^.]+$/, '')
      for (const path of companionFiles(source)) {
        const suffix = path.endsWith('.lrc') ? '.lrc' : '.meta.json'
        try {
          await copyFile(path, join(destStem + suffix))
        } catch {
          /* 附属文件复制失败不影响主文件 */
        }
      }
      items.push({ id: track.id, name, ok: true, action: options.template ? 'export' : 'copy' })
    } catch (error) {
      items.push({ id: track.id, name, ok: false, note: messageOf(error) })
    }
  }
  options.onProgress?.(total, total, '')

  const ok = items.filter((item) => item.ok).length
  return { ok, failed: items.length - ok, items, targetDir }
}

/**
 * 打开系统回收站。
 * 应用内不做「还原」——跨平台从回收站取回文件的成本远超收益，
 * 这里只把用户送到正确的地方，还原由系统自己完成。
 */
export async function openTrash(): Promise<void> {
  if (process.platform === 'win32') {
    await run('explorer.exe', ['shell:RecycleBinFolder']).catch(() => undefined)
    return
  }
  if (process.platform === 'darwin') {
    await run('open', [join(homedir(), '.Trash')]).catch(() => undefined)
    return
  }
  await shell.openPath(homedir())
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EBUSY') return '文件被占用（可能正在播放）'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限，可能被其他程序占用'
  if (code === 'ENOSPC') return '目标磁盘空间不足'
  if (code === 'ENOENT') return '文件或目录不存在'
  return error.message
}
