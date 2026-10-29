/**
 * 播放地址探测：逐个候选地址请求 Range 前 1KB 判定可用性。
 *
 * 重点防两类回归：
 * 1. 200 + HTML 错误页被当成可播放；
 * 2. 扩展名推断顺序错乱（URL → 重定向 URL → Content-Disposition → MIME → 魔数）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { probeUrl, sniffAudioExt } from '../../../src/main/engine/ts/probe'
import { probeFirst } from '../../../src/main/engine/ts/base'
import { startServer } from './helpers'

const ID3 = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'binary'), Buffer.alloc(64, 0)])
const FLAC = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(64, 0)])
const WAV = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE', 'ascii'), Buffer.alloc(64, 0)])

function routes(url: string) {
  switch (url) {
    case '/ok.mp3':
      return { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '5000' }, body: Buffer.alloc(0) }
    case '/ok.flac':
      return { status: 200, headers: { 'content-type': 'audio/flac', 'content-length': '6000' }, body: Buffer.alloc(0) }
    case '/nohead':
      return { status: 405, headers: {}, body: Buffer.alloc(0) }
    case '/wrong-ext.jpg':
      return { status: 200, headers: { 'content-type': 'image/jpeg' }, body: ID3 }
    case '/html':
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<html><body>blocked</body></html>') }
    case '/hls':
      return { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n') }
    case '/disposition':
      return {
        status: 200,
        headers: { 'content-disposition': "attachment; filename*=UTF-8''%E6%AD%8C.m4a" },
        body: Buffer.alloc(0)
      }
    case '/range':
      return { status: 200, headers: { 'content-range': 'bytes 0-0/9999' }, body: WAV }
    case '/stream':
      return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: FLAC }
    default:
      return { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('not found') }
  }
}

test('探测：HEAD 可判定 / HEAD 失败回退 GET / HTML 错误页判失败 / 重定向与各类头', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/ok.flac' })
      res.end()
      return
    }
    const route = routes(req.url ?? '')
    res.writeHead(route.status, route.headers)
    res.end(req.method === 'HEAD' ? undefined : route.body)
  })
  try {
    const base = server.url

    const head = await probeUrl(`${base}/ok.mp3`)
    assert.equal(head.ok, true)
    assert.equal(head.ext, 'mp3')
    assert.equal(head.fileSizeBytes, 5000)
    assert.equal(head.method, 'HEAD')

    const nohead = await probeUrl(`${base}/nohead`, { retries: 1 })
    // HEAD 405 后走 GET，但 /nohead 的 GET 也是 405 —— 应判失败
    assert.equal(nohead.ok, false)
    assert.match(nohead.reason.join(' | '), /HEAD 405/)

    const wrongExt = await probeUrl(`${base}/wrong-ext.jpg`)
    assert.equal(wrongExt.ok, true)
    assert.equal(wrongExt.ext, 'mp3', 'URL 与 MIME 都不是音频，必须靠魔数救回来')

    const html = await probeUrl(`${base}/html`)
    assert.equal(html.ok, false, '200 + HTML 必须判失败')
    assert.match(html.reason.join(' | '), /疑似错误页/)

    const redirect = await probeUrl(`${base}/redirect`)
    assert.equal(redirect.ok, true)
    assert.equal(redirect.ext, 'flac')
    assert.match(redirect.downloadUrl, /\/ok\.flac$/)

    const hls = await probeUrl(`${base}/hls`)
    assert.equal(hls.ok, true)
    assert.equal(hls.ext, 'm3u8')

    const disposition = await probeUrl(`${base}/disposition`)
    assert.equal(disposition.ok, true)
    assert.equal(disposition.ext, 'm4a')

    const range = await probeUrl(`${base}/range`)
    assert.equal(range.ok, true)
    assert.equal(range.ext, 'wav')
    assert.equal(range.fileSizeBytes, 9999)

    const stream = await probeUrl(`${base}/stream`)
    assert.equal(stream.ok, true)
    assert.equal(stream.ext, 'flac')

    const missing = await probeUrl(`${base}/404`)
    assert.equal(missing.ok, false)
    assert.equal(missing.statusCode, 404)
  } finally {
    await server.close()
  }
})

test('非法地址直接判失败，不发请求', async () => {
  const result = await probeUrl('magnet:?xt=urn:btih:abc')
  assert.equal(result.ok, false)
  assert.equal(result.method, 'invalid-url')
  assert.equal(result.ext, '')
})

test('probeFirst 依次尝试，跳过失败与非法地址', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/good') {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '123' })
      res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(0))
      return
    }
    res.writeHead(404)
    res.end()
  })
  try {
    const chosen = await probeFirst(['', 'ftp://x/y.mp3', null, `${server.url}/bad`, `${server.url}/good`])
    assert.ok(chosen)
    assert.equal(chosen.ext, 'mp3')
    assert.equal(chosen.size, 123)
    assert.equal(chosen.protocol, 'HTTP')
    assert.match(chosen.url, /\/good$/)

    const none = await probeFirst([`${server.url}/bad`, undefined])
    assert.equal(none, null)
  } finally {
    await server.close()
  }
})

test('m3u8 命中时协议标记为 HLS', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
    res.end(req.method === 'HEAD' ? undefined : Buffer.from('#EXTM3U\n'))
  })
  try {
    const chosen = await probeFirst([`${server.url}/live`])
    assert.ok(chosen)
    assert.equal(chosen.protocol, 'HLS')
    assert.equal(chosen.ext, 'm3u8')
  } finally {
    await server.close()
  }
})

test('魔数嗅探覆盖实际会遇到的音频容器', () => {
  const ascii = (text: string): Uint8Array => Buffer.from(text, 'ascii')
  assert.equal(sniffAudioExt(ascii('ID3\u0003')), 'mp3')
  assert.equal(sniffAudioExt(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3')
  assert.equal(sniffAudioExt(Buffer.from([0xff, 0xf1, 0x50, 0x80])), 'aac')
  assert.equal(sniffAudioExt(ascii('fLaC')), 'flac')
  assert.equal(sniffAudioExt(ascii('OggS')), 'ogg')
  assert.equal(sniffAudioExt(Buffer.concat([ascii('OggS'), Buffer.from('OpusHead', 'ascii')])), 'opus')
  assert.equal(sniffAudioExt(ascii('RIFF\0\0\0\0WAVE')), 'wav')
  assert.equal(sniffAudioExt(ascii('RF64\0\0\0\0WAVE')), 'wav')
  assert.equal(sniffAudioExt(ascii('FORM\0\0\0\0AIFF')), 'aiff')
  assert.equal(sniffAudioExt(Buffer.concat([Buffer.alloc(4), ascii('ftypM4A ')])), 'm4a')
  assert.equal(sniffAudioExt(ascii('MAC ')), 'ape')
  assert.equal(sniffAudioExt(ascii('wvpk')), 'wv')
  assert.equal(sniffAudioExt(ascii('TTA1')), 'tta')
  assert.equal(sniffAudioExt(ascii('#EXTM3U')), 'm3u8')
  assert.equal(sniffAudioExt(Buffer.from([0x30, 0x26, 0xb2, 0x75])), 'wma')
  assert.equal(sniffAudioExt(Buffer.from([0x00, 0x01, 0x02, 0x03])), '')
  assert.equal(sniffAudioExt(new Uint8Array(0)), '')
})
