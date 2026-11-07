/**
 * FLAC 标签写入的单测。
 *
 * 重点只有一个：**元数据块之后的音频帧必须原样保留**。
 * 之前这儿的实现只把「fLaC + 元数据块」写回去，一首 30MB 的歌被写成 5KB 的空壳，
 * 文件还在、却完全没有声音，用户播到那一首才会发现。这类事故不能靠人工回归。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { readFlacBlocks, readFlacBlocksFromFile, writeFlacTags } from '../src/main/engine/ts/tag-flac.ts'

let dir = ''

async function setup(): Promise<string> {
  if (!dir) dir = await mkdtemp(join(tmpdir(), 'aurora-tagflac-'))
  return dir
}

function block(type: number, payload: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (type & 0x7f) | (last ? 0x80 : 0)
  header.writeUIntBE(payload.length, 1, 3)
  return Buffer.concat([header, payload])
}

function vorbis(entries: Array<[string, string]>, vendor = '测试写入器'): Buffer {
  const vendorBuf = Buffer.from(vendor, 'utf8')
  const parts: Buffer[] = [Buffer.alloc(4), vendorBuf, Buffer.alloc(4)]
  parts[0].writeUInt32LE(vendorBuf.length, 0)
  parts[2].writeUInt32LE(entries.length, 0)
  for (const [key, value] of entries) {
    const text = Buffer.from(`${key}=${value}`, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32LE(text.length, 0)
    parts.push(length, text)
  }
  return Buffer.concat(parts)
}

/** 造一个最小但结构合法的 FLAC：STREAMINFO +（可选）VORBIS_COMMENT + 假音频帧 */
function makeFlac(options: {
  withComment: boolean
  audio: Buffer
  comment?: Buffer
}): Buffer {
  const streaminfo = Buffer.alloc(34, 0)
  const parts: Buffer[] = [Buffer.from('fLaC', 'ascii')]
  if (options.withComment) {
    parts.push(block(0, streaminfo, false))
    parts.push(block(4, options.comment ?? vorbis([]), true))
  } else {
    parts.push(block(0, streaminfo, true))
  }
  parts.push(options.audio)
  return Buffer.concat(parts)
}

function fakeAudio(size: number): Buffer {
  const audio = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) audio[i] = (i * 7 + 13) & 0xff
  return audio
}

async function writeTemp(name: string, data: Buffer): Promise<string> {
  const path = join(await setup(), name)
  await writeFile(path, data)
  return path
}

test('写标签后音频帧一字节不少', async () => {
  const audio = fakeAudio(8192)
  const path = await writeTemp('keep.flac', makeFlac({ withComment: true, audio }))

  const result = await writeFlacTags(path, { TITLE: '新歌名', ARTIST: '某歌手' })
  assert.equal(result.ok, true)

  const out = await readFile(path)
  assert.equal(out.subarray(0, 4).toString('ascii'), 'fLaC')
  assert.equal(out.length >= audio.length, true)
  assert.deepEqual(out.subarray(out.length - audio.length), audio)
  assert.equal(out.includes(Buffer.from('TITLE=新歌名', 'utf8')), true)
})

test('没有 VORBIS_COMMENT 时自动插入，音频仍完整', async () => {
  const audio = fakeAudio(4096)
  const path = await writeTemp('no-comment.flac', makeFlac({ withComment: false, audio }))

  const result = await writeFlacTags(path, { TITLE: '补上的标题' })
  assert.equal(result.ok, true)

  const out = await readFile(path)
  const parsed = readFlacBlocks(out)
  assert.notEqual(parsed, null)
  assert.equal(parsed?.blocks.some((b) => b.type === 4), true)
  assert.deepEqual(out.subarray(out.length - audio.length), audio)
  assert.equal(out.includes(Buffer.from('TITLE=补上的标题', 'utf8')), true)
})

test('不认识的字段保留，同名键被覆盖', async () => {
  const audio = fakeAudio(2048)
  const comment = vorbis([
    ['TITLE', '旧标题'],
    ['COMMENT', '别动我'],
    ['TRACKNUMBER', '7']
  ])
  const path = await writeTemp('merge.flac', makeFlac({ withComment: true, audio, comment }))

  await writeFlacTags(path, { TITLE: '新标题', ALBUM: '新专辑' })
  const out = await readFile(path)
  const text = out.toString('utf8')

  assert.equal(text.includes('COMMENT=别动我'), true)
  assert.equal(text.includes('TRACKNUMBER=7'), true)
  assert.equal(text.includes('TITLE=新标题'), true)
  assert.equal(text.includes('旧标题'), false)
  assert.equal(text.includes('ALBUM=新专辑'), true)
  assert.deepEqual(out.subarray(out.length - audio.length), audio)
})

test('非 FLAC 文件不动原文件', async () => {
  const junk = Buffer.from('这不是 flac，只是一段任意字节', 'utf8')
  const path = await writeTemp('junk.flac', junk)

  const result = await writeFlacTags(path, { TITLE: 'x' })
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /FLAC/i)
  assert.deepEqual(await readFile(path), junk)
})

test('末尾没有音频帧时也不报错（只有元数据块的坏文件）', async () => {
  const streaminfo = Buffer.alloc(34, 0)
  const onlyMeta = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    block(0, streaminfo, false),
    block(4, vorbis([]), true)
  ])
  const path = await writeTemp('meta-only.flac', onlyMeta)

  const result = await writeFlacTags(path, { TITLE: '只有头' })
  assert.equal(result.ok, true)
  const out = await readFile(path)
  assert.equal(out.subarray(0, 4).toString('ascii'), 'fLaC')
})

test('metadata 块声明长度越界时拒绝写入，原文件一字节不动', async () => {
  const header = Buffer.alloc(4)
  header[0] = 0x80 // STREAMINFO + last
  header.writeUIntBE(500, 1, 3) // 声明 500 字节，实际只给了 34
  const broken = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    header,
    Buffer.alloc(34),
    fakeAudio(128)
  ])
  const path = await writeTemp('overlong.flac', broken)

  const result = await writeFlacTags(path, { TITLE: '别写' })
  assert.equal(result.ok, false)
  assert.deepEqual(await readFile(path), broken)
  assert.equal(existsSync(`${path}.aurora-tmp`), false)
})

test('metadata 链没有 last 标志时拒绝写入', async () => {
  const broken = Buffer.concat([
    Buffer.from('fLaC', 'ascii'),
    block(0, Buffer.alloc(34, 0), false),
    fakeAudio(256)
  ])
  const path = await writeTemp('no-last.flac', broken)
  const result = await writeFlacTags(path, { TITLE: '别写' })
  assert.equal(result.ok, false)
  assert.deepEqual(await readFile(path), broken)
})

test('VORBIS_COMMENT 损坏时拒绝写入，不静默重建丢掉已有标签', async () => {
  const brokenComment = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]), // vendorLength 越界
    Buffer.alloc(8)
  ])
  const audio = fakeAudio(1024)
  const broken = makeFlac({ withComment: true, audio, comment: brokenComment })
  const path = await writeTemp('broken-comment.flac', broken)

  const result = await writeFlacTags(path, { TITLE: '别写' })
  assert.equal(result.ok, false)
  assert.deepEqual(await readFile(path), broken)
})

test('成功写入后不残留临时文件（写盘是 tmp + rename）', async () => {
  const path = await writeTemp(
    'atomic.flac',
    makeFlac({ withComment: true, audio: fakeAudio(512) })
  )
  assert.equal((await writeFlacTags(path, { TITLE: 'ok' })).ok, true)
  assert.equal(existsSync(`${path}.aurora-tmp`), false)
})

test('较大文件的音频帧也一字节不少（流式 pipe 搬运）', async () => {
  const audio = fakeAudio(3 * 1024 * 1024)
  const path = await writeTemp('large.flac', makeFlac({ withComment: true, audio }))
  const result = await writeFlacTags(path, { TITLE: '大文件' })
  assert.equal(result.ok, true)
  const out = await readFile(path)
  assert.equal(out.length >= audio.length, true)
  assert.deepEqual(out.subarray(out.length - audio.length), audio)
})

test('readFlacBlocksFromFile 与内存版判据一致：越界返回 null', async () => {
  const header = Buffer.alloc(4)
  header[0] = 0x80 // STREAMINFO + last
  header.writeUIntBE(500, 1, 3)
  const broken = Buffer.concat([Buffer.from('fLaC', 'ascii'), header, Buffer.alloc(34), fakeAudio(64)])
  const path = await writeTemp('overlong-file.flac', broken)
  assert.equal(await readFlacBlocksFromFile(path), null)
})

test.after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})
