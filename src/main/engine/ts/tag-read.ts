/**
 * 音频标签**读取**（只读，不改文件）。
 *
 * 与 `tag.ts` 的分工：那边负责写（下载入库时刷标签），这边负责读（扫描本地库时
 * 把歌手/专辑/时长/封面填对）。两边共享的只有「知道 ID3/FLAC/MP4 长什么样」这点
 * 领域知识，代码路径完全独立——写路径要重建容器，读路径只需要定位与解码。
 *
 * ## 为什么不是 `readFile` 一把梭
 *
 * 现有的三个写入器都是 `readFile(整个文件)`。写标签时可以接受（本来就要重写整个
 * 文件），**扫描曲库时不行**：300 首里混几首 100MB 无损，峰值内存与耗时都不可接受。
 * 所以这里全部走 `open()` + 定长 `read()`，只读需要的那几段：
 *
 * - mp3：前 10 字节拿 ID3 长度，再读 tag 区间；时长靠第一帧的 Xing/Info
 * - flac：`fLaC` 后逐块游标，只读 STREAMINFO / VORBIS_COMMENT / PICTURE 三块
 * - m4a：顶层 atom 游标跨过 `mdat`（音频数据，可能是文件 99%），只读 `moov`
 * - ogg：读首页拿 ident + comment，读末页拿 granule 算时长
 *
 * ## 单项自包含
 *
 * 这个文件**不 import 任何其它 src 模块**。原因很实际：Node 原生测试跑 `.ts` 时，
 * 无扩展名的相对导入解析不了，而带 `.ts` 扩展名又给 electron-vite 的构建添麻烦。
 * 400 行换来「能被 `node --test` 直接跑」，值。
 */
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

export type AudioContainer = 'mp3' | 'flac' | 'm4a' | 'ogg' | 'unknown'

export interface TagCover {
  /** 图片 MIME，直接从容器里读出来的原始声明 */
  mime: string
  data: Buffer
}

export interface TagFields {
  container: AudioContainer
  title?: string
  artists?: string[]
  album?: string
  /** 毫秒。拿不到就是 undefined —— 宁可「未参与比对」，不要「参与但判错」 */
  duration?: number
  cover?: TagCover
}

/** ID3 标签区读取上限：有些文件的封面能到几 MB，但不该为它读进整个文件 */
const MAX_ID3_BYTES = 20 * 1024 * 1024
/** 封面本体上限：超过 8MB 的图不可能是正常专辑封面，按脏数据丢弃 */
const MAX_COVER_BYTES = 8 * 1024 * 1024
/** moov 读取上限：正常 mp4 的 moov 是几百 KB，超过这个数字说明文件结构异常 */
const MAX_MOOV_BYTES = 64 * 1024 * 1024

class Reader {
  // 显式声明而非构造函数参数属性：Node 的 strip-only 类型擦除不支持后者
  private readonly fh: FileHandle
  readonly size: number

  private constructor(fh: FileHandle, size: number) {
    this.fh = fh
    this.size = size
  }

  static async open(filePath: string): Promise<Reader> {
    const fh = await open(filePath, 'r')
    const stat = await fh.stat()
    return new Reader(fh, stat.size)
  }

  /** 读指定区间；越界自动截断，返回实际读到的字节 */
  async at(position: number, length: number): Promise<Buffer> {
    const start = Math.max(0, Math.min(position, this.size))
    const want = Math.max(0, Math.min(length, this.size - start))
    if (!want) return Buffer.alloc(0)
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await this.fh.read(buffer, 0, want, start)
    return bytesRead === want ? buffer : buffer.subarray(0, bytesRead)
  }

  async head(length: number): Promise<Buffer> {
    return this.at(0, length)
  }

  /** 从尾部读一段（ogg 取 granule 用） */
  async tail(length: number): Promise<Buffer> {
    return this.at(Math.max(0, this.size - length), length)
  }

  async close(): Promise<void> {
    await this.fh.close().catch(() => undefined)
  }
}

// ─────────────────────────── 通用小工具 ───────────────────────────

/** 去掉结尾的 \0 与空白 */
function trimText(value: string): string {
  return value.replace(/\0+$/g, '').replace(/^\0+/, '').trim()
}

/** 文本帧的多值拆分：\0 是 v2.4 的分隔符，/ 是 v2.3 的约定 */
function splitArtists(value: string): string[] {
  return value
    .split('\u0000')
    .flatMap((part) => part.split('/'))
    .map((part) => part.trim())
    .filter(Boolean)
}

function mimeFromName(name: string): string {
  const ext = name.toLowerCase().replace(/^\./, '')
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

function guessMime(data: Buffer): string {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF') return 'image/webp'
  return 'image/jpeg'
}

// ─────────────────────────── MP3 / ID3 ───────────────────────────

function decodeId3Text(payload: Buffer): string {
  if (!payload.length) return ''
  const encoding = payload[0]
  const body = payload.subarray(1)
  if (encoding === 0) return trimText(body.toString('latin1'))
  if (encoding === 3) return trimText(body.toString('utf8'))
  if (encoding === 1) {
    // UTF-16 with BOM
    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
      return trimText(body.subarray(2).toString('utf16le'))
    }
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
      return trimText(swap16(body.subarray(2)).toString('utf16le'))
    }
    return trimText(body.toString('utf16le'))
  }
  // encoding 2 = UTF-16BE 无 BOM
  return trimText(swap16(body).toString('utf16le'))
}

/** UTF-16BE → UTF-16LE：按 2 字节交换 */
function swap16(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer)
  for (let i = 0; i + 1 < copy.length; i += 2) {
    const low = copy[i]
    copy[i] = copy[i + 1]
    copy[i + 1] = low
  }
  return copy
}

interface Id3Result {
  title?: string
  artists?: string[]
  album?: string
  /** TLEN 的值，可能是 0 或不准 */
  duration?: number
  cover?: TagCover
  /** 标签字节数：音频第一帧从这里开始 */
  tagSize: number
  version: number
}

/** 解析 APIC / PIC 帧：编码 + MIME + 图片类型 + 描述 + 数据 */
function parseApic(payload: Buffer, v22: boolean): TagCover | null {
  if (payload.length < 4) return null
  const encoding = payload[0]
  let cursor = 1
  let mime: string
  if (v22) {
    // v2.2 是 3 字节图片格式（'JPG' / 'PNG'），没有 MIME 字符串
    const format = payload.subarray(1, 4).toString('ascii')
    mime = mimeFromName(format)
    cursor = 4
  } else {
    const end = payload.indexOf(0, cursor)
    if (end < 0) return null
    mime = payload.toString('latin1', cursor, end) || 'image/jpeg'
    cursor = end + 1
  }
  cursor += 1 // picture type
  // 描述串按同样的编码对齐（UTF-16 是双字节 \0\0）
  if (encoding === 1 || encoding === 2) {
    while (cursor + 1 < payload.length) {
      if (payload[cursor] === 0 && payload[cursor + 1] === 0) {
        cursor += 2
        break
      }
      cursor += 2
    }
  } else {
    const end = payload.indexOf(0, cursor)
    cursor = end < 0 ? payload.length : end + 1
  }
  const data = payload.subarray(cursor)
  if (!data.length || data.length > MAX_COVER_BYTES) return null
  return { mime: mime.includes('/') ? mime : guessMime(data), data: Buffer.from(data) }
}

function parseId3(buf: Buffer, withCover: boolean): Id3Result {
  const empty: Id3Result = { tagSize: 0, version: 0 }
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return empty
  const version = buf[3]
  const flags = buf[5]
  const tagSize =
    ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f)
  // v2.4 的 footer 也算在 tagSize 之外
  const audioStart = 10 + tagSize + (version === 4 && flags & 0x10 ? 10 : 0)
  const body = buf.subarray(10, Math.min(buf.length, 10 + tagSize))
  const v22 = version === 2
  const headerSize = v22 ? 6 : 10

  const result: Id3Result = { tagSize: audioStart, version }
  let cursor = 0
  while (cursor + headerSize <= body.length) {
    const id = body.toString('ascii', cursor, cursor + (v22 ? 3 : 4))
    if (!/^[A-Z0-9]+$/.test(id)) break
    const size = v22
      ? (body[cursor + 3] << 16) | (body[cursor + 4] << 8) | body[cursor + 5]
      : version === 4
        ? ((body[cursor + 4] & 0x7f) << 21) |
          ((body[cursor + 5] & 0x7f) << 14) |
          ((body[cursor + 6] & 0x7f) << 7) |
          (body[cursor + 7] & 0x7f)
        : body.readUInt32BE(cursor + 4)
    const start = cursor + headerSize
    if (size <= 0 || start + size > body.length) break
    const payload = body.subarray(start, start + size)

    if (id === 'TIT2' || id === 'TT2') result.title = decodeId3Text(payload)
    else if (id === 'TPE1' || id === 'TP1') result.artists = splitArtists(decodeId3Text(payload))
    else if (id === 'TALB' || id === 'TAL') result.album = decodeId3Text(payload)
    else if (id === 'TLEN' || id === 'TLE') {
      const ms = Number.parseInt(decodeId3Text(payload), 10)
      if (Number.isFinite(ms) && ms > 0) result.duration = ms
    } else if (withCover && (id === 'APIC' || id === 'PIC') && !result.cover) {
      const cover = parseApic(payload, v22)
      if (cover) result.cover = cover
    }
    cursor = start + size
  }
  return result
}

/** MPEG 音频帧头 → 采样率、每帧样本数、声道数；不是合法帧返回 null */
function mpegFrameInfo(buf: Buffer): { sampleRate: number; samples: number; mono: boolean } | null {
  if (buf.length < 4) return null
  if (buf[0] !== 0xff || (buf[1] & 0xe0) !== 0xe0) return null
  const versionBits = (buf[1] >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (buf[1] >> 1) & 0x03 // 1=Layer3
  if (layerBits !== 1) return null
  const rateIndex = (buf[2] >> 2) & 0x03
  if (rateIndex === 3) return null
  const rates: Record<number, number[]> = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000]
  }
  const sampleRate = rates[versionBits]?.[rateIndex]
  if (!sampleRate) return null
  return {
    sampleRate,
    samples: versionBits === 3 ? 1152 : 576,
    mono: (buf[3] >> 6) === 3
  }
}

/**
 * 从第一帧的 Xing/Info 头读总帧数算时长。
 *
 * 这不是估算：Xing/Info 是编码器写在第一帧里的精确帧数（LAME 的 VBR 文件必有）。
 * 拿不到就返回 undefined —— 绝不做「文件大小 ÷ 比特率」那种估算，VBR 下误差能到
 * 一分钟，而时长会参与「同曲不同音质」的比对（阈值 2 秒），错的值比没有更糟。
 */
function readXingDuration(frame: Buffer, info: { sampleRate: number; samples: number; mono: boolean }): number | undefined {
  const sideInfo = info.samples === 1152 ? (info.mono ? 17 : 32) : info.mono ? 9 : 17
  const base = 4 + sideInfo
  if (frame.length < base + 8) return undefined
  const tag = frame.toString('ascii', base, base + 4)
  if (tag !== 'Xing' && tag !== 'Info') return undefined
  const flags = frame.readUInt32BE(base + 4)
  if (!(flags & 0x01)) return undefined
  const frames = frame.readUInt32BE(base + 8)
  if (!frames) return undefined
  return Math.round((frames * info.samples * 1000) / info.sampleRate)
}

async function readMp3(reader: Reader, withCover: boolean): Promise<TagFields | null> {
  const head = await reader.head(10)
  if (head.toString('ascii', 0, 3) !== 'ID3') return null
  const tagSize =
    ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f)
  const tag = await reader.at(0, Math.min(10 + tagSize, MAX_ID3_BYTES))
  const parsed = parseId3(tag, withCover)

  // 时长：TLEN 优先，其次第一帧的 Xing/Info
  let duration = parsed.duration
  if (!duration) {
    const frame = await reader.at(parsed.tagSize, 256)
    const info = mpegFrameInfo(frame)
    if (info) duration = readXingDuration(frame, info)
  }

  return {
    container: 'mp3',
    title: parsed.title || undefined,
    artists: parsed.artists?.length ? parsed.artists : undefined,
    album: parsed.album || undefined,
    duration,
    cover: parsed.cover
  }
}

// ─────────────────────────── FLAC ───────────────────────────

function parseVorbisComment(body: Buffer): Record<string, string> {
  const fields: Record<string, string> = {}
  if (body.length < 8) return fields
  let cursor = 0
  const vendorLength = body.readUInt32LE(cursor)
  cursor += 4 + vendorLength
  if (cursor + 4 > body.length) return fields
  const count = body.readUInt32LE(cursor)
  cursor += 4
  for (let i = 0; i < count && cursor + 4 <= body.length; i += 1) {
    const length = body.readUInt32LE(cursor)
    cursor += 4
    if (cursor + length > body.length) break
    const entry = body.toString('utf8', cursor, cursor + length)
    cursor += length
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq).toUpperCase()
    const value = entry.slice(eq + 1).trim()
    if (!value) continue
    // 同名键（多歌手）保留第一个，后面的拼进 ARTIST 列表
    if (key === 'ARTIST' && fields.ARTIST) fields.ARTIST = `${fields.ARTIST}\u0000${value}`
    else if (!fields[key]) fields[key] = value
  }
  return fields
}

/** FLAC PICTURE 块：type 3 = front cover（优先取它） */
function parseFlacPicture(body: Buffer): { type: number; cover: TagCover } | null {
  if (body.length < 32) return null
  let cursor = 0
  const type = body.readUInt32BE(cursor)
  cursor += 4
  const mimeLength = body.readUInt32BE(cursor)
  cursor += 4
  if (cursor + mimeLength > body.length) return null
  const mime = body.toString('latin1', cursor, cursor + mimeLength) || 'image/jpeg'
  cursor += mimeLength
  const descLength = body.readUInt32BE(cursor)
  cursor += 4 + descLength
  cursor += 16 // width / height / depth / colors
  if (cursor + 4 > body.length) return null
  const dataLength = body.readUInt32BE(cursor)
  cursor += 4
  if (!dataLength || dataLength > MAX_COVER_BYTES || cursor + dataLength > body.length) return null
  const data = Buffer.from(body.subarray(cursor, cursor + dataLength))
  return { type, cover: { mime: mime.includes('/') ? mime : guessMime(data), data } }
}

async function readFlac(reader: Reader, withCover: boolean): Promise<TagFields | null> {
  const magic = await reader.head(4)
  if (magic.toString('ascii') !== 'fLaC') return null

  let cursor = 4
  let duration: number | undefined
  const fields: Record<string, string> = {}
  let cover: TagCover | null = null
  /** 已拿到的封面类型：3 = front cover 时不再被后续块替换 */
  let coverType = -1

  for (let guard = 0; guard < 128; guard += 1) {
    const header = await reader.at(cursor, 4)
    if (header.length < 4) break
    const isLast = (header[0] & 0x80) !== 0
    const type = header[0] & 0x7f
    const length = (header[1] << 16) | (header[2] << 8) | header[3]
    cursor += 4

    if (type === 0 && length >= 34) {
      // STREAMINFO：采样率 20bit / 声道 3bit / 位深 5bit / 总样本数 36bit
      const body = await reader.at(cursor, length)
      if (body.length >= 18) {
        const rate = (body[10] << 12) | (body[11] << 4) | (body[12] >> 4)
        const total = (body[13] & 0x0f) * 2 ** 32 + body.readUInt32BE(14)
        if (rate > 0 && total > 0) duration = Math.round((total * 1000) / rate)
      }
    } else if (type === 4) {
      const body = await reader.at(cursor, Math.min(length, 1024 * 1024))
      Object.assign(fields, parseVorbisComment(body))
    } else if (type === 6 && withCover) {
      const body = await reader.at(cursor, Math.min(length, MAX_COVER_BYTES + 128))
      const picture = parseFlacPicture(body)
      // 一个文件里可能有多张图（前后封面、艺人照）：只认 front cover，
      // 没有 type 3 时退回第一张
      if (picture && (coverType !== 3 || picture.type === 3)) {
        cover = picture.cover
        coverType = picture.type
      }
    }

    cursor += length
    if (isLast) break
    if (cursor > reader.size) break
  }

  const artists = fields.ARTIST ? fields.ARTIST.split('\u0000').map((v) => v.trim()).filter(Boolean) : []
  return {
    container: 'flac',
    title: fields.TITLE || undefined,
    artists: artists.length ? artists : undefined,
    album: fields.ALBUM || undefined,
    duration,
    cover: cover ?? undefined
  }
}

// ─────────────────────────── MP4 / M4A ───────────────────────────

interface Atom {
  type: string
  /** 内容起始位置（相对 buffer） */
  start: number
  /** 内容结束位置（相对 buffer） */
  end: number
}

/** 在给定 buffer 的 [from, to) 区间里枚举同级 atom */
function listAtoms(buffer: Buffer, from = 0, to = buffer.length): Atom[] {
  const atoms: Atom[] = []
  let cursor = from
  while (cursor + 8 <= to) {
    let size = buffer.readUInt32BE(cursor)
    const type = buffer.toString('latin1', cursor + 4, cursor + 8)
    let header = 8
    if (size === 1) {
      if (cursor + 16 > to) break
      // 64 位扩展长度：只用低 32 位 —— moov 不可能真的超过 4GB
      const high = buffer.readUInt32BE(cursor + 8)
      const low = buffer.readUInt32BE(cursor + 12)
      size = high === 0 ? low : Number.MAX_SAFE_INTEGER
      header = 16
    } else if (size === 0) {
      size = to - cursor
    }
    if (size < header || cursor + size > to) break
    atoms.push({ type, start: cursor + header, end: cursor + size })
    cursor += size
  }
  return atoms
}

function findAtom(buffer: Buffer, parent: Atom | null, type: string): Atom | null {
  const list = parent ? listAtoms(buffer, parent.start, parent.end) : listAtoms(buffer)
  return list.find((atom) => atom.type === type) ?? null
}

/** ilst 里的一项（©nam 等）是 data atom 列表 */
function readIlstText(buffer: Buffer, item: Atom): string | undefined {
  for (const atom of listAtoms(buffer, item.start, item.end)) {
    if (atom.type !== 'data') continue
    // data: type(4) + locale(4) + payload；type 低 24 位：1=UTF-8、2=UTF-16
    const dataType = buffer.readUInt32BE(atom.start) & 0x00ffffff
    if (dataType !== 1 && dataType !== 2) continue
    const payload = buffer.subarray(atom.start + 8, atom.end)
    const text = (dataType === 2 ? swap16(payload).toString('utf16le') : payload.toString('utf8'))
      .replace(/\0+$/g, '')
      .trim()
    if (text) return text
  }
  return undefined
}

function readIlstCover(buffer: Buffer, item: Atom): TagCover | null {
  for (const atom of listAtoms(buffer, item.start, item.end)) {
    if (atom.type !== 'data') continue
    const dataType = buffer.readUInt32BE(atom.start) & 0x00ffffff
    const data = buffer.subarray(atom.start + 8, atom.end)
    if (!data.length || data.length > MAX_COVER_BYTES) continue
    const mime = dataType === 14 ? 'image/png' : dataType === 13 ? 'image/jpeg' : guessMime(data)
    return { mime, data: Buffer.from(data) }
  }
  return null
}

function readMvhdDuration(buffer: Buffer, mvhd: Atom): number | undefined {
  if (mvhd.start + 20 > mvhd.end) return undefined
  const version = buffer[mvhd.start]
  if (version === 1) {
    if (mvhd.start + 32 > mvhd.end) return undefined
    const timescale = buffer.readUInt32BE(mvhd.start + 20)
    const duration = Number(buffer.readBigUInt64BE(mvhd.start + 24))
    if (!timescale || !duration) return undefined
    return Math.round((duration * 1000) / timescale)
  }
  const timescale = buffer.readUInt32BE(mvhd.start + 12)
  const duration = buffer.readUInt32BE(mvhd.start + 16)
  if (!timescale || !duration) return undefined
  return Math.round((duration * 1000) / timescale)
}

async function readM4a(reader: Reader, withCover: boolean): Promise<TagFields | null> {
  const head = await reader.head(16)
  if (head.length < 8) return null
  // 顶层只可能是 ftyp / moov / mdat / free 等；用第一段确认是 ISO BMFF
  const firstType = head.toString('latin1', 4, 8)
  if (!['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'styp'].includes(firstType)) return null

  // 顶层游标：只读 16 字节头，遇到 mdat 直接跳过，不把音频数据读进来
  let cursor = 0
  let moovAt = -1
  let moovSize = 0
  for (let guard = 0; guard < 256 && cursor + 8 <= reader.size; guard += 1) {
    const header = await reader.at(cursor, 16)
    if (header.length < 8) break
    let size = header.readUInt32BE(0)
    const type = header.toString('latin1', 4, 8)
    let headerSize = 8
    if (size === 1) {
      if (header.length < 16) break
      const low = header.readUInt32BE(12)
      size = low
      headerSize = 16
    } else if (size === 0) {
      size = reader.size - cursor
    }
    if (type === 'moov') {
      moovAt = cursor + headerSize
      moovSize = size - headerSize
      break
    }
    if (size < headerSize) break
    cursor += size
  }
  if (moovAt < 0 || moovSize <= 0 || moovSize > MAX_MOOV_BYTES) return null

  const moovBuffer = await reader.at(moovAt, moovSize)
  const moov: Atom = { type: 'moov', start: 0, end: moovBuffer.length }

  const mvhd = findAtom(moovBuffer, moov, 'mvhd')
  const duration = mvhd ? readMvhdDuration(moovBuffer, mvhd) : undefined

  // meta 在 mp4 里是 full box：内容前面多 4 字节 version/flags
  let ilst: Atom | null = null
  const udta = findAtom(moovBuffer, moov, 'udta')
  const meta = udta ? findAtom(moovBuffer, udta, 'meta') : null
  if (meta) {
    // meta 的头是 size+type，内容是 4 字节 version/flags + 子 atom
    ilst = findAtom(moovBuffer, { type: 'meta', start: meta.start + 4, end: meta.end }, 'ilst')
  }

  const result: TagFields = { container: 'm4a', duration }
  if (ilst) {
    for (const item of listAtoms(moovBuffer, ilst.start, ilst.end)) {
      if (item.type === '\u00a9nam') result.title = readIlstText(moovBuffer, item) ?? result.title
      else if (item.type === '\u00a9ART') {
        const value = readIlstText(moovBuffer, item)
        if (value) result.artists = splitArtists(value)
      } else if (item.type === '\u00a9alb') result.album = readIlstText(moovBuffer, item) ?? result.album
      else if (item.type === 'covr' && withCover && !result.cover) {
        result.cover = readIlstCover(moovBuffer, item) ?? undefined
      }
    }
  }
  return result
}

// ─────────────────────────── OGG / Opus ───────────────────────────

/** 从一段 buffer 的开头解析一页 Ogg，返回各 packet 与下一页偏移 */
function parseOggPage(buffer: Buffer, offset: number): { packets: Buffer[]; next: number } | null {
  if (offset + 27 > buffer.length) return null
  if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') return null
  const segments = buffer[offset + 26]
  if (offset + 27 + segments > buffer.length) return null
  let bodyLength = 0
  const lacing: number[] = []
  for (let i = 0; i < segments; i += 1) {
    const value = buffer[offset + 27 + i]
    lacing.push(value)
    bodyLength += value
  }
  const bodyStart = offset + 27 + segments
  if (bodyStart + bodyLength > buffer.length) return null

  const packets: Buffer[] = []
  let cursor = bodyStart
  let packetStart = bodyStart
  for (const lace of lacing) {
    cursor += lace
    if (lace < 255) {
      packets.push(buffer.subarray(packetStart, cursor))
      packetStart = cursor
    }
  }
  return { packets, next: bodyStart + bodyLength }
}

function parseOggComment(packet: Buffer): Record<string, string> {
  const fields: Record<string, string> = {}
  let cursor = 0
  if (packet.toString('ascii', 0, 7) === 'OpusTags') cursor = 8
  else if (packet[0] === 0x03 && packet.toString('ascii', 1, 7) === 'vorbis') cursor = 7
  else return fields

  if (cursor + 4 > packet.length) return fields
  const vendorLength = packet.readUInt32LE(cursor)
  cursor += 4 + vendorLength
  if (cursor + 4 > packet.length) return fields
  const count = packet.readUInt32LE(cursor)
  cursor += 4
  for (let i = 0; i < count && cursor + 4 <= packet.length; i += 1) {
    const length = packet.readUInt32LE(cursor)
    cursor += 4
    if (cursor + length > packet.length) break
    const entry = packet.toString('utf8', cursor, cursor + length)
    cursor += length
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq).toUpperCase()
    const value = entry.slice(eq + 1).trim()
    if (!value) continue
    if (key === 'ARTIST' && fields.ARTIST) fields.ARTIST = `${fields.ARTIST}\u0000${value}`
    else if (!fields[key]) fields[key] = value
  }
  return fields
}

/** 采样率：Opus 输出恒为 48kHz，Vorbis 从 ident 头读 */
function oggSampleRate(ident: Buffer, isOpus: boolean): number {
  if (isOpus) return 48000
  if (ident.length >= 16) return ident.readUInt32LE(12)
  return 0
}

async function readOgg(reader: Reader): Promise<TagFields | null> {
  const head = await reader.head(64 * 1024)
  if (head.toString('ascii', 0, 4) !== 'OggS') return null

  const first = parseOggPage(head, 0)
  if (!first || !first.packets.length) return null
  const ident = first.packets[0]
  const isOpus = ident.toString('ascii', 0, 8) === 'OpusHead'
  const isVorbis = ident[0] === 0x01 && ident.toString('ascii', 1, 7) === 'vorbis'
  if (!isOpus && !isVorbis) return null

  let fields: Record<string, string> = {}
  const second = parseOggPage(head, first.next)
  if (second && second.packets.length) fields = parseOggComment(second.packets[0])

  // 时长：最后一页的 granule position / 采样率
  let duration: number | undefined
  const rate = oggSampleRate(ident, isOpus)
  if (rate > 0) {
    const tail = await reader.tail(64 * 1024)
    for (let i = tail.length - 27; i >= 0; i -= 1) {
      if (tail.toString('ascii', i, i + 4) !== 'OggS') continue
      const granule = Number(tail.readBigUInt64LE(i + 6))
      if (granule > 0) {
        duration = Math.round((granule * 1000) / rate)
        break
      }
    }
  }

  const artists = fields.ARTIST ? fields.ARTIST.split('\u0000').map((v) => v.trim()).filter(Boolean) : []
  return {
    container: 'ogg',
    title: fields.TITLE || undefined,
    artists: artists.length ? artists : undefined,
    album: fields.ALBUM || undefined,
    duration
  }
}

// ─────────────────────────── 入口 ───────────────────────────

/**
 * 读取一个音频文件的标签。
 *
 * @param withCover 是否读封面。扫描大量文件时可以先不读（封面只对当前可见项有用），
 *                  但本地库需要它来填 `coverUrl`，所以默认读。
 * @returns 解析不成功（不是支持的容器、文件损坏）时返回 null，不抛异常
 */
export async function readTagFields(
  filePath: string,
  options: { withCover?: boolean } = {}
): Promise<TagFields | null> {
  const withCover = options.withCover !== false
  let reader: Reader | null = null
  try {
    reader = await Reader.open(filePath)
    if (reader.size < 16) return null

    // 先按魔数判容器（扩展名可能被改过），再按各容器的入口解析
    const head = await reader.head(12)
    // ID3 只有 3 字节魔数，第 4 字节是版本号
    if (head.toString('ascii', 0, 3) === 'ID3') return await readMp3(reader, withCover)
    const magic = head.toString('ascii', 0, 4)
    if (magic === 'fLaC') return await readFlac(reader, withCover)
    if (magic === 'OggS') return await readOgg(reader)
    if (head.toString('ascii', 4, 8) === 'ftyp') return await readM4a(reader, withCover)

    // 无 ID3 头的 mp3：以 0xFFE 同步字开头
    if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return await readMp3(reader, withCover)
    // 有些 mp4 的第一段不是 ftyp，退回按扩展名尝试
    if (filePath.toLowerCase().endsWith('.m4a')) return await readM4a(reader, withCover)
    return null
  } catch {
    return null
  } finally {
    await reader?.close()
  }
}
