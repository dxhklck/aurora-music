import { readFile, writeFile } from 'node:fs/promises'
import type { TagFields, TagResult } from './tag-types'

/**
 * Ogg（Vorbis / Opus）标签写入。
 *
 * 与 mutagen 的行为对齐：改写 comment packet，保留 vendor、自定义字段与全部音频包，
 * 只重排头部页并重算 Ogg CRC；音频页只改序号与 CRC，granule 与数据原样保留。
 *
 * 不依赖 ffmpeg，也不依赖任何 native 模块。
 */

interface OggPage {
  headerType: number
  granule: bigint
  serial: number
  sequence: number
  segments: number[]
  data: Buffer
}

interface OggPacket {
  data: Buffer
  endPage: number
  endsAtPageEnd: boolean
}

const REPLACE_KEYS = new Set(['TITLE', 'ARTIST', 'ALBUM', 'LYRICS'])
const VORBIS_MAGIC = Buffer.from('\x01vorbis', 'latin1')
const VORBIS_COMMENT = Buffer.from('\x03vorbis', 'latin1')
const OPUS_HEAD = Buffer.from('OpusHead', 'latin1')
const OPUS_TAGS = Buffer.from('OpusTags', 'latin1')

/** Ogg 用的 CRC-32：多项式 0x04C11DB7，初值 0，不反射 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index << 24
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function oggCrc(buffer: Buffer): number {
  let crc = 0
  for (const byte of buffer) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  }
  return crc >>> 0
}

/** 解析全部页；任何截断/坏页都返回 null，绝不返回「半个文件」 */
function parsePages(data: Buffer): OggPage[] | null {
  const pages: OggPage[] = []
  let cursor = 0
  while (cursor + 27 <= data.length) {
    if (data.toString('ascii', cursor, cursor + 4) !== 'OggS') return null
    if (data[cursor + 4] !== 0) return null
    const headerType = data[cursor + 5]
    const granule = data.readBigUInt64LE(cursor + 6)
    const serial = data.readUInt32LE(cursor + 14)
    const sequence = data.readUInt32LE(cursor + 18)
    const count = data[cursor + 26]
    if (cursor + 27 + count > data.length) return null
    const segments: number[] = []
    for (let index = 0; index < count; index += 1) segments.push(data[cursor + 27 + index])
    const bodyStart = cursor + 27 + count
    const bodyLength = segments.reduce((sum, value) => sum + value, 0)
    if (bodyStart + bodyLength > data.length) return null
    pages.push({
      headerType,
      granule,
      serial,
      sequence,
      segments,
      data: data.subarray(bodyStart, bodyStart + bodyLength)
    })
    cursor = bodyStart + bodyLength
  }
  // 尾部有残余字节说明文件被截断，不能继续改写
  return cursor === data.length ? pages : null
}

function assemblePackets(pages: OggPage[]): OggPacket[] | null {
  const packets: OggPacket[] = []
  let current: Buffer[] = []
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]
    let offset = 0
    for (let segmentIndex = 0; segmentIndex < page.segments.length; segmentIndex += 1) {
      const length = page.segments[segmentIndex]
      current.push(page.data.subarray(offset, offset + length))
      offset += length
      if (length < 255) {
        packets.push({
          data: Buffer.concat(current),
          endPage: pageIndex,
          endsAtPageEnd: segmentIndex === page.segments.length - 1
        })
        current = []
      }
    }
  }
  // 最后一页停在 255 段上，说明包被截断
  return current.length ? null : packets
}

function buildPage(page: OggPage): Buffer {
  const header = Buffer.alloc(27)
  header.write('OggS', 0, 'ascii')
  header[4] = 0
  header[5] = page.headerType
  header.writeBigUInt64LE(page.granule, 6)
  header.writeUInt32LE(page.serial, 14)
  header.writeUInt32LE(page.sequence >>> 0, 18)
  header.writeUInt32LE(0, 22)
  header[26] = page.segments.length
  const lacing = Buffer.from(page.segments)
  const body = Buffer.concat([header, lacing, page.data])
  body.writeUInt32LE(oggCrc(body), 22)
  return body
}

/**
 * 把一组 packet 打包成页。
 *
 * `startsContinued` 表示「当前页的第一个包是上一页的续包」。头部的 granule 固定为 0；
 * 音频页不经过这里，直接保留原 granule。
 */
function paginate(
  packets: Buffer[],
  serial: number,
  startSequence: number,
  bos: boolean
): { pages: OggPage[]; nextSequence: number } {
  const pages: OggPage[] = []
  let sequence = startSequence
  let lacing: number[] = []
  let chunks: Buffer[] = []
  let startsContinued = false
  let first = bos

  const flush = (): void => {
    pages.push({
      headerType: (first ? 0x02 : 0x00) | (startsContinued ? 0x01 : 0x00),
      granule: 0n,
      serial,
      sequence,
      segments: lacing,
      data: Buffer.concat(chunks)
    })
    sequence += 1
    first = false
    startsContinued = false
    lacing = []
    chunks = []
  }

  for (const packet of packets) {
    if (lacing.length === 255) flush()
    const values: number[] = []
    let remaining = packet.length
    while (remaining >= 255) {
      values.push(255)
      remaining -= 255
    }
    values.push(remaining)
    let offset = 0
    for (const value of values) {
      if (lacing.length === 255) {
        flush()
        startsContinued = true
      }
      lacing.push(value)
      chunks.push(packet.subarray(offset, offset + value))
      offset += value
    }
  }
  if (lacing.length) flush()
  return { pages, nextSequence: sequence }
}

interface CommentBlock {
  vendor: Buffer
  entries: Buffer[]
}

function parseComment(packet: Buffer, isVorbis: boolean): CommentBlock | null {
  const prefix = isVorbis ? VORBIS_COMMENT : OPUS_TAGS
  if (packet.length < prefix.length + 8 || !packet.subarray(0, prefix.length).equals(prefix)) return null
  let cursor = prefix.length
  const vendorLength = packet.readUInt32LE(cursor)
  cursor += 4
  if (cursor + vendorLength + 4 > packet.length) return null
  const vendor = Buffer.from(packet.subarray(cursor, cursor + vendorLength))
  cursor += vendorLength
  const count = packet.readUInt32LE(cursor)
  cursor += 4
  const entries: Buffer[] = []
  for (let index = 0; index < count; index += 1) {
    if (cursor + 4 > packet.length) return null
    const length = packet.readUInt32LE(cursor)
    cursor += 4
    if (cursor + length > packet.length) return null
    entries.push(Buffer.from(packet.subarray(cursor, cursor + length)))
    cursor += length
  }
  return { vendor, entries }
}

function entryKey(entry: Buffer): string {
  const text = entry.toString('utf8')
  const equal = text.indexOf('=')
  return equal > 0 ? text.slice(0, equal).toUpperCase() : ''
}

function buildComment(existing: CommentBlock | null, fields: TagFields, isVorbis: boolean): Buffer {
  const vendor = existing?.vendor?.length ? existing.vendor : Buffer.from('aurora', 'utf8')
  const entries = (existing?.entries ?? []).filter((entry) => !REPLACE_KEYS.has(entryKey(entry)))
  const add = (key: string, value: string): void => {
    if (!value) return
    entries.push(Buffer.from(`${key}=${value}`, 'utf8'))
  }
  add('TITLE', fields.title)
  add('ARTIST', fields.artists)
  add('ALBUM', fields.album)
  if (fields.lyric) add('LYRICS', fields.lyric)

  const parts: Buffer[] = [isVorbis ? VORBIS_COMMENT : OPUS_TAGS]
  const vendorLength = Buffer.alloc(4)
  vendorLength.writeUInt32LE(vendor.length, 0)
  parts.push(vendorLength, vendor)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(entries.length, 0)
  parts.push(count)
  for (const entry of entries) {
    const length = Buffer.alloc(4)
    length.writeUInt32LE(entry.length, 0)
    parts.push(length, entry)
  }
  // Vorbis 的 comment header 末尾必须有一个 framing bit
  if (isVorbis) parts.push(Buffer.from([0x01]))
  return Buffer.concat(parts)
}

export async function writeOggTags(path: string, fields: TagFields): Promise<TagResult> {
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (data.length < 4 || data.toString('ascii', 0, 4) !== 'OggS') {
    // 非 Ogg 数据：不认识的容器一律静默成功，不阻断下载
    return { ok: true }
  }
  const pages = parsePages(data)
  if (!pages) return { ok: false, error: '不是合法的 Ogg 文件（页结构损坏或截断）' }
  if (!pages.length) return { ok: true }

  const packets = assemblePackets(pages)
  if (!packets) return { ok: false, error: '不是合法的 Ogg 文件（数据包不完整）' }
  if (!packets.length) return { ok: true }

  const first = packets[0].data
  const isVorbis = first.subarray(0, 7).equals(VORBIS_MAGIC)
  const isOpus = first.subarray(0, 8).equals(OPUS_HEAD)
  // 非 Vorbis/Opus 的 Ogg（Theora、Speex 等）不写标签，静默成功
  if (!isVorbis && !isOpus) return { ok: true }

  const headerCount = isVorbis ? 3 : 2
  if (packets.length < headerCount) return { ok: false, error: 'Ogg 头部不完整' }
  const lastHeader = packets[headerCount - 1]
  if (!lastHeader.endsAtPageEnd) {
    return { ok: false, error: '不支持的 Ogg 页布局（头部与音频共用同一页）' }
  }

  const existing = parseComment(packets[1].data, isVorbis)
  const comment = buildComment(existing, fields, isVorbis)
  const headerPackets = [packets[0].data, comment, ...(isVorbis ? [packets[2].data] : [])]

  const bos = paginate([headerPackets[0]], pages[0].serial, 0, true)
  const rest = paginate(headerPackets.slice(1), pages[0].serial, bos.nextSequence, false)
  const audioPages = pages.slice(lastHeader.endPage + 1)
  let sequence = rest.nextSequence
  const rebuilt: Buffer[] = [...bos.pages, ...rest.pages].map(buildPage)
  for (const page of audioPages) {
    rebuilt.push(buildPage({ ...page, sequence: sequence >>> 0 }))
    sequence += 1
  }

  try {
    await writeFile(path, Buffer.concat(rebuilt))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
