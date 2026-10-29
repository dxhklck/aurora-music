/**
 * HLS 下载：主清单选码率、AES-128 解密、分片并发、拼接与进度。
 * 用本地服务提供加密分片，产物与明文逐字节比对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadHls } from '../../../src/main/engine/ts/hls'
import { startServer } from './helpers'

const KEY = Buffer.from('0123456789abcdef', 'utf8')
const IV0 = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const PLAIN0 = Buffer.from('第一段音频数据'.repeat(100), 'utf8')
const PLAIN1 = Buffer.from('second-segment-payload'.repeat(100), 'utf8')

function encrypt(plain: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', KEY, iv)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/** 无 IV 时按 HLS 规范用「分片序号」作为 IV */
function sequenceIv(sequence: number): Buffer {
  const iv = Buffer.alloc(16)
  iv.writeUInt32BE(sequence, 12)
  return iv
}

test('HLS：选最高码率、解密 AES-128、按序拼接、进度上报', async () => {
  const segments: Record<string, Buffer> = {
    '/seg0.ts': encrypt(PLAIN0, IV0),
    '/seg1.ts': encrypt(PLAIN1, sequenceIv(1))
  }
  const server = await startServer((req, res) => {
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360',
          'low.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080',
          'high.m3u8',
          ''
        ].join('\n')
      )
      return
    }
    if (req.url === '/high.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          `#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${IV0.toString('hex')}`,
          '#EXTINF:4.0,',
          'seg0.ts',
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          '#EXTINF:4.0,',
          'seg1.ts',
          '#EXT-X-ENDLIST',
          ''
        ].join('\n')
      )
      return
    }
    if (req.url === '/low.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end('#EXTM3U\n#EXTINF:4,\nlow.ts\n')
      return
    }
    if (req.url === '/key.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(KEY)
      return
    }
    const segment = segments[req.url ?? '']
    if (segment) {
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end(segment)
      return
    }
    res.writeHead(404)
    res.end()
  })

  const workDir = await mkdtemp(join(tmpdir(), 'aurora-hls-test-'))
  try {
    const target = join(workDir, 'out.ts')
    const progress: Array<[number, number]> = []
    const result = await downloadHls({
      url: `${server.url}/master.m3u8`,
      target,
      onProgress: (received, total) => progress.push([received, total])
    })
    const output = await readFile(target)
    assert.deepEqual(output, Buffer.concat([PLAIN0, PLAIN1]))
    assert.equal(result.size, PLAIN0.length + PLAIN1.length)
    assert.equal(result.remuxed, false)
    assert.ok(progress.length >= 2)
    assert.equal(progress.at(-1)?.[0], result.size)
    // 选码率：请求过高码率清单，没请求低码率清单
    const urls = server.calls.map((call) => call.url)
    assert.ok(urls.includes('/high.m3u8'))
    assert.ok(!urls.includes('/low.m3u8'))
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await server.close()
  }
})

test('HLS：METHOD=NONE 时按明文拼接', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/plain.m3u8') {
      res.writeHead(200)
      res.end('#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts\n#EXTINF:4,\nb.ts\n#EXT-X-ENDLIST\n')
      return
    }
    res.writeHead(200, { 'content-type': 'video/mp2t' })
    res.end(req.url === '/a.ts' ? 'AAA' : 'BBB')
  })
  const workDir = await mkdtemp(join(tmpdir(), 'aurora-hls-test-'))
  try {
    const target = join(workDir, 'plain.ts')
    await downloadHls({ url: `${server.url}/plain.m3u8`, target })
    assert.equal(await readFile(target, 'utf8'), 'AAABBB')
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await server.close()
  }
})

test('HLS：清单不可用 / 没有分片时报 blocked', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/empty.m3u8') {
      res.writeHead(200)
      res.end('#EXTM3U\n#EXT-X-ENDLIST\n')
      return
    }
    res.writeHead(404)
    res.end()
  })
  const workDir = await mkdtemp(join(tmpdir(), 'aurora-hls-test-'))
  try {
    await assert.rejects(
      downloadHls({ url: `${server.url}/missing.m3u8`, target: join(workDir, 'x.ts') }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'blocked')
        return true
      }
    )
    await assert.rejects(
      downloadHls({ url: `${server.url}/empty.m3u8`, target: join(workDir, 'y.ts') }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'blocked')
        assert.match((error as Error).message, /没有分片/)
        return true
      }
    )
  } finally {
    await rm(workDir, { recursive: true, force: true })
    await server.close()
  }
})
