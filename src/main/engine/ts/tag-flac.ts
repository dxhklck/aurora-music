import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import type { TagResult } from './tag-types'

/**
 * FLAC 标签写入。
 *
 * 单独成文件是为了能被 Node 直接跑的单测覆盖——这里的失误代价最大：
 * 元数据块之后是整段音频帧，写回时漏掉就等于把一首歌换成 5KB 的空壳，
 * 文件还在、却一点声音都没有，用户只有播到那一首才会发现。
 *
 * 内存策略：只把**元数据块**读进内存（FLAC 的 STREAMINFO/VORBIS_COMMENT/PICTURE
 * 通常只有几十 KB 到几 MB），音频帧用流式 pipe 原样搬过去，不整文件进内存——
 * 否则几百 MB 的长录音写个标签就有 2× 峰值，直接 OOM。
 */

interface FlacBlock {
  type: number
  payload: Buffer
}

/** 校验一个「类型字节 + 3 字节长度」的块头；非法返回 null */
function parseBlockHeader(header: Buffer): { type: number; length: number; isLast: boolean } | null {
  if (header.length < 4) return null
  return { type: header[0] & 0x7f, length: header.readUIntBE(1, 3), isLast: (header[0] & 0x80) !== 0 }
}

/**
 * 解析 FLAC metadata block 链（内存版，单测用它校验逻辑本身）。
 * 结构损坏一律返回 null：宁可不写，也不能带着越界的 audioStart 把音频清空。
 */
export function readFlacBlocks(
  data: Buffer
): { blocks: FlacBlock[]; audioStart: number } | null {
  if (data.subarray(0, 4).toString('ascii') !== 'fLaC') return null
  const blocks: FlacBlock[] = []
  let cursor = 4
  let last = false
  while (cursor + 4 <= data.length) {
    const head = parseBlockHeader(data.subarray(cursor, cursor + 4))
    if (!head) return null
    const start = cursor + 4
    // 声明的长度超出文件：subarray 会静默截断 payload，但 cursor 仍按声明值前进，
    // audioStart 落到文件之外 → 写回时 data.subarray(audioStart) 为空，整首歌被清空。
    if (start + head.length > data.length) return null
    blocks.push({ type: head.type, payload: data.subarray(start, start + head.length) })
    cursor = start + head.length
    if (head.isLast) {
      last = true
      break
    }
    if (head.length === 0) return null // 无 last 标志且块长 0，避免死循环
  }
  if (!last) return null // 元数据链被截断，音频帧会被误当成元数据块继续解析
  return { blocks, audioStart: cursor }
}

/**
 * 流式版：只把元数据块读进内存，音频帧偏移算出来即返回，不读音频帧。
 * 与 readFlacBlocks 判据一致（越界 / 缺 last 都返回 null），只是不整文件读。
 */
export async function readFlacBlocksFromFile(
  filePath: string
): Promise<{ blocks: FlacBlock[]; audioStart: number } | null> {
  const handle = await open(filePath, 'r')
  try {
    const magic = Buffer.alloc(4)
    const mr = await handle.read(magic, 0, 4, 0)
    if (mr.bytesRead < 4 || magic.toString('ascii') !== 'fLaC') return null
    const blocks: FlacBlock[] = []
    let cursor = 4
    let last = false
    for (;;) {
      const header = Buffer.alloc(4)
      const hr = await handle.read(header, 0, 4, cursor)
      if (hr.bytesRead < 4) break
      const head = parseBlockHeader(header)
      if (!head) return null
      const start = cursor + 4
      const payload = Buffer.alloc(head.length)
      const pr = await handle.read(payload, 0, head.length, start)
      if (pr.bytesRead < head.length) return null // 声明长度超出文件
      blocks.push({ type: head.type, payload })
      cursor = start + head.length
      if (head.isLast) {
        last = true
        break
      }
      if (head.length === 0) return null
    }
    if (!last) return null
    return { blocks, audioStart: cursor }
  } finally {
    await handle.close()
  }
}

/**
 * 把已有 VORBIS_COMMENT 与要写入的字段合并（同名键覆盖，其它原样保留）。
 *
 * 解析失败必须抛给调用方：静默「重建」会把用户已有的 GENRE / DATE / ALBUMARTIST /
 * REPLAYGAIN_* 等标签全部丢掉，而且没有任何提示。
 */
export function buildVorbisComment(
  existing: Buffer | undefined,
  entries: Record<string, string>
): Buffer {
  const comments: Array<[string, string]> = []
  if (existing && existing.length >= 8) {
    try {
      let cursor = 0
      const vendorLength = existing.readUInt32LE(cursor)
      cursor += 4 + vendorLength
      const count = existing.readUInt32LE(cursor)
      cursor += 4
      for (let index = 0; index < count; index += 1) {
        if (cursor + 4 > existing.length) throw new Error('comment length out of range')
        const length = existing.readUInt32LE(cursor)
        cursor += 4
        if (cursor + length > existing.length) throw new Error('comment body out of range')
        const text = existing.subarray(cursor, cursor + length).toString('utf8')
        cursor += length
        const eq = text.indexOf('=')
        if (eq > 0) comments.push([text.slice(0, eq).toUpperCase(), text.slice(eq + 1)])
      }
    } catch {
      throw new Error('FLAC_VORBIS_COMMENT_CORRUPT')
    }
  }
  const replaceKeys = new Set(Object.keys(entries).map((key) => key.toUpperCase()))
  const kept = comments.filter(([key]) => !replaceKeys.has(key))
  const merged = [
    ...kept,
    ...Object.entries(entries).map(([key, value]) => [key.toUpperCase(), value] as [string, string])
  ]

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

/**
 * 写 FLAC 标签。**元数据块之后的内容必须原样接回去**，那是音频帧。
 * 元数据写进内存、音频帧用流式 pipe 搬过去，避免整文件读进内存。
 */
export async function writeFlacTags(
  filePath: string,
  entries: Record<string, string>
): Promise<TagResult> {
  let parsed: { blocks: FlacBlock[]; audioStart: number } | null
  try {
    parsed = await readFlacBlocksFromFile(filePath)
  } catch (error) {
    return { ok: false, error: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!parsed) return { ok: false, error: '不是合法的 FLAC 文件（元数据块损坏或已截断）' }
  const { blocks, audioStart } = parsed

  const hasComment = blocks.some((block) => block.type === 4)
  // 统一重建成「头 + 载荷」序列，最后一块打 last 标志——比原地改更不容易出错
  const rebuilt: Buffer[] = []
  const pushBlock = (type: number, body: Buffer, isLast: boolean): void => {
    const header = Buffer.alloc(4)
    header[0] = (type & 0x7f) | (isLast ? 0x80 : 0)
    header.writeUIntBE(body.length, 1, 3)
    rebuilt.push(header, body)
  }

  const ordered: FlacBlock[] = [...blocks]
  if (!hasComment) ordered.push({ type: 4, payload: Buffer.alloc(0) })

  let header: Buffer
  try {
    ordered.forEach((block, index) => {
      const isLast = index === ordered.length - 1
      if (block.type === 4) {
        pushBlock(4, buildVorbisComment(hasComment ? block.payload : undefined, entries), isLast)
        return
      }
      pushBlock(block.type, block.payload, isLast)
    })
    header = Buffer.concat([Buffer.from('fLaC', 'ascii'), ...rebuilt])
  } catch {
    return { ok: false, error: 'FLAC 注释块损坏，未写入以免丢失已有标签' }
  }

  // 原子写：先写 fLaC + 新元数据，再把音频帧从原文件流式搬过来
  const tmp = `${filePath}.aurora-tmp`
  try {
    const ws = createWriteStream(tmp)
    ws.write(header)
    await pipeline(createReadStream(filePath, { start: audioStart }), ws)
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true }
}
