import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { writeMp4Tags } from './tag-mp4'
import { writeOggTags } from './tag-ogg'
import type { TagPayload, TagResult } from './tag-types'

/**
 * 音频标签写入。
 *
 * 上游复用 mutagen（mp3 / m4a / flac / ogg 全覆盖）。这里按容器分别实现：
 *
 *   - **MP3**：ID3v2.3，文本帧用 UTF-16LE + BOM，兼容性最好（v2.4 的 UTF-8
 *     帧会被不少老播放器当垃圾跳过）；
 *   - **FLAC**：Vorbis Comment 块，重建 metadata block 链并修正 last-block 标志；
 *   - **MP4/M4A/AAC**：iTunes `ilst` 原子，并修正 `stco/co64` 的 chunk 偏移；
 *   - **Ogg/Opus**：改写 comment packet，重算页 CRC 与序号，音频包原样保留。
 *
 * 失败不抛异常（与 `cmd_tag` 一致）：标签是加分项，不能让一次成功的下载变成失败。
 */

export type { TagPayload, TagResult }

const TEXT_ENCODING_UTF16 = 0x01

function syncSafeSize(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
}

function decodeSyncSafe(buffer: Buffer): number {
  return ((buffer[0] & 0x7f) << 21) | ((buffer[1] & 0x7f) << 14) | ((buffer[2] & 0x7f) << 7) | (buffer[3] & 0x7f)
}

/** UTF-16LE + BOM，ID3v2.3 里最稳的中文编码 */
function utf16WithBom(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

function textFrame(id: string, value: string): Buffer {
  const payload = Buffer.concat([Buffer.from([TEXT_ENCODING_UTF16]), utf16WithBom(value)])
  const header = Buffer.alloc(10)
  header.write(id, 0, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function usltFrame(lyric: string): Buffer {
  // encoding(1) + language(3) + descriptor(UTF-16 空串 = BOM + 0x0000) + 正文
  const descriptor = Buffer.from([0xff, 0xfe, 0x00, 0x00])
  const payload = Buffer.concat([Buffer.from([TEXT_ENCODING_UTF16]), Buffer.from('chi', 'ascii'), descriptor, utf16WithBom(lyric)])
  const header = Buffer.alloc(10)
  header.write('USLT', 0, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

/** 读出现有 ID3v2 帧（保留我们不改写的那些，比如封面 APIC） */
function readExistingFrames(data: Buffer): { frames: Buffer[]; audioStart: number } {
  if (data.length < 10 || data.subarray(0, 3).toString('ascii') !== 'ID3') return { frames: [], audioStart: 0 }
  const version = data[3]
  const tagSize = decodeSyncSafe(data.subarray(6, 10))
  const audioStart = 10 + tagSize
  const frames: Buffer[] = []
  let cursor = 10
  while (cursor + 10 <= audioStart) {
    const id = data.subarray(cursor, cursor + 4).toString('ascii')
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = version === 4 ? decodeSyncSafe(data.subarray(cursor + 4, cursor + 8)) : data.readUInt32BE(cursor + 4)
    if (size <= 0 || cursor + 10 + size > audioStart) break
    frames.push(data.subarray(cursor, cursor + 10 + size))
    cursor += 10 + size
  }
  return { frames, audioStart }
}

async function writeId3(payload: TagPayload): Promise<TagResult> {
  const data = await readFile(payload.path)
  const { frames, audioStart } = readExistingFrames(data)
  const replaced = new Set(['TIT2', 'TPE1', 'TALB', 'USLT', 'TRCK'])
  const kept = frames.filter((frame) => !replaced.has(frame.subarray(0, 4).toString('ascii')))

  const built: Buffer[] = [textFrame('TIT2', payload.title), textFrame('TPE1', payload.artists), textFrame('TALB', payload.album)]
  if (payload.track) built.push(textFrame('TRCK', String(payload.track)))
  if (payload.lyric) built.push(usltFrame(payload.lyric))

  const body = Buffer.concat([...kept, ...built])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), syncSafeSize(body.length)])
  await writeFile(payload.path, Buffer.concat([header, body, data.subarray(audioStart)]))
  return { ok: true }
}

/** 解析 FLAC metadata block 链 */
function readFlacBlocks(data: Buffer): Array<{ type: number; payload: Buffer }> | null {
  if (data.subarray(0, 4).toString('ascii') !== 'fLaC') return null
  const blocks: Array<{ type: number; payload: Buffer }> = []
  let cursor = 4
  while (cursor + 4 <= data.length) {
    const header = data[cursor]
    const type = header & 0x7f
    const length = data.readUIntBE(cursor + 1, 3)
    const payload = data.subarray(cursor + 4, cursor + 4 + length)
    blocks.push({ type, payload })
    cursor += 4 + length
    if (header & 0x80) break
  }
  return blocks
}

function buildVorbisComment(existing: Buffer | undefined, entries: Record<string, string>): Buffer {
  const comments: Array<[string, string]> = []
  if (existing && existing.length >= 8) {
    try {
      let cursor = 0
      const vendorLength = existing.readUInt32LE(cursor)
      cursor += 4 + vendorLength
      const count = existing.readUInt32LE(cursor)
      cursor += 4
      for (let index = 0; index < count; index += 1) {
        if (cursor + 4 > existing.length) break
        const length = existing.readUInt32LE(cursor)
        cursor += 4
        const text = existing.subarray(cursor, cursor + length).toString('utf8')
        cursor += length
        const eq = text.indexOf('=')
        if (eq > 0) comments.push([text.slice(0, eq).toUpperCase(), text.slice(eq + 1)])
      }
    } catch {
      /* 已有注释块损坏就重建 */
    }
  }
  const replaceKeys = new Set(Object.keys(entries).map((key) => key.toUpperCase()))
  const kept = comments.filter(([key]) => !replaceKeys.has(key))
  const merged = [...kept, ...Object.entries(entries).map(([key, value]) => [key.toUpperCase(), value] as [string, string])]

  const vendor = Buffer.from('aurora', 'utf8')
  const parts: Buffer[] = [Buffer.alloc(4), vendor, Buffer.alloc(4)]
  parts[0].writeUInt32LE(vendor.length, 0)
  parts[2].writeUInt32LE(merged.length, 0)
  for (const [key, value] of merged) {
    const text = Buffer.from(`${key}=${value}`, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(text.length, 0)
    parts.push(length, text)
  }
  return Buffer.concat(parts)
}

async function writeFlac(payload: TagPayload): Promise<TagResult> {
  const data = await readFile(payload.path)
  const blocks = readFlacBlocks(data)
  if (!blocks) return { ok: false, error: '不是合法的 FLAC 文件' }

  const entries: Record<string, string> = { TITLE: payload.title, ARTIST: payload.artists, ALBUM: payload.album }
  if (payload.lyric) entries.LYRICS = payload.lyric
  if (payload.track) entries.TRACKNUMBER = String(payload.track)

  const hasComment = blocks.some((block) => block.type === 4)
  // 统一重建成「头 + 载荷」序列，最后一块打 last 标志——比原地改更不容易出错
  const rebuilt: Buffer[] = []
  const pushBlock = (type: number, body: Buffer, isLast: boolean): void => {
    const header = Buffer.alloc(4)
    header[0] = (type & 0x7f) | (isLast ? 0x80 : 0)
    header.writeUIntBE(body.length, 1, 3)
    rebuilt.push(header, body)
  }

  const ordered = [...blocks]
  if (!hasComment) ordered.push({ type: 4, payload: Buffer.alloc(0) })

  ordered.forEach((block, index) => {
    const isLast = index === ordered.length - 1
    if (block.type === 4) {
      pushBlock(4, buildVorbisComment(hasComment ? block.payload : undefined, entries), isLast)
      return
    }
    pushBlock(block.type, block.payload, isLast)
  })

  await writeFile(payload.path, Buffer.concat([Buffer.from('fLaC', 'ascii'), ...rebuilt]))
  return { ok: true }
}

export async function writeTags(payload: TagPayload): Promise<TagResult> {
  if (!payload.path) return { ok: false, error: '缺少目标文件' }
  const ext = extname(payload.path).toLowerCase()
  try {
    if (ext === '.mp3') return await writeId3(payload)
    if (ext === '.flac') return await writeFlac(payload)
    if (ext === '.m4a' || ext === '.mp4' || ext === '.aac') return await writeMp4Tags(payload.path, payload)
    if (ext === '.ogg' || ext === '.opus') return await writeOggTags(payload.path, payload)
    // WAV 的 RIFF INFO 收益低、兼容性差，直接跳过
    if (ext === '.wav') return { ok: true, skipped: 'wav' }
    return { ok: true, skipped: ext || 'unknown' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
