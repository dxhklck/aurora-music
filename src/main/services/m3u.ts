/**
 * M3U / M3U8 播放列表的读写（纯函数，零依赖）。
 *
 * 为什么支持这个格式：它比任何私有格式都活得久。车机、foobar2000、VLC、
 * 手机上的各种播放器都认，用户把歌单导出到 U 盘就能带走——这与项目
 * 「本地优先、文件归用户」的定位一致。
 *
 * 只做**扩展 M3U**（`#EXTM3U` + `#EXTINF`）：
 * - 导出时写绝对路径，UTF-8 无 BOM；
 * - 导入时容错：BOM、CRLF、`#EXTINF` 带属性（`tvg-id="..."`）、
 *   只有路径没有元信息、相对路径，都要能读。
 */

export interface M3uTrack {
  /** 文件路径或远程地址，原样保留 */
  location: string
  /** 秒；`-1` 表示未知 */
  duration: number
  title: string
  artist: string
}

/** 导出用：时长按毫秒给，内部换算成秒（M3U 用整数秒） */
export interface M3uSource {
  path: string
  durationMs: number
  title: string
  artist: string
}

/** `#EXTINF:213,周杰伦 - 夜曲`；时长未知写 -1（VLC 与 foobar 都接受） */
export function buildM3u(entries: M3uSource[]): string {
  const lines: string[] = ['#EXTM3U']
  for (const entry of entries) {
    const seconds = entry.durationMs > 0 ? Math.round(entry.durationMs / 1000) : -1
    const label = [entry.artist, entry.title].filter(Boolean).join(' - ')
    lines.push(`#EXTINF:${seconds},${label}`)
    lines.push(entry.path)
  }
  return `${lines.join('\n')}\n`
}

/** `#EXTINF:213 tvg-id="x" group-title="y",标题` → 时长与标题 */
function parseExtinf(line: string): { duration: number; title: string } {
  // 去掉 `#EXTINF:` 前缀，先取最后一个逗号之后的部分当标题——
  // 属性里可能带逗号（group-title="Rock, Pop"），按第一个逗号切会切坏。
  const body = line.replace(/^#EXTINF:/i, '')
  const comma = body.lastIndexOf(',')
  const meta = comma >= 0 ? body.slice(0, comma) : body
  const title = comma >= 0 ? body.slice(comma + 1).trim() : ''
  // 时长是 meta 的第一个 token，可能是 -1 或带小数
  const match = /^\s*(-?\d+(?:\.\d+)?)/.exec(meta)
  const duration = match ? Math.round(Number.parseFloat(match[1])) : -1
  return { duration, title }
}

/** 把 `歌手 - 歌名` 拆开；拆不出来就整串当歌名 */
function splitTitle(title: string): { artist: string; title: string } {
  const separator = title.indexOf(' - ')
  if (separator <= 0) return { artist: '', title }
  return { artist: title.slice(0, separator).trim(), title: title.slice(separator + 3).trim() }
}

/**
 * 解析 M3U / M3U8 文本。
 *
 * 容错优先：这不是规范解析器，而是「尽量把别的播放器写出来的文件读进来」。
 * 空行、注释、没有 `#EXTINF` 的裸路径、Windows 反斜杠路径都接受。
 */
export function parseM3u(text: string): M3uTrack[] {
  const cleaned = text.replace(/^\uFEFF/, '')
  const lines = cleaned.split(/\r?\n/)
  const tracks: M3uTrack[] = []
  let pending: { duration: number; title: string } | null = null

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^#EXTINF/i.test(line)) {
      pending = parseExtinf(line)
      continue
    }
    // 其它 # 开头的是注释（#EXTM3U、#PLAYLIST:…、#EXTVLCOPT 等），跳过
    if (line.startsWith('#')) continue

    const split = pending ? splitTitle(pending.title) : { artist: '', title: '' }
    tracks.push({
      location: line,
      duration: pending?.duration ?? -1,
      title: split.title,
      artist: split.artist
    })
    pending = null
  }
  return tracks
}

/**
 * 相对路径按播放列表所在目录展开。
 *
 * 绝对路径直接返回：Windows 盘符（`C:\` / `C:/`）、UNC（`\\server\share`）、
 * POSIX 根（`/`）。其它一律拼到 baseDir 后面。
 */
export function resolveLocation(location: string, baseDir: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(location) || location.startsWith('\\\\') || location.startsWith('/')) {
    return location
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return location
  const separator = baseDir.includes('\\') ? '\\' : '/'
  const trimmed = baseDir.replace(/[\\/]+$/, '')
  // 去掉 `./` 与 `.\` 前缀：别的播放器常写相对路径，直接拼会得到 `D:\Music\.\a.mp3`
  const relative = location.replace(/^[\\/]+/, '').replace(/^(\.\\)+/, '').replace(/^(\.\/)+/, '')
  return `${trimmed}${separator}${relative}`
}
