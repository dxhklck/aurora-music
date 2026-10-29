import { readFile, writeFile } from 'node:fs/promises'
import type { TagFields, TagResult } from './tag-types'

/**
 * MP4 / M4A 标签写入（iTunes `ilst` 原子）。
 *
 * 目标：写入
 * `©nam` / `©ART` / `©alb` / `©lyr` 四个 UTF-8 原子，保留其它原子与音频数据。
 *
 * 这里最容易出错的是 **moov 体积变化后 `stco` 偏移要跟着改**：
 * faststart 文件把 moov 放在 mdat 前面，标签变长会把 mdat 整体推后，
 * 不修正 `stco` 就会导致播放器读到错位的数据（表现为爆音/无法播放）。
 */

interface BoxInfo {
  type: string
  start: number
  size: number
  headerSize: number
  payloadStart: number
  payloadEnd: number
}

const REPLACE_KEYS = new Set(['\u00a9nam', '\u00a9ART', '\u00a9alb', '\u00a9lyr'])

/** 能继续向下解析的容器（`meta` 是 FullBox，子节点从 +4 开始） */
const CONTAINER_TYPES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst', 'dinf', 'edts', 'meta'])

function readBoxes(data: Buffer, start: number, end: number): BoxInfo[] {
  const boxes: BoxInfo[] = []
  let cursor = start
  while (cursor + 8 <= end) {
    let size = data.readUInt32BE(cursor)
    const type = data.toString('latin1', cursor + 4, cursor + 8)
    let headerSize = 8
    if (size === 1) {
      if (cursor + 16 > end) break
      size = Number(data.readBigUInt64BE(cursor + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - cursor
    }
    // 损坏的盒子直接停止，避免越界读取
    if (size < headerSize || cursor + size > end) break
    boxes.push({
      type,
      start: cursor,
      size,
      headerSize,
      payloadStart: cursor + headerSize,
      payloadEnd: cursor + size
    })
    cursor += size
  }
  return boxes
}

function makeBox(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8)
  const total = payload.length + 8
  if (total > 0xffffffff) {
    const large = Buffer.alloc(16)
    large.writeUInt32BE(1, 0)
    large.write(type, 4, 'latin1')
    large.writeBigUInt64BE(BigInt(total), 8)
    return Buffer.concat([large, payload])
  }
  head.writeUInt32BE(total, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, payload])
}

function makeContainer(type: string, children: Buffer[]): Buffer {
  return makeBox(type, Buffer.concat(children))
}

/** iTunes 的 data 原子：type=1 表示 UTF-8，locale 固定 0 */
function makeDataAtom(text: string): Buffer {
  const prefix = Buffer.alloc(8)
  prefix.writeUInt32BE(1, 0)
  prefix.writeUInt32BE(0, 4)
  return makeBox('data', Buffer.concat([prefix, Buffer.from(text, 'utf8')]))
}

function makeItem(key: string, text: string): Buffer {
  return makeBox(key, makeDataAtom(text))
}

/** mutagen 新建 meta 时用的 hdlr（33 字节，handler=mdir / manufacturer=appl） */
function makeHdlr(): Buffer {
  const payload = Buffer.alloc(25)
  payload.write('mdir', 8, 'ascii')
  payload.write('appl', 12, 'ascii')
  return makeBox('hdlr', payload)
}

function findBox(boxes: BoxInfo[], type: string): BoxInfo | undefined {
  return boxes.find((box) => box.type === type)
}

/** 子盒子必须正好铺满父容器，否则说明文件结构损坏，不能重建 */
function isComplete(boxes: BoxInfo[], start: number, end: number): boolean {
  return boxes.length > 0 && boxes[boxes.length - 1].payloadEnd === end && boxes[0].start === start
}

function buildIlst(data: Buffer, existing: BoxInfo | undefined, fields: TagFields): Buffer {
  const items: Buffer[] = []
  if (existing) {
    for (const item of readBoxes(data, existing.payloadStart, existing.payloadEnd)) {
      if (REPLACE_KEYS.has(item.type)) continue
      items.push(data.subarray(item.start, item.payloadEnd))
    }
  }
  items.push(makeItem('\u00a9nam', fields.title))
  items.push(makeItem('\u00a9ART', fields.artists))
  items.push(makeItem('\u00a9alb', fields.album))
  if (fields.lyric) items.push(makeItem('\u00a9lyr', fields.lyric))
  return makeContainer('ilst', items)
}

function buildMeta(data: Buffer, existing: BoxInfo | undefined, ilst: Buffer): Buffer {
  const prefix = existing
    ? Buffer.from(data.subarray(existing.payloadStart, existing.payloadStart + 4))
    : Buffer.alloc(4)
  const children = existing ? readBoxes(data, existing.payloadStart + 4, existing.payloadEnd) : []
  const output: Buffer[] = []
  // 有些文件有 meta 但缺 hdlr；补一个，播放器才会把 ilst 当元数据
  if (!children.some((child) => child.type === 'hdlr')) output.push(makeHdlr())
  let wroteIlst = false
  for (const child of children) {
    if (child.type === 'ilst') {
      output.push(ilst)
      wroteIlst = true
    } else {
      output.push(data.subarray(child.start, child.payloadEnd))
    }
  }
  if (!wroteIlst) {
    // 顺序与 mutagen 一致：hdlr 在前，ilst 在后
    output.push(ilst)
  }
  return makeBox('meta', Buffer.concat([prefix, ...output]))
}

function buildUdta(data: Buffer, existing: BoxInfo | undefined, meta: Buffer): Buffer {
  const children = existing ? readBoxes(data, existing.payloadStart, existing.payloadEnd) : []
  const output: Buffer[] = []
  let wroteMeta = false
  for (const child of children) {
    if (child.type === 'meta') {
      output.push(meta)
      wroteMeta = true
    } else {
      output.push(data.subarray(child.start, child.payloadEnd))
    }
  }
  if (!wroteMeta) output.push(meta)
  return makeContainer('udta', output)
}

/**
 * 修正 stco / co64 的 chunk 偏移。
 *
 * moov 变大/变小后，所有指向 moov 之后的媒体数据偏移都要平移 delta。
 * 用「旧偏移 >= 旧 moov 末尾」判断，兼容 moov 在文件头（faststart）与文件尾两种布局。
 */
function patchChunkOffsets(moov: Buffer, oldMoovEnd: number, delta: number): void {
  if (!delta) return

  const walk = (box: BoxInfo): void => {
    if (box.type === 'stco') {
      const count = moov.readUInt32BE(box.payloadStart + 4)
      for (let index = 0; index < count; index += 1) {
        const position = box.payloadStart + 8 + index * 4
        if (position + 4 > box.payloadEnd) break
        const old = moov.readUInt32BE(position)
        if (old >= oldMoovEnd) {
          const next = old + delta
          if (next >= 0 && next <= 0xffffffff) moov.writeUInt32BE(next, position)
        }
      }
      return
    }
    if (box.type === 'co64') {
      const count = moov.readUInt32BE(box.payloadStart + 4)
      for (let index = 0; index < count; index += 1) {
        const position = box.payloadStart + 8 + index * 8
        if (position + 8 > box.payloadEnd) break
        const old = Number(moov.readBigUInt64BE(position))
        if (old >= oldMoovEnd) moov.writeBigUInt64BE(BigInt(old + delta), position)
      }
      return
    }
    if (!CONTAINER_TYPES.has(box.type)) return
    const innerStart = box.type === 'meta' ? box.payloadStart + 4 : box.payloadStart
    for (const child of readBoxes(moov, innerStart, box.payloadEnd)) walk(child)
  }

  for (const box of readBoxes(moov, 0, moov.length)) walk(box)
}

export async function writeMp4Tags(path: string, fields: TagFields): Promise<TagResult> {
  let data: Buffer
  try {
    data = await readFile(path)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  const top = readBoxes(data, 0, data.length)
  const moov = findBox(top, 'moov')
  if (!moov || !findBox(top, 'ftyp')) {
    // 与 mutagen 的 MP4StreamInfoError 对齐：不是 MP4 就明确失败
    return { ok: false, error: '不是合法的 MP4/M4A 文件' }
  }

  const moovChildren = readBoxes(data, moov.payloadStart, moov.payloadEnd)
  if (!isComplete(moovChildren, moov.payloadStart, moov.payloadEnd)) {
    return { ok: false, error: 'MP4 结构损坏（moov 子盒子不完整）' }
  }
  const udta = findBox(moovChildren, 'udta')
  const udtaChildren = udta ? readBoxes(data, udta.payloadStart, udta.payloadEnd) : []
  if (udta && !isComplete(udtaChildren, udta.payloadStart, udta.payloadEnd)) {
    return { ok: false, error: 'MP4 结构损坏（udta 子盒子不完整）' }
  }
  const meta = findBox(udtaChildren, 'meta')
  const metaChildren = meta ? readBoxes(data, meta.payloadStart + 4, meta.payloadEnd) : []
  if (meta && !isComplete(metaChildren, meta.payloadStart + 4, meta.payloadEnd)) {
    return { ok: false, error: 'MP4 结构损坏（meta 子盒子不完整）' }
  }
  const ilst = findBox(metaChildren, 'ilst')

  const newIlst = buildIlst(data, ilst, fields)
  const newMeta = buildMeta(data, meta, newIlst)
  const newUdta = buildUdta(data, udta, newMeta)

  const rebuiltMoovChildren: Buffer[] = []
  let wroteUdta = false
  for (const child of moovChildren) {
    if (child.type === 'udta') {
      rebuiltMoovChildren.push(newUdta)
      wroteUdta = true
    } else {
      rebuiltMoovChildren.push(data.subarray(child.start, child.payloadEnd))
    }
  }
  if (!wroteUdta) rebuiltMoovChildren.push(newUdta)

  const newMoov = makeContainer('moov', rebuiltMoovChildren)
  const delta = newMoov.length - moov.size
  patchChunkOffsets(newMoov, moov.payloadEnd, delta)

  const output: Buffer[] = []
  for (const box of top) {
    output.push(box.type === 'moov' ? newMoov : data.subarray(box.start, box.payloadEnd))
  }

  try {
    await writeFile(path, Buffer.concat(output))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
