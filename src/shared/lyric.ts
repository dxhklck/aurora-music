import type { Lyric, LyricLine, LyricWord } from './types'

/**
 * LRC 解析。设计参考 musicdl 的 cleanlrc / extractdurationsecondsfromlrc：
 * - 清洗 BOM、零宽字符、纯时间戳空行；
 * - 支持一行多时间戳（副歌复用同一句）、[offset:] 全局偏移；
 * - 支持 hh:mm:ss.xxx 与 mm:ss.xx 两种写法；
 * - 译文按时间戳合并，没有时间轴时降级为 plain。
 */

const META_RE = /^\[(ti|ar|al|by|offset|length|re|ve|kana):(.*)\]$/i
const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

const INVISIBLE_RE = /[\uFEFF\u200B\u200C\u200D\u2060\u00A0]/g

function fracToMs(frac?: string): number {
  if (!frac) return 0
  // 兼容 2 位（厘秒）与 3 位（毫秒）
  const padded = frac.length === 1 ? frac + '00' : frac.length === 2 ? frac + '0' : frac
  return Number(padded.slice(0, 3))
}

export interface ParsedLrc {
  lines: LyricLine[]
  offset: number
  plain: string
}

/** 解析 LRC 文本（不包含译文合并） */
export function parseLrc(raw: string): ParsedLrc {
  if (!raw) return { lines: [], offset: 0, plain: '' }

  const text = raw.replace(INVISIBLE_RE, '').replace(/\r\n?/g, '\n')
  let offset = 0
  const collected: LyricLine[] = []
  const plainLines: string[] = []
  let sawTimestamp = false

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const meta = line.match(META_RE)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const value = Number(meta[2].trim())
        if (Number.isFinite(value)) offset = value
      }
      continue
    }

    TIME_RE.lastIndex = 0
    const stamps: number[] = []
    let match: RegExpExecArray | null
    let lastEnd = 0
    while ((match = TIME_RE.exec(line)) !== null) {
      // 只有行首连续的时间戳才算，避免正文里出现 [00:12] 被误判
      if (match.index !== lastEnd) break
      lastEnd = match.index + match[0].length
      const min = Number(match[1])
      const sec = Number(match[2])
      stamps.push(min * 60_000 + sec * 1000 + fracToMs(match[3]))
      sawTimestamp = true
    }

    const content = line.slice(lastEnd).trim()
    if (!stamps.length) {
      if (content) plainLines.push(content)
      continue
    }
    // 纯时间戳空行直接丢弃（musicdl cleanlrc 的同一策略）
    if (!content) continue

    for (const time of stamps) collected.push({ time, text: content, translation: '' })
  }

  collected.sort((a, b) => a.time - b.time)

  // 同一时间戳去重（保留先出现的）
  const lines: LyricLine[] = []
  for (const item of collected) {
    const prev = lines[lines.length - 1]
    if (prev && Math.abs(prev.time - item.time) < 10 && prev.text === item.text) continue
    lines.push(item)
  }

  return {
    lines,
    offset,
    plain: sawTimestamp ? '' : plainLines.join('\n')
  }
}

/**
 * 解析逐字歌词（网易云 YRC）。两种行混排：
 *   1. `[行起始ms,行时长ms](字起始ms,字时长ms,0)字(…)字…` —— 真正的歌词行；
 *   2. `{"t":0,"c":[{"tx":"作词: "},{"tx":"唐恬"}]}` —— 制作人员信息，
 *      所有字段都是 t=0，塞进时间轴会变成一大坨 0 秒歌词，直接丢弃。
 *
 * 每个字的时间戳都是绝对毫秒，与 LyricLine.time 同一基准，方便 UI 直接算进度。
 */
export function parseYrc(raw: string): LyricLine[] {
  if (!raw) return []
  const text = raw.replace(INVISIBLE_RE, '').replace(/\r\n?/g, '\n')
  const lines: LyricLine[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('{') || line.startsWith('<')) continue

    const head = line.match(/^\[(\d+),(\d+)\]/)
    if (!head) continue

    const start = Number(head[1])
    const duration = Number(head[2])
    const body = line.slice(head[0].length)
    if (!body) continue

    const words: LyricWord[] = []
    const stampRe = /\((\d+),(\d+),-?\d+\)/g
    const stamps: Array<{ time: number; duration: number; from: number; end: number }> = []
    let match: RegExpExecArray | null
    while ((match = stampRe.exec(body)) !== null) {
      stamps.push({
        time: Number(match[1]),
        duration: Number(match[2]),
        from: match.index,
        end: match.index + match[0].length
      })
    }

    if (!stamps.length) {
      // 没有字级时间戳，退化成整行
      const plain = body.trim()
      if (plain) lines.push({ time: start, text: plain, translation: '' })
      continue
    }

    // 第一个时间戳之前若还有文字，算作行首片段
    const lead = body.slice(0, stamps[0].from)
    if (lead.trim()) {
      words.push({ time: start, duration: stamps[0].time - start || 1, text: lead })
    }

    for (let i = 0; i < stamps.length; i += 1) {
      const stamp = stamps[i]
      const next = stamps[i + 1]
      const chunk = body.slice(stamp.end, next ? next.from : body.length)
      if (!chunk) continue
      words.push({ time: stamp.time, duration: Math.max(1, stamp.duration), text: chunk })
    }

    const merged = words.map((word) => word.text).join('')
    if (!merged.trim()) continue
    lines.push({
      time: start,
      text: merged,
      translation: '',
      words,
      endTime: start + Math.max(1, duration)
    })
  }

  return lines
}

/**
 * 解析逐字歌词（QQ QRC）。与网易云 YRC 互为镜像：
 *   YRC：`[行起始,行时长](字起始,字时长,0)字(…)字…` —— 时间戳在前、文字在后；
 *   QRC：`[行起始,行时长]字(字起始,字时长)字(…)…` —— 文字在前、时间戳在后，
 *        括号里的第三个数（部分变体有）忽略。
 * 依据 Lyricify QRC 标准：时间戳不可乱序，文字段可以带空格（英文分词）。
 * 元数据行（[ti:]/[offset:] 等）与无时间戳行按 LRC 的同样策略处理。
 */
export function parseQrc(raw: string): ParsedLrc {
  if (!raw) return { lines: [], offset: 0, plain: '' }

  const text = raw.replace(INVISIBLE_RE, '').replace(/\r\n?/g, '\n')
  let offset = 0
  const lines: LyricLine[] = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const meta = line.match(META_RE)
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const value = Number(meta[2].trim())
        if (Number.isFinite(value)) offset = value
      }
      continue
    }

    const head = line.match(/^\[(\d+),(\d+)\]/)
    if (!head) continue

    const start = Number(head[1])
    const duration = Number(head[2])
    const body = line.slice(head[0].length)
    if (!body) continue

    // 文字在前：每个词的时间戳挂在它后面的括号里
    const stampRe = /\((\d+),(\d+)(?:,-?\d+)?\)/g
    const stamps: Array<{ time: number; duration: number; from: number; end: number }> = []
    let match: RegExpExecArray | null
    while ((match = stampRe.exec(body)) !== null) {
      stamps.push({
        time: Number(match[1]),
        duration: Number(match[2]),
        from: match.index,
        end: match.index + match[0].length
      })
    }

    if (!stamps.length) {
      // 整行只有一个时间戳（QRC 里的纯文本行）：退化成普通行
      const plain = body.trim()
      if (plain) lines.push({ time: start, text: plain, translation: '' })
      continue
    }

    const words: LyricWord[] = []
    let cursor = 0
    for (const stamp of stamps) {
      const chunk = body.slice(cursor, stamp.from)
      if (chunk) {
        words.push({ time: stamp.time, duration: Math.max(1, stamp.duration), text: chunk })
      }
      cursor = stamp.end
    }
    // 最后一个时间戳之后的残留文字（标点/空白）并回最后一个词
    const tail = body.slice(cursor)
    if (tail) {
      if (words.length) {
        const last = words[words.length - 1]
        last.text += tail
        last.duration = Math.max(last.duration, start + duration - last.time)
      } else {
        words.push({ time: start, duration: Math.max(1, duration), text: tail })
      }
    }

    words.sort((a, b) => a.time - b.time)
    const merged = words.map((word) => word.text).join('')
    if (!merged.trim()) continue
    lines.push({
      time: start,
      text: merged,
      translation: '',
      words,
      endTime: start + Math.max(1, duration)
    })
  }

  lines.sort((a, b) => a.time - b.time)
  return { lines, offset, plain: '' }
}

/** 合并译文：网易云/QQ 的译文时间戳与原文基本一致 */export function mergeTranslation(main: ParsedLrc, translation: ParsedLrc): ParsedLrc {
  if (!translation.lines.length) return main
  const byTime = new Map<number, string>()
  for (const line of translation.lines) {
    if (line.text) byTime.set(line.time, line.text)
  }
  let merged = 0
  const lines = main.lines.map((line) => {
    // 允许 50ms 误差
    let hit = byTime.get(line.time)
    if (hit === undefined) {
      for (const [time, value] of byTime) {
        if (Math.abs(time - line.time) <= 50) {
          hit = value
          break
        }
      }
    }
    if (hit) {
      merged += 1
      return { ...line, translation: hit }
    }
    return line
  })
  if (!merged) return main
  return { lines, offset: main.offset, plain: main.plain }
}

/**
 * 组装最终歌词对象。
 * 有逐字时间轴（yrc/qrc）时以它为准——它的行时间与字时间来自同一份数据，不会错位；
 * 否则退回普通 LRC。译文始终按时间戳合并。
 *
 * wordFormat 区分两种逐字格式的时间戳方向：'yrc' 时间戳在前（网易云），
 * 'qrc' 文字在前（QQ 音乐），默认 'yrc' 保持既有调用不变。
 */
export function buildLyric(
  mainRaw: string,
  translationRaw: string,
  source: string,
  wordRaw = '',
  wordFormat: 'yrc' | 'qrc' = 'yrc'
): Lyric {
  const lrc = parseLrc(mainRaw)
  const word =
    wordRaw
      ? wordFormat === 'qrc'
        ? parseQrc(wordRaw)
        : { lines: parseYrc(wordRaw), offset: 0 }
      : null
  const base: ParsedLrc =
    word && word.lines.length ? { lines: word.lines, offset: lrc.offset || word.offset, plain: '' } : lrc
  const merged = translationRaw ? mergeTranslation(base, parseLrc(translationRaw)) : base
  const translated = merged.lines.some((line) => Boolean(line.translation))
  return {
    lines: merged.lines,
    offset: merged.offset,
    translated,
    source,
    wordByWord: merged.lines.some((line) => Boolean(line.words?.length)),
    plain: merged.plain
  }
}

/**
 * 二分查找当前行。返回 -1 表示还没到第一句。
 * time 为已经加上 offset 的播放时间（ms）。
 */
export function findLyricIndex(lines: LyricLine[], time: number): number {
  if (!lines.length) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= time) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 把解析后的歌词重新序列化为 LRC，用于下载时落盘 .lrc 文件 */
export function lyricToLrc(lyric: Lyric): string {
  const head = lyric.offset ? `[offset:${lyric.offset}]\n` : ''
  const body = lyric.lines
    .map((line) => {
      const min = Math.floor(line.time / 60_000)
      const sec = Math.floor((line.time % 60_000) / 1000)
      const ms = line.time % 1000
      return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}]${line.text}`
    })
    .join('\n')
  return head + body
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00'
  const total = Math.floor(ms / 1000)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}
