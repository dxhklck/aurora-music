import { createHash } from 'node:crypto'

/**
 * 文本与数值归一化。
 *
 * 这一层等价于上游 `musicdl.modules.utils.misc.legalizestring` 与本仓库
 * `engine_core._clean` 的组合。上游的 `legalizestring` 有一个必须保留的怪癖：
 * 空值返回字符串 `'NULL'` 而不是空串——各音源后续会用 `singers in {'NULL'}`
 * 之类的判断做二次分支（例如千千从歌词 `[ar:]` 反推歌手），把它改成空串会
 * 让这些分支静默失效。所以这里保留 `'NULL'` 语义，统一在 `cleanText` 里转空。
 */

export const NULL_STRING = 'NULL'

const NULLISH = new Set(['null', 'none', 'nil', 'undefined', 'n/a', 'na'])

/** 把上游的缺失值约定（null / 'NULL' / 'None' / 'N/A'）统一成空串 */
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return ''
  // 字段里的布尔值统一成 'True' / 'False' 拼写（JS 默认是 'true'），与上游文本一致
  const text = (typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value)).trim()
  return NULLISH.has(text.toLowerCase()) ? '' : text
}

/**
 * `int(float(value))` 的等价实现。
 *
 * 必须**整串**都是数字才算数：`'12abc'` 视为非法并返回默认值。早期版本用
 * `parseFloat` 取前导数字，会把 `'03:45'` 解析成 3——时长字段凭空变成 3 秒。
 * 数值字段一律走严格解析。
 */
export function toInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : fallback
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value !== 'string') return fallback
  const parsed = strictNumber(value)
  return parsed === null ? fallback : Math.trunc(parsed)
}

export function toFloat(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value !== 'string') return fallback
  const parsed = strictNumber(value)
  return parsed === null ? fallback : parsed
}

/** 整串匹配十进制/科学计数法；拒绝 `12abc`、`03:45`、`1,000` 这类脏值 */
function strictNumber(input: string): number | null {
  const text = input.trim()
  if (!text) return null
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null
  const parsed = Number.parseFloat(text)
  return Number.isFinite(parsed) ? parsed : null
}

/** 逐级取值，缺失时返回默认值；支持负数下标（上游用 imgItems[-1] 取末张图） */
export function safeGet(data: unknown, path: Array<string | number>, fallback?: unknown): unknown {
  let cursor: unknown = data
  for (const key of path) {
    if (cursor === null || cursor === undefined) return fallback
    if (typeof key === 'number') {
      if (!Array.isArray(cursor)) return fallback
      const index = key < 0 ? cursor.length + key : key
      cursor = cursor[index]
    } else {
      if (typeof cursor !== 'object') return fallback
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (cursor === undefined) return fallback
  }
  return cursor ?? fallback
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  hellip: '\u2026',
  middot: '\u00b7',
  mdash: '\u2014',
  ndash: '\u2013',
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  times: '\u00d7',
  divide: '\u00f7',
  deg: '\u00b0'
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const EMOJI_PATTERN =
  /[\u{1f000}-\u{1faff}\u{2600}-\u{27bf}\u{2b00}-\u{2bff}\u{fe00}-\u{fe0f}\u{1f1e6}-\u{1f1ff}\u{200d}]/gu

/**
 * 仅保留可打印字符。
 *
 * 规则按 Unicode 分类判定：分隔符（Zs 类）**除 ASCII 空格以外都算不可打印**，
 * 会被直接删掉。全角空格 U+3000 就在此列——如果按 JS 的 `\s` 折叠成普通空格，
 * `猴﹏子　￡` 会变成 `猴﹏子 ￡`，与上游结果差一个空格。
 */
function stripControlChars(input: string): string {
  let output = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    if (code >= 0x200b && code <= 0x200f) continue
    if (code === 0xfeff) continue
    if (code >= 0x2028 && code <= 0x202e) continue
    if (code >= 0xd800 && code <= 0xdfff) continue
    // Zs / Zl / Zp：只保留 ASCII 空格
    if (code !== 0x20 && (code === 0x00a0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000)) {
      continue
    }
    output += ch
  }
  return output
}

/**
 * 文件名安全化：**删除** Windows 非法字符，而不是替换成下划线。
 *
 * 这里必须与 pathvalidate 的默认行为一致（`replacement_text=''`）。
 * 替换成 `_` 会让「世界/Earth」变成「世界__Earth」，虽然更安全，但用户看到的
 * 专辑名会凭空多出下划线——迁移的第一要求是字段不被改写。
 */
/** Windows 保留设备名：pathvalidate 会在名字后补下划线（CON → CON_，aux.txt → aux_.txt） */
const RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

function sanitizeFilename(input: string, maxLength = 255): string {
  let text = input.replace(/[\\/:*?"<>|\r\n\t\u0000]/g, '')
  // 只去掉**结尾**的点和空白：pathvalidate 保留开头的 '...leading'
  text = text.replace(/[.\s]+$/, '')
  const dot = text.indexOf('.')
  const stem = dot < 0 ? text : text.slice(0, dot)
  if (RESERVED_NAMES.has(stem.toLowerCase())) {
    text = `${stem}_${dot < 0 ? '' : text.slice(dot)}`
  }
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

/**
 * 上游 `legalizestring` 的等价实现。
 *
 * 顺序与上游一致：修复转义 → 解实体 → 去标签 → NFC → 去 emoji → 去控制符 →
 * 文件名安全化 → 折叠空白。空结果返回 `'NULL'`（见文件头说明）。
 */
export function legalize(value: unknown, replaceNull = NULL_STRING): string {
  if (value === null || value === undefined || value === '') return replaceNull
  let text = String(value)
  // 上游先修 JSON 转义残留，再解两次 HTML 实体（部分接口会双重转义）
  text = text.replace(/\\\//g, '/').replace(/\\"/g, '"')
  text = text.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  text = decodeEntities(decodeEntities(text))
  // 去标签：等价 BeautifulSoup.get_text(separator='')
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<[^>]*>/g, '')
  text = text.normalize('NFC')
  text = text.replace(EMOJI_PATTERN, '')
  // BeautifulSoup(lxml) 会把 NUL 变成空格，而不是删掉；其余控制符仍然直接删除
  text = text.replace(/\u0000/g, ' ')
  text = stripControlChars(text)
  text = sanitizeFilename(text)
  text = text.replace(/\s+/g, ' ').trim()
  return text ? text : replaceNull
}

/** 等价 audio_link_tester 里的 byte2mb，仅用于日志与状态展示 */
export function bytesToMb(size: number): string {
  const mb = Math.round((size / 1024 / 1024) * 100) / 100
  if (!mb) return NULL_STRING
  // 整数兆字节必须补一位小数（输出 "1.0 MB" 而不是 "1 MB"），与上游文本格式一致
  return `${Number.isInteger(mb) ? mb.toFixed(1) : mb} MB`
}

/** 秒 → HH:MM:SS；0 或非法值返回 '-:-:-' */
export function secondsToHms(seconds: unknown): string {
  const total = toInt(seconds, 0)
  if (!total) return '-:-:-'
  const hh = Math.floor(total / 3600)
  const mm = Math.floor((total % 3600) / 60)
  const ss = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/**
 * 清洗 LRC：统一换行、去零宽字符，丢掉「只有时间轴没有正文」的空行。
 * 上游把这三个动作压成了一行 lambda，行为必须完全一致，否则歌词行数会对不上。
 */
export function cleanLrc(input: unknown): string {
  const text = String(input ?? '')
  const timeOnly = /^\[(\d{2}:)?\d{2}:\d{2}(?:\.\d{1,3})?\]$/
  const lines: string[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/^[\ufeff\u200b\u200c\u200d\u2060\u00a0 \t]+/, '').replace(/[\ufeff\u200b\u200c\u200d\u2060\u00a0 \t]+$/, '')
    if (!line) continue
    if (timeOnly.test(line)) continue
    lines.push(line)
  }
  return lines.join('\n')
}

/** 从 LRC 时间轴里取最晚时间点，作为时长兜底（上游 extractdurationsecondsfromlrc） */
export function durationFromLrc(lrc: string): number {
  if (!lrc || lrc === NULL_STRING) return 0
  const pattern = /\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g
  let max = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(lrc)) !== null) {
    const hh = match[1] ? Number.parseInt(match[1], 10) : 0
    const mm = Number.parseInt(match[2], 10)
    const ss = Number.parseInt(match[3], 10)
    const frac = match[4] ? Number.parseInt(match[4], 10) / 10 ** match[4].length : 0
    const total = hh * 3600 + mm * 60 + ss + frac
    if (total > max) max = total
  }
  // 上游返回 float（62.5 秒这类），转 int 由协议层 `_as_int` 负责，不能在这里提前截断
  return max
}

/**
 * 解析「1:02:03」「03:45」「1小时2分3秒」这类混合时长。
 * 上游在酷狗 / FMA 里各写了一份同构 lambda，这里收敛成一个函数。
 */
export function parseDurationText(input: unknown): number {
  const text = String(input ?? '').trim().toLowerCase()
  if (!text) return 0
  if (text.includes(':') || text.includes('：')) {
    const parts = text.replace(/：/g, ':').match(/\d+/g)?.map((item) => Number.parseInt(item, 10)) ?? []
    if (parts.length >= 3) return parts[parts.length - 3] * 3600 + parts[parts.length - 2] * 60 + parts[parts.length - 1]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 1) return parts[0]
    return 0
  }
  const hours = /(\d+)\s*(?:小时|时|h|hr)/.exec(text)
  const minutes = /(\d+)\s*(?:分钟|分|m|min)/.exec(text)
  const seconds = /(\d+)\s*(?:秒|s|sec)/.exec(text)
  const trailingSeconds = /(?:分钟|分|m|min)\s*(\d+)\b/.exec(text)
  const computed =
    (hours ? Number.parseInt(hours[1], 10) * 3600 : 0) +
    (minutes ? Number.parseInt(minutes[1], 10) * 60 : 0) +
    (seconds ? Number.parseInt(seconds[1], 10) : trailingSeconds ? Number.parseInt(trailingSeconds[1], 10) : 0)
  if (computed > 0) return computed
  const raw = /\d+/.exec(text)
  return raw ? Number.parseInt(raw[0], 10) : 0
}

/**
 * 模糊匹配用的归一化：只留 Unicode 字母与数字，忽略大小写与标点。
 *
 * 不能用 `[0-9a-z]` 近似——Unicode 字母表包含全角字母、西里尔文、天城文、假名。
 * 写成 ASCII 白名单会让 JioSaavn 的印地语歌名归一化
 * 成空串，token 失效后永远重定位不到。
 */
export function normalizeForMatch(input: string): string {
  let output = ''
  for (const ch of (input || '').toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) output += ch
  }
  return output
}

export function md5Hex(input: string | Uint8Array): string {
  return createHash('md5').update(input).digest('hex')
}

export function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex')
}

export function base64Decode(input: string): Buffer {
  return Buffer.from(input, 'base64')
}

export function base64Encode(input: string | Uint8Array): string {
  return Buffer.from(input as never).toString('base64')
}

/** 对象转 query string，保持插入顺序（urlencode 的等价实现） */
export function toQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    search.append(key, String(value))
  }
  return search.toString()
}
