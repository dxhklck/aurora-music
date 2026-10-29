/**
 * 容器级标签写入：MP4（m4a/mp4）与 Ogg（Vorbis/Opus）。
 *
 * 每个用例都验证三件事：
 * 1. 标签确实写进去了；
 * 2. 音频数据一个字节没动（mdat / 音频 packet 全等）；
 * 3. 索引仍然指向正确的位置（MP4 的 stco、Ogg 的 granule）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTags } from '../../../src/main/engine/ts/tag'

const FIXTURES = join(process.cwd(), 'scripts/engine-ts/fixtures/audio')
const FIELDS = { title: '测试标题', artists: '测试歌手', album: '测试专辑', lyric: '[00:01.00]第一行' }

async function withCopy(name: string, run: (path: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-container-'))
  try {
    const path = join(dir, name)
    await copyFile(join(FIXTURES, name), path)
    await run(path, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

interface Box {
  type: string
  offset: number
  size: number
  header: number
}

function boxes(data: Buffer): Box[] {
  const output: Box[] = []
  let cursor = 0
  while (cursor + 8 <= data.length) {
    let size = data.readUInt32BE(cursor)
    const type = data.toString('latin1', cursor + 4, cursor + 8)
    let header = 8
    if (size === 1) {
      size = Number(data.readBigUInt64BE(cursor + 8))
      header = 16
    } else if (size === 0) {
      size = data.length - cursor
    }
    output.push({ type, offset: cursor, size, header })
    if (size < header) break
    cursor += size
  }
  return output
}

function children(data: Buffer, parent: Box, skip = 0): Box[] {
  const start = parent.offset + parent.header + skip
  const end = parent.offset + parent.size
  const output: Box[] = []
  let cursor = start
  while (cursor + 8 <= end) {
    const size = data.readUInt32BE(cursor)
    const type = data.toString('latin1', cursor + 4, cursor + 8)
    if (size < 8 || cursor + size > end) break
    output.push({ type, offset: cursor, size, header: 8 })
    cursor += size
  }
  return output
}

function mdatPayload(data: Buffer): Buffer {
  const box = boxes(data).find((item) => item.type === 'mdat')
  if (!box) return Buffer.alloc(0)
  return data.subarray(box.offset + box.header, box.offset + box.size)
}

function mdatPayloadOffset(data: Buffer): number {
  const box = boxes(data).find((item) => item.type === 'mdat')
  return box ? box.offset + box.header : -1
}

function stcoValues(data: Buffer): number[] {
  const index = data.indexOf(Buffer.from('stco', 'latin1'))
  if (index < 0) return []
  const count = data.readUInt32BE(index + 8)
  const values: number[] = []
  for (let item = 0; item < count; item += 1) values.push(data.readUInt32BE(index + 12 + item * 4))
  return values
}

function mp4Items(data: Buffer): Map<string, string> {
  const output = new Map<string, string>()
  const moov = boxes(data).find((box) => box.type === 'moov')
  if (!moov) return output
  const udta = children(data, moov).find((box) => box.type === 'udta')
  if (!udta) return output
  const meta = children(data, udta).find((box) => box.type === 'meta')
  if (!meta) return output
  const ilst = children(data, meta, 4).find((box) => box.type === 'ilst')
  if (!ilst) return output
  for (const item of children(data, ilst)) {
    const atom = children(data, item).find((box) => box.type === 'data')
    if (!atom) continue
    output.set(item.type, data.subarray(atom.offset + 16, atom.offset + atom.size).toString('utf8'))
  }
  return output
}

interface OggPage {
  type: number
  granule: bigint
  sequence: number
  segments: number[]
  body: Buffer
}

function oggPages(data: Buffer): OggPage[] {
  const output: OggPage[] = []
  let cursor = 0
  while (cursor + 27 <= data.length && data.toString('ascii', cursor, cursor + 4) === 'OggS') {
    const count = data[cursor + 26]
    const segments: number[] = []
    for (let index = 0; index < count; index += 1) segments.push(data[cursor + 27 + index])
    const start = cursor + 27 + count
    const length = segments.reduce((sum, value) => sum + value, 0)
    output.push({
      type: data[cursor + 5],
      granule: data.readBigUInt64LE(cursor + 6),
      sequence: data.readUInt32LE(cursor + 18),
      segments,
      body: data.subarray(start, start + length)
    })
    cursor = start + length
  }
  return output
}

function oggPackets(pages: OggPage[]): Buffer[] {
  const packets: Buffer[] = []
  let current: Buffer[] = []
  for (const page of pages) {
    let offset = 0
    for (const length of page.segments) {
      current.push(page.body.subarray(offset, offset + length))
      offset += length
      if (length < 255) {
        packets.push(Buffer.concat(current))
        current = []
      }
    }
  }
  return packets
}

function oggComments(packet: Buffer): Map<string, string> {
  const output = new Map<string, string>()
  const prefix = packet.subarray(0, 7).toString('latin1') === '\x03vorbis' ? 7 : 8
  let cursor = prefix
  const vendorLength = packet.readUInt32LE(cursor)
  cursor += 4 + vendorLength
  const count = packet.readUInt32LE(cursor)
  cursor += 4
  for (let index = 0; index < count; index += 1) {
    const length = packet.readUInt32LE(cursor)
    cursor += 4
    const text = packet.subarray(cursor, cursor + length).toString('utf8')
    cursor += length
    const equal = text.indexOf('=')
    if (equal > 0) output.set(text.slice(0, equal).toUpperCase(), text.slice(equal + 1))
  }
  return output
}

for (const name of ['sample-tail.m4a', 'sample-fast.m4a']) {
  test(`MP4：${name} 写入四类标签，音频与 stco 都保持不变`, async () => {
    await withCopy(name, async (path) => {
      const before = await readFile(path)
      const result = await writeTags({ path, ...FIELDS })
      assert.deepEqual(result, { ok: true })
      const after = await readFile(path)

      assert.deepEqual(mdatPayload(after), mdatPayload(before), 'mdat 必须逐字节不变')
      const items = mp4Items(after)
      assert.equal(items.get('\u00a9nam'), FIELDS.title)
      assert.equal(items.get('\u00a9ART'), FIELDS.artists)
      assert.equal(items.get('\u00a9alb'), FIELDS.album)
      assert.equal(items.get('\u00a9lyr'), FIELDS.lyric)
      const offsets = stcoValues(after)
      assert.ok(offsets.length > 0)
      assert.ok(
        offsets.every((value) => value === mdatPayloadOffset(after)),
        `stco 应指向 mdat 数据起点：${offsets} vs ${mdatPayloadOffset(after)}`
      )
    })
  })
}

test('MP4：重复写标签不会累积原子，也不会破坏 faststart 偏移', async () => {
  await withCopy('sample-fast.m4a', async (path) => {
    await writeTags({ path, ...FIELDS })
    const first = await readFile(path)
    await writeTags({ path, ...FIELDS })
    const second = await readFile(path)
    const items = mp4Items(second)
    assert.equal(items.get('\u00a9nam'), FIELDS.title)
    // 只应存在一个标题原子：用原始字节里 ©nam 出现次数判断
    assert.equal(second.toString('latin1').split('\u00a9nam').length - 1, 1)
    assert.deepEqual(mdatPayload(second), mdatPayload(first))
    assert.ok(stcoValues(second).every((value) => value === mdatPayloadOffset(second)))
  })
})

test('MP4：不传歌词时不写 ©lyr；空字段不产生空原子', async () => {
  await withCopy('sample-tail.m4a', async (path) => {
    await writeTags({ path, title: '只有标题', artists: '歌手', album: '专辑' })
    const items = mp4Items(await readFile(path))
    assert.equal(items.get('\u00a9nam'), '只有标题')
    assert.equal(items.has('\u00a9lyr'), false)
  })
})

test('MP4：ADTS 裸流与损坏文件返回 ok:false（与 mutagen 一致）', async () => {
  await withCopy('sample-adts.aac', async (path) => {
    const result = await writeTags({ path, ...FIELDS })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /MP4/)
  })
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-container-'))
  try {
    const path = join(dir, 'broken.m4a')
    await writeFile(path, Buffer.from('not a mp4 at all'))
    const result = await writeTags({ path, ...FIELDS })
    assert.equal(result.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Ogg Vorbis：标签写入成功，音频包与 granule 不变', async () => {
  await withCopy('sample-vorbis.ogg', async (path) => {
    const before = oggPackets(oggPages(await readFile(path)))
    const result = await writeTags({ path, ...FIELDS })
    assert.deepEqual(result, { ok: true })
    const afterPages = oggPages(await readFile(path))
    const after = oggPackets(afterPages)

    assert.deepEqual(after[0], before[0], 'identification packet 必须不变')
    assert.deepEqual(after[2], before[2], 'setup packet 必须不变')
    assert.deepEqual(after.slice(3), before.slice(3), '音频包必须逐字节不变')
    const comments = oggComments(after[1])
    assert.equal(comments.get('TITLE'), FIELDS.title)
    assert.equal(comments.get('ARTIST'), FIELDS.artists)
    assert.equal(comments.get('ALBUM'), FIELDS.album)
    assert.equal(comments.get('LYRICS'), FIELDS.lyric)
    assert.equal(afterPages.at(-1)?.granule, oggPages(await readFile(join(FIXTURES, 'sample-vorbis.ogg'))).at(-1)?.granule)
  })
})

test('Ogg Vorbis：保留自定义字段，重复写不重复追加', async () => {
  await withCopy('sample-vorbis-custom.ogg', async (path) => {
    await writeTags({ path, ...FIELDS })
    await writeTags({ path, ...FIELDS })
    const items = oggComments(oggPackets(oggPages(await readFile(path)))[1])
    assert.equal(items.get('KEEP'), '1')
    assert.equal(items.get('TITLE'), FIELDS.title)
    const raw = (await readFile(path)).toString('latin1')
    assert.equal(raw.split('TITLE=').length - 1, 1)
  })
})

test('Ogg Opus：写入 OpusTags 并保留音频包；.ogg 扩展名按内容识别', async () => {
  for (const name of ['sample-opus.opus', 'sample-opus-in-ogg.ogg']) {
    await withCopy(name, async (path) => {
      const before = oggPackets(oggPages(await readFile(path)))
      const result = await writeTags({ path, ...FIELDS })
      assert.deepEqual(result, { ok: true }, name)
      const after = oggPackets(oggPages(await readFile(path)))
      assert.deepEqual(after[0], before[0])
      assert.deepEqual(after.slice(2), before.slice(2), `${name} 的音频包必须不变`)
      const comments = oggComments(after[1])
      assert.equal(comments.get('TITLE'), FIELDS.title)
      assert.equal(comments.get('LYRICS'), FIELDS.lyric)
    })
  }
})

test('Ogg Vorbis：超长歌词跨页写入，setup 与音频包仍不变', async () => {
  await withCopy('sample-vorbis.ogg', async (path) => {
    const before = oggPackets(oggPages(await readFile(path)))
    const lyric = `[00:01.00]${'长歌词'.repeat(30_000)}`
    const result = await writeTags({ path, title: '长歌词', artists: '歌手', album: '专辑', lyric })
    assert.deepEqual(result, { ok: true })
    const after = oggPackets(oggPages(await readFile(path)))
    assert.deepEqual(after[0], before[0])
    assert.deepEqual(after[2], before[2], 'setup packet 必须不变')
    assert.deepEqual(after.slice(3), before.slice(3), '音频包必须不变')
    assert.equal(oggComments(after[1]).get('LYRICS'), lyric)
    // comment 超过 64KB 必然跨页，确认页数增加且续包标志被正确设置
    const pages = oggPages(await readFile(path))
    assert.ok(pages.length > 3, `应产生多页头，实际 ${pages.length}`)
    assert.ok(pages.some((page) => (page.type & 0x01) !== 0), '跨页包应带 continued 标志')
  })
})

test('截断的容器不会被部分改写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-container-'))
  try {
    for (const [name, keep] of [
      ['sample-vorbis.ogg', 0.6],
      ['sample-tail.m4a', 0.6]
    ] as const) {
      const path = join(dir, name)
      const data = await readFile(join(FIXTURES, name))
      const truncated = data.subarray(0, Math.floor(data.length * keep))
      await writeFile(path, truncated)
      const result = await writeTags({ path, ...FIELDS })
      assert.equal(result.ok, false, `${name} 应拒绝改写`)
      assert.deepEqual(await readFile(path), truncated, `${name} 失败时不能改动文件`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Ogg：非 Ogg 数据静默成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-container-'))
  try {
    const path = join(dir, 'broken.ogg')
    await writeFile(path, Buffer.from('this is not an ogg file'))
    assert.deepEqual(await writeTags({ path, ...FIELDS }), { ok: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
