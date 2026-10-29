/**
 * 标签写入：MP3（ID3v2.3）与 FLAC（Vorbis Comment）。
 *
 * 除了「写进去」，还要验证「不该丢的没丢」——已有 APIC 封面与自定义 Vorbis 字段
 * 必须保留，否则一次打标签会把用户之前整理的元数据全抹掉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeTags } from '../../../src/main/engine/ts/tag'

function syncSafe(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
}

function id3Frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.write(id, 0, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function buildMp3(): Buffer {
  const apic = id3Frame(
    'APIC',
    Buffer.concat([
      Buffer.from([0x00]),
      Buffer.from('image/jpeg\u0000', 'latin1'),
      Buffer.from([0x03, 0x00]),
      Buffer.from('COVER-BYTES')
    ])
  )
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([0x03, 0x00, 0x00]), syncSafe(apic.length)])
  return Buffer.concat([header, apic, Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(256, 0)])
}

interface ParsedFrame {
  id: string
  body: Buffer
}

function parseId3(data: Buffer): { version: number; frames: ParsedFrame[]; audioStart: number } {
  assert.equal(data.subarray(0, 3).toString('ascii'), 'ID3')
  const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f)
  const frames: ParsedFrame[] = []
  let cursor = 10
  while (cursor + 10 <= 10 + size) {
    const id = data.subarray(cursor, cursor + 4).toString('ascii')
    const length = data.readUInt32BE(cursor + 4)
    if (!/^[A-Z0-9]{4}$/.test(id) || length <= 0) break
    frames.push({ id, body: data.subarray(cursor + 10, cursor + 10 + length) })
    cursor += 10 + length
  }
  return { version: data[3], frames, audioStart: 10 + size }
}

function decodeUtf16(body: Buffer): string {
  assert.equal(body[0], 1, '文本帧编码应为 UTF-16')
  assert.equal(body[1], 0xff)
  assert.equal(body[2], 0xfe)
  return body.subarray(3).toString('utf16le')
}

function flacBlock(type: number, payload: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (type & 0x7f) | (last ? 0x80 : 0)
  header.writeUIntBE(payload.length, 1, 3)
  return Buffer.concat([header, payload])
}

function buildVorbis(vendor: string, entries: string[]): Buffer {
  const vendorBuffer = Buffer.from(vendor, 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32LE(vendorBuffer.length, 0)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(entries.length, 0)
  const parts = [head, vendorBuffer, count]
  for (const entry of entries) {
    const text = Buffer.from(entry, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(text.length, 0)
    parts.push(length, text)
  }
  return Buffer.concat(parts)
}

function readFlacComment(payload: Buffer): Record<string, string> {
  let cursor = 0
  const vendorLength = payload.readUInt32LE(cursor)
  cursor += 4 + vendorLength
  const count = payload.readUInt32LE(cursor)
  cursor += 4
  const entries: Record<string, string> = {}
  for (let index = 0; index < count; index += 1) {
    const length = payload.readUInt32LE(cursor)
    cursor += 4
    const text = payload.subarray(cursor, cursor + length).toString('utf8')
    cursor += length
    const eq = text.indexOf('=')
    if (eq > 0) entries[text.slice(0, eq).toUpperCase()] = text.slice(eq + 1)
  }
  return entries
}

function parseFlac(data: Buffer): Array<{ type: number; last: boolean; payload: Buffer }> {
  assert.equal(data.subarray(0, 4).toString('ascii'), 'fLaC')
  const blocks: Array<{ type: number; last: boolean; payload: Buffer }> = []
  let cursor = 4
  while (cursor + 4 <= data.length) {
    const header = data[cursor]
    const length = data.readUIntBE(cursor + 1, 3)
    blocks.push({ type: header & 0x7f, last: Boolean(header & 0x80), payload: data.subarray(cursor + 4, cursor + 4 + length) })
    cursor += 4 + length
    if (header & 0x80) break
  }
  return blocks
}

test('MP3：写入 TIT2/TPE1/TALB/USLT/TRCK，并保留既有 APIC', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-'))
  try {
    const path = join(dir, 'a.mp3')
    await writeFile(path, buildMp3())
    const result = await writeTags({
      path,
      title: '测试标题',
      artists: '测试歌手',
      album: '测试专辑',
      lyric: '[00:01.00]第一行',
      track: 3
    })
    assert.deepEqual(result, { ok: true })

    const parsed = parseId3(await readFile(path))
    assert.equal(parsed.version, 3)
    const byId = (id: string): ParsedFrame[] => parsed.frames.filter((frame) => frame.id === id)
    assert.equal(decodeUtf16(byId('TIT2')[0].body), '测试标题')
    assert.equal(decodeUtf16(byId('TPE1')[0].body), '测试歌手')
    assert.equal(decodeUtf16(byId('TALB')[0].body), '测试专辑')
    assert.equal(decodeUtf16(byId('TRCK')[0].body), '3')
    assert.ok(byId('USLT').length === 1)
    // USLT 结构：encoding + 'chi' + 空描述 + 正文
    const uslt = byId('USLT')[0].body
    assert.equal(uslt.subarray(1, 4).toString('ascii'), 'chi')
    assert.match(uslt.subarray(4).toString('utf16le'), /第一行/)

    const apic = byId('APIC')
    assert.equal(apic.length, 1, '封面帧必须保留')
    assert.match(apic[0].body.toString('latin1'), /COVER-BYTES/)
    // 音频数据跟在标签之后
    assert.equal((await readFile(path))[parsed.audioStart], 0xff)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('MP3：重复写标签不会累积帧', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-'))
  try {
    const path = join(dir, 'a.mp3')
    await writeFile(path, buildMp3())
    const payload = { path, title: 'A', artists: 'B', album: 'C' }
    await writeTags(payload)
    await writeTags(payload)
    const parsed = parseId3(await readFile(path))
    assert.equal(parsed.frames.filter((frame) => frame.id === 'TIT2').length, 1)
    assert.equal(parsed.frames.filter((frame) => frame.id === 'APIC').length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FLAC：重建 metadata 块链，追加 Vorbis Comment 并正确设置 last 标志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-'))
  try {
    const path = join(dir, 'a.flac')
    await writeFile(path, Buffer.concat([Buffer.from('fLaC', 'ascii'), flacBlock(0, Buffer.alloc(34, 0), true), Buffer.alloc(128, 0)]))
    const result = await writeTags({ path, title: '标题', artists: '歌手', album: '专辑', lyric: '歌词', track: 2 })
    assert.deepEqual(result, { ok: true })

    const blocks = parseFlac(await readFile(path))
    assert.deepEqual(blocks.map((block) => block.type), [0, 4])
    assert.equal(blocks[0].last, false)
    assert.equal(blocks[1].last, true)
    const comment = readFlacComment(blocks[1].payload)
    assert.equal(comment.TITLE, '标题')
    assert.equal(comment.ARTIST, '歌手')
    assert.equal(comment.ALBUM, '专辑')
    assert.equal(comment.LYRICS, '歌词')
    assert.equal(comment.TRACKNUMBER, '2')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('FLAC：已有自定义字段保留，同名键被覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-'))
  try {
    const path = join(dir, 'a.flac')
    const existing = buildVorbis('ref', ['KEEP=1', 'TITLE=旧标题'])
    await writeFile(
      path,
      Buffer.concat([Buffer.from('fLaC', 'ascii'), flacBlock(4, existing, true), Buffer.alloc(32, 0)])
    )
    await writeTags({ path, title: '新标题', artists: '歌手', album: '专辑' })
    const blocks = parseFlac(await readFile(path))
    const comment = readFlacComment(blocks[0].payload)
    assert.equal(comment.KEEP, '1')
    assert.equal(comment.TITLE, '新标题')
    assert.equal(blocks[0].last, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('WAV 与未知容器返回 skipped（不能让下载被标成失败）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-'))
  try {
    // WAV 的 RIFF INFO 收益低，跳过
    const wavPath = join(dir, 'a.wav')
    await writeFile(wavPath, Buffer.from('x'))
    assert.deepEqual(await writeTags({ path: wavPath, title: 'a', artists: 'b', album: 'c' }), {
      ok: true,
      skipped: 'wav'
    })
    // 未知扩展名（含 .ape）：skipped 保留原始后缀（含点）
    for (const ext of ['txt', 'ape']) {
      const unknownPath = join(dir, `a.${ext}`)
      await writeFile(unknownPath, Buffer.from('x'))
      assert.deepEqual(
        await writeTags({ path: unknownPath, title: 'a', artists: 'b', album: 'c' }),
        { ok: true, skipped: `.${ext}` }
      )
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('非法 FLAC 返回 ok:false 而不是抛异常', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-tag-'))
  try {
    const path = join(dir, 'bad.flac')
    await writeFile(path, Buffer.from('not a flac'))
    const result = await writeTags({ path, title: 'a', artists: 'b', album: 'c' })
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /FLAC/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
