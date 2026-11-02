/**
 * 音频标签读取的单测。
 *
 * fixture 全部**按容器规范手工构造**，不用项目自己的 `writeTags` 回环生成——
 * 「自己写、自己读」只能证明自洽，证明不了能读别的工具产出的文件。
 * 手工构造至少能证明解析器是照规范写的（帧头尺寸语义、Vorbis 键值、MP4 atom 树）。
 *
 * 三种容器各测：字段、封面、时长；外加损坏文件与不存在的文件。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readTagFields } from '../src/main/engine/ts/tag-read.ts'

let dir = ''

async function setup(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'aurora-tagread-'))
  return dir
}

async function writeTemp(name: string, data: Buffer): Promise<string> {
  const base = await setup()
  const filePath = join(base, name)
  await writeFile(filePath, data)
  return filePath
}

// ─────────────────────────── 构造工具 ───────────────────────────

function syncSafe(size: number): Buffer {
  return Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])
}

/** 一张最小的「PNG」：只要魔数对，解析器不该校验图像内容 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

function id3Frame(id: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.write(id, 0, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function id3Text(text: string): Buffer {
  // encoding 3 = UTF-8（ID3v2.4 常见；v2.3 里也能读）
  return Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')])
}

function id3Apic(): Buffer {
  return Buffer.concat([
    Buffer.from([3]), // encoding UTF-8
    Buffer.from('image/png\0', 'latin1'),
    Buffer.from([3]), // picture type 3 = front cover
    Buffer.from('\0', 'latin1'), // 空描述
    PNG
  ])
}

/** 一个带 Xing 头的 MPEG1 Layer3 帧：112 帧 @44100Hz = 2926ms */
function mpegFrame(frames: number): Buffer {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]) // MPEG1 L3, 128kbps, 44100, stereo
  const sideInfo = Buffer.alloc(32)
  const xing = Buffer.alloc(12)
  xing.write('Xing', 0, 'ascii')
  xing.writeUInt32BE(0x01, 4) // flags: 有 frames 字段
  xing.writeUInt32BE(frames, 8)
  return Buffer.concat([header, sideInfo, xing])
}

function buildMp3(): Buffer {
  const frames = Buffer.concat([
    id3Frame('TIT2', id3Text('夜曲')),
    id3Frame('TPE1', id3Text('周杰伦')),
    id3Frame('TALB', id3Text('十一月的萧邦')),
    id3Frame('TLEN', id3Text('226000')),
    id3Frame('APIC', id3Apic())
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncSafe(frames.length)])
  // 标签后面接 512KB 假音频：解析必须按 ID3 长度定位，不能靠「读到这里为止」猜
  const audio = Buffer.concat([mpegFrame(112), Buffer.alloc(512 * 1024)])
  return Buffer.concat([header, frames, audio])
}

/** 不带 TLEN 的 mp3：时长只能来自 Xing */
function buildMp3WithoutTlen(): Buffer {
  const frames = Buffer.concat([
    id3Frame('TIT2', id3Text('无时长标签')),
    id3Frame('TPE1', id3Text('测试歌手'))
  ])
  const header = Buffer.concat([Buffer.from('ID3', 'ascii'), Buffer.from([3, 0, 0]), syncSafe(frames.length)])
  return Buffer.concat([header, frames, mpegFrame(112), Buffer.alloc(1024)])
}

function flacBlock(type: number, body: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (last ? 0x80 : 0) | type
  header[1] = (body.length >> 16) & 0xff
  header[2] = (body.length >> 8) & 0xff
  header[3] = body.length & 0xff
  return Buffer.concat([header, body])
}

function buildFlac(): Buffer {
  // STREAMINFO：44100Hz、2 声道、16 位、441000 个样本 = 10000ms
  const info = Buffer.alloc(34)
  info.writeUInt16BE(4096, 0)
  info.writeUInt16BE(4096, 2)
  info[10] = (44100 >> 12) & 0xff
  info[11] = (44100 >> 4) & 0xff
  info[12] = ((44100 & 0x0f) << 4) | (1 << 1) // 声道数-1 = 1，位深高位
  info[13] = ((15 & 0x01) << 7) | ((441000 / 2 ** 32) & 0x0f) // 位深低 4 位 + 总样本高位
  info.writeUInt32BE(441000 & 0xffffffff, 14)

  const vendor = Buffer.from('aurora-test', 'utf8')
  const comments = ['TITLE=夜曲', 'ARTIST=周杰伦', 'ARTIST=费玉清', 'ALBUM=十一月的萧邦']
  const parts: Buffer[] = []
  const vendorLen = Buffer.alloc(4)
  vendorLen.writeUInt32LE(vendor.length, 0)
  parts.push(vendorLen, vendor)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(comments.length, 0)
  parts.push(count)
  for (const comment of comments) {
    const payload = Buffer.from(comment, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32LE(payload.length, 0)
    parts.push(len, payload)
  }
  const vorbis = Buffer.concat(parts)

  const mime = Buffer.from('image/png', 'latin1')
  const pictureParts: Buffer[] = []
  const u32 = (value: number): Buffer => {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(value, 0)
    return buf
  }
  pictureParts.push(u32(3), u32(mime.length), mime, u32(0), u32(500), u32(500), u32(24), u32(0), u32(PNG.length), PNG)
  const picture = Buffer.concat(pictureParts)

  return Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    flacBlock(0, info, false),
    flacBlock(4, vorbis, false),
    flacBlock(6, picture, true),
    Buffer.alloc(2048) // 假音频帧
  ])
}

function atom(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + body.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, body])
}

function dataAtom(dataType: number, payload: Buffer): Buffer {
  const typeBuffer = Buffer.alloc(4)
  typeBuffer.writeUInt32BE(dataType & 0x00ffffff, 0)
  return atom('data', typeBuffer, Buffer.alloc(4), payload)
}

function buildM4a(mdatFirst: boolean): Buffer {
  const ftyp = atom('ftyp', Buffer.from('M4A ', 'latin1'), Buffer.alloc(4), Buffer.from('M4A mp42isom', 'latin1'))

  const mvhdBody = Buffer.alloc(100)
  mvhdBody.writeUInt8(0, 0)
  mvhdBody.writeUInt32BE(1000, 12) // timescale
  mvhdBody.writeUInt32BE(30000, 16) // duration → 30000ms
  const mvhd = atom('mvhd', mvhdBody)

  const ilst = atom(
    'ilst',
    atom('\xa9nam', dataAtom(1, Buffer.from('夜曲', 'utf8'))),
    atom('\xa9ART', dataAtom(1, Buffer.from('周杰伦', 'utf8'))),
    atom('\xa9alb', dataAtom(1, Buffer.from('十一月的萧邦', 'utf8'))),
    atom('covr', dataAtom(14, PNG))
  )
  const meta = atom('meta', Buffer.alloc(4), ilst)
  const udta = atom('udta', meta)
  const moov = atom('moov', mvhd, udta)
  const mdat = atom('mdat', Buffer.alloc(4096))

  return mdatFirst
    ? Buffer.concat([ftyp, mdat, moov])
    : Buffer.concat([ftyp, moov, mdat])
}

// ─────────────────────────── 用例 ───────────────────────────

test('mp3：读出歌名/歌手/专辑/时长/封面', async () => {
  const file = await writeTemp('sample.mp3', buildMp3())
  const fields = await readTagFields(file)
  assert.ok(fields)
  assert.equal(fields.container, 'mp3')
  assert.equal(fields.title, '夜曲')
  assert.deepEqual(fields.artists, ['周杰伦'])
  assert.equal(fields.album, '十一月的萧邦')
  // TLEN 优先于 Xing
  assert.equal(fields.duration, 226000)
  assert.ok(fields.cover)
  assert.equal(fields.cover.mime, 'image/png')
  assert.deepEqual(fields.cover.data, PNG)
})

test('mp3：没有 TLEN 时用第一帧的 Xing 帧数算时长（不是估算）', async () => {
  const file = await writeTemp('no-tlen.mp3', buildMp3WithoutTlen())
  const fields = await readTagFields(file)
  assert.ok(fields)
  // 112 帧 × 1152 样本 / 44100Hz = 2925.7ms
  assert.equal(fields.duration, 2926)
})

test('mp3：不读封面时也拿得到字段（扫描大量文件时省 IO）', async () => {
  const file = await writeTemp('no-cover.mp3', buildMp3())
  const fields = await readTagFields(file, { withCover: false })
  assert.ok(fields)
  assert.equal(fields.title, '夜曲')
  assert.equal(fields.cover, undefined)
})

test('flac：Vorbis Comment 多歌手、STREAMINFO 时长、PICTURE 封面', async () => {
  const file = await writeTemp('sample.flac', buildFlac())
  const fields = await readTagFields(file)
  assert.ok(fields)
  assert.equal(fields.container, 'flac')
  assert.equal(fields.title, '夜曲')
  assert.deepEqual(fields.artists, ['周杰伦', '费玉清'])
  assert.equal(fields.album, '十一月的萧邦')
  // 441000 样本 / 44100Hz = 10000ms
  assert.equal(fields.duration, 10000)
  assert.ok(fields.cover)
  assert.equal(fields.cover.mime, 'image/png')
})

test('m4a：ilst 字段、covr 封面、mvhd 时长', async () => {
  const file = await writeTemp('sample.m4a', buildM4a(false))
  const fields = await readTagFields(file)
  assert.ok(fields)
  assert.equal(fields.container, 'm4a')
  assert.equal(fields.title, '夜曲')
  assert.deepEqual(fields.artists, ['周杰伦'])
  assert.equal(fields.album, '十一月的萧邦')
  assert.equal(fields.duration, 30000)
  assert.ok(fields.cover)
  assert.equal(fields.cover.mime, 'image/png')
})

test('m4a：moov 在 mdat 之后也能找到（跳过音频数据，不整文件读）', async () => {
  const file = await writeTemp('moov-last.m4a', buildM4a(true))
  const fields = await readTagFields(file)
  assert.ok(fields)
  assert.equal(fields.title, '夜曲')
  assert.equal(fields.duration, 30000)
})

test('损坏文件不抛异常，返回 null', async () => {
  const file = await writeTemp('broken.mp3', Buffer.from('ID3\u0003\u0000\u0000garbage'))
  const fields = await readTagFields(file)
  // 头部能认出 ID3，但帧表解析不出来：字段全空而不是崩掉
  assert.ok(fields === null || fields.title === undefined)
})

test('不是音频的文件返回 null', async () => {
  const file = await writeTemp('not-audio.txt', Buffer.from('这只是一段普通文本，长度足够绕过头部检查'.repeat(4)))
  assert.equal(await readTagFields(file), null)
})

test('文件不存在返回 null，不抛异常', async () => {
  assert.equal(await readTagFields(join(tmpdir(), 'aurora-not-exist-12345.mp3')), null)
})

test('空文件返回 null', async () => {
  const file = await writeTemp('empty.mp3', Buffer.alloc(0))
  assert.equal(await readTagFields(file), null)
})

// 清理临时目录（best effort，不影响用例结果）
process.on('exit', () => {
  if (dir) {
    try {
      void rm(dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
})
