import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { TagResult } from './tag-types'

/**
 * FLAC 标签写入。
 *
 * 单独成文件是为了能被 Node 直接跑的单测覆盖——这里的失误代价最大：
 * 元数据块之后是整段音频帧，写回时漏掉就等于把一首歌换成 5KB 的空壳，
 * 文件还在、却一点声音都没有，用户只有播到那一首才会发现。
 */

interface FlacBlock {
  type: number
  payload: Buffer
}

/**
 * 解析 FLAC metadata block 链，同时给出音频帧的起始偏移。
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
    const header = data[cursor]
    const type = header & 0x7f
    const length = data.readUIntBE(cursor + 1, 3)
    const start = cursor + 4
    // 声明的长度超出文件：subarray 会静默截断 payload，但 cursor 仍按声明值前进，
    // audioStart 落到文件之外 → 写回时 data.subarray(audioStart) 为空，整首歌被清空。
    if (start + length > data.length) return null
    blocks.push({ type, payload: data.subarray(start, start + length) })
    cursor = start + length
    if (header & 0x80) {
      last = true
      break
    }
  }
  // 没有 last 标志说明元数据链被截断；此时音频帧会被当成元数据块继续解析
  if (!last) return null
  return { blocks, audioStart: cursor }
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
 * 原子写二进制：先写同目录 .tmp，再 rename 覆盖。
 *
 * 不复用 services/atomic-write.ts：那个模块是给 JSON 落盘的全局串行队列，
 * 而本文件要被 Node 单测直接 import（原生测试运行器不解析无扩展名的相对路径）。
 * 写标签本身是串行 IPC、单文件一次写，不需要全局队列。
 */
async function writeAtomicBinary(filePath: string, data: Buffer): Promise<void> {
  const tmp = `${filePath}.aurora-tmp`
  await writeFile(tmp, data)
  try {
    await rename(tmp, filePath)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * 写 FLAC 标签。**元数据块之后的内容必须原样接回去**，那是音频帧。
 */
export async function writeFlacTags(
  filePath: string,
  entries: Record<string, string>
): Promise<TagResult> {
  let data: Buffer
  try {
    data = await readFile(filePath)
  } catch (error) {
    return { ok: false, error: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const parsed = readFlacBlocks(data)
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

  try {
    ordered.forEach((block, index) => {
      const isLast = index === ordered.length - 1
      if (block.type === 4) {
        pushBlock(4, buildVorbisComment(hasComment ? block.payload : undefined, entries), isLast)
        return
      }
      pushBlock(block.type, block.payload, isLast)
    })
  } catch {
    return { ok: false, error: 'FLAC 注释块损坏，未写入以免丢失已有标签' }
  }

  const audio = data.subarray(audioStart)
  try {
    await writeAtomicBinary(filePath, Buffer.concat([Buffer.from('fLaC', 'ascii'), ...rebuilt, audio]))
  } catch (error) {
    return { ok: false, error: `写入失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true }
}
