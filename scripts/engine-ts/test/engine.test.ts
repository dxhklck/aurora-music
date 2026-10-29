/**
 * 引擎门面：search / resolve / lyric / download / tag / sources
 * 的行为测试。
 *
 * 用「咪咕」做受控音源：搜索 JSON、listen-url、播放地址探测、歌词全部由本地路由返回，
 * 因此分页、切片、缓存、并发合并、错误码这些状态机语义可以被精确断言，不依赖外网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as engine from '../../../src/main/engine/ts'
import { remember } from '../../../src/main/engine/ts/cache'
import { toEngineSong } from '../../../src/main/engine/ts'
import type { SongInfo } from '../../../src/main/engine/ts/types'
import { jsonResponse, loadJson, mockFetch, textResponse } from './helpers'

const parity = loadJson<Record<string, unknown>>('parity.json')

interface MiguOptions {
  count?: number
  failSearch?: boolean
  hangSearch?: boolean
}

function installMigu(options: MiguOptions = {}) {
  const count = options.count ?? 3
  const items = Array.from({ length: count }, (_unused, index) => ({
    contentId: `id${index}`,
    copyrightId: `cr${index}`,
    name: `Song ${index}`,
    singers: [{ name: 'Singer' }],
    albums: [{ name: 'Album' }],
    imgItems: [{ img: '/cover.jpg' }],
    rateFormats: [{ formatType: 'PQ', resourceType: 'E', size: '3.0MB' }],
    lyricUrl: `https://lrc.test/${index}.lrc`
  }))

  const mock = mockFetch((url) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/v1.0/content/search_all.do') {
      if (options.hangSearch) return new Promise<Response>(() => undefined)
      if (options.failSearch) return textResponse('upstream error', 500)
      const page = Number(parsed.searchParams.get('pageNo') ?? '1')
      const pageSize = Number(parsed.searchParams.get('pageSize') ?? '3')
      const start = (page - 1) * pageSize
      return jsonResponse({ songResultData: { result: items.slice(start, start + pageSize) } })
    }
    if (parsed.pathname === '/strategy/listen-url/h5/v2.4') {
      const contentId = parsed.searchParams.get('contentId') ?? ''
      return jsonResponse({
        data: {
          url: `https://cdn.test/${contentId}.mp3`,
          song: { duration: 223 }
        }
      })
    }
    if (parsed.hostname === 'cdn.test') {
      return new Response(new Uint8Array(0), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': '123456' }
      })
    }
    if (parsed.hostname === 'lrc.test') {
      return textResponse('[00:01.00]第一行\n[00:02.00]第二行')
    }
    return textResponse('unexpected', 500)
  })
  return mock
}

function fakeSong(overrides: Partial<SongInfo>): SongInfo {
  return {
    source: 'migu',
    identifier: 'fake',
    songName: 'Fake',
    singers: 'Nobody',
    album: 'None',
    ext: 'mp3',
    fileSizeBytes: 1,
    bitrate: 0,
    codec: '',
    durationS: 1,
    coverUrl: '',
    downloadUrl: 'https://cdn.test/fake.mp3',
    headers: {},
    cookies: {},
    protocol: 'HTTP',
    lyric: '',
    ...overrides
  }
}

test('toEngineSong 逐字段归一（含 NULL / 脏数值 / 大小写）', () => {
  const cases = parity.songPayload as Array<{ input: Record<string, unknown>; out: Record<string, unknown> }>
  for (const item of cases) {
    const input = item.input
    const built: SongInfo = {
      source: 'test',
      identifier: input.identifier === null || input.identifier === undefined ? '' : String(input.identifier),
      songName: String(input.song_name ?? ''),
      singers: String(input.singers ?? ''),
      album: String(input.album ?? ''),
      ext: String(input.ext ?? ''),
      fileSizeBytes: input.file_size_bytes as number,
      bitrate: input.bitrate as number,
      codec: String(input.codec ?? ''),
      durationS: input.duration_s as number,
      coverUrl: String(input.cover_url ?? ''),
      downloadUrl: String(input.download_url ?? ''),
      headers: {},
      cookies: {},
      protocol: (input.protocol as 'HTTP' | 'HLS') ?? 'HTTP',
      lyric: String(input.lyric ?? '')
    }
    const payload = { ...toEngineSong(built) } as Record<string, unknown>
    delete payload.token
    assert.deepEqual(payload, item.out, JSON.stringify(input))
  }
})

test('search：字段归一化、分页切片、hasMore 与 cost', async () => {
  engine.reset()
  const mock = installMigu({ count: 6 })
  try {
    const page1 = await engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 3 })
    assert.equal(page1.items.length, 3)
    // 第 1 页只召回 limit 条（want 上限 20），所以 total 就是 3
    assert.equal(page1.total, 3)
    assert.equal(page1.page, 1)
    // page1 的 hasMore 恒为 false，因为 total 不可能超过本次召回量
    assert.equal(page1.hasMore, false)
    assert.equal(typeof page1.cost, 'number')

    const first = page1.items[0]
    assert.deepEqual(
      {
        id: first.id,
        name: first.name,
        singers: first.singers,
        album: first.album,
        ext: first.ext,
        durationMs: first.durationMs,
        sizeBytes: first.sizeBytes,
        protocol: first.protocol,
        hasUrl: first.hasUrl
      },
      {
        id: 'id0',
        name: 'Song 0',
        singers: 'Singer',
        album: 'Album',
        ext: 'mp3',
        durationMs: 223_000,
        sizeBytes: 123_456,
        protocol: 'HTTP',
        hasUrl: true
      }
    )
    assert.match(first.coverUrl, /^https:\/\/d\.musicapp\.migu\.cn\/cover\.jpg$/)
    assert.ok(first.token.length > 0)

    const page2 = await engine.search({ source: 'migu', keyword: 'love', page: 2, limit: 3 })
    assert.deepEqual(
      page2.items.map((item) => item.id),
      ['id3', 'id4', 'id5']
    )
    assert.equal(page2.hasMore, false, '第 2 页之后不再宣称有下一页')
  } finally {
    mock.restore()
  }
})

test('search：limit 上限 10，超出后按 10 条召回', async () => {
  engine.reset()
  const mock = installMigu({ count: 6 })
  try {
    const page = await engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 99 })
    assert.equal(page.items.length, 6)
    assert.equal(page.hasMore, false)
  } finally {
    mock.restore()
  }
})

test('search：空关键词直接返回空结果，不打任何接口', async () => {
  engine.reset()
  const mock = installMigu()
  try {
    const page = await engine.search({ source: 'migu', keyword: '   ', page: 1, limit: 3 })
    assert.deepEqual(page, { items: [], total: 0, page: 1, hasMore: false })
    assert.equal(mock.calls.length, 0)
  } finally {
    mock.restore()
  }
})

test('search：未知音源返回 unsupported', async () => {
  engine.reset()
  await assert.rejects(engine.search({ source: 'nope', keyword: 'x' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'unsupported')
    return true
  })
})

test('search：180 秒内命中缓存，不重复请求平台', async () => {
  engine.reset()
  const mock = installMigu({ count: 3 })
  try {
    const first = await engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 3 })
    const searchCalls = mock.calls.filter((call) => call.url.includes('search_all.do')).length
    const second = await engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 3 })
    const after = mock.calls.filter((call) => call.url.includes('search_all.do')).length
    assert.equal(after, searchCalls)
    assert.equal(second, first, '缓存命中应返回同一个结果对象')
  } finally {
    mock.restore()
  }
})

test('search：同一关键词并发只打一次平台接口', async () => {
  engine.reset()
  const mock = installMigu({ count: 3 })
  try {
    await Promise.all([
      engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 3 }),
      engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 3 })
    ])
    const searchCalls = mock.calls.filter((call) => call.url.includes('search_all.do')).length
    assert.equal(searchCalls, 1)
  } finally {
    mock.restore()
  }
})

test('search：流式回调逐首推送、按 id 去重', async () => {
  engine.reset()
  const mock = installMigu({ count: 3 })
  try {
    const batches: string[][] = []
    const result = await engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 3 }, (items) => {
      batches.push(items.map((item) => item.id))
    })
    assert.equal(batches.length, 3, '三条结果应推送三次（逐首推送，不是按页批量）')
    assert.deepEqual(batches.flat(), ['id0', 'id1', 'id2'])
    assert.equal(new Set(batches.flat()).size, 3)
    assert.equal(result.items.length, 3)
  } finally {
    mock.restore()
  }
})

test('search：平台全失败且无结果时报 blocked，而不是空列表', async () => {
  engine.reset()
  const mock = installMigu({ failSearch: true })
  try {
    await assert.rejects(engine.search({ source: 'migu', keyword: 'love' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'blocked')
      assert.match((error as Error).message, /请求失败/)
      return true
    })
  } finally {
    mock.restore()
  }
})

test('search：超时返回 timeout 错误码', async (t) => {
  engine.reset()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const mock = installMigu({ hangSearch: true })
  try {
    const pending = engine.search({ source: 'migu', keyword: 'love' })
    t.mock.timers.tick(45_000)
    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'timeout')
      assert.match((error as Error).message, /超时/)
      return true
    })
  } finally {
    mock.restore()
    t.mock.timers.reset()
  }
})

test('resolve：token 快路径不重新搜索，返回完整播放信息', async () => {
  engine.reset()
  const mock = installMigu({ count: 2 })
  try {
    const page = await engine.search({ source: 'migu', keyword: 'love', page: 1, limit: 2 })
    const before = mock.calls.length
    const resolved = await engine.resolve({ source: 'migu', token: page.items[0].token })
    assert.equal(resolved.url, 'https://cdn.test/id0.mp3')
    assert.equal(resolved.ext, 'mp3')
    assert.equal(resolved.size, 123_456)
    assert.equal(resolved.protocol, 'HTTP')
    assert.equal(resolved.token, page.items[0].token)
    assert.match(resolved.lyric, /第一行/)
    assert.match(resolved.coverUrl, /cover\.jpg$/)
    // 播放地址必须带上音源要求的请求头（咪咕只要求 UA），否则 CDN 会 403
    assert.match(resolved.headers['User-Agent'] ?? '', /Mozilla\/5\.0/)
    assert.deepEqual(resolved.cookies, {})
    assert.equal(mock.calls.length, before, 'token 命中时不应再发请求')
  } finally {
    mock.restore()
  }
})

test('resolve：token 失效后按「歌名 + 歌手 + 时长」重定位', async () => {
  engine.reset()
  const mock = installMigu({ count: 6 })
  try {
    const resolved = await engine.resolve({
      source: 'migu',
      name: 'Song 3',
      artists: 'Singer',
      durationMs: 223_000
    })
    assert.equal(resolved.url, 'https://cdn.test/id3.mp3')
  } finally {
    mock.restore()
  }
})

test('resolve：找不到时报 notfound，缺参数时报 invalid', async () => {
  engine.reset()
  const mock = installMigu({ count: 2 })
  try {
    await assert.rejects(engine.resolve({ source: 'migu', name: '不存在的歌' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'notfound')
      return true
    })
    await assert.rejects(engine.resolve({ source: 'migu' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'invalid')
      return true
    })
  } finally {
    mock.restore()
  }
})

test('resolve：没有播放地址时报 blocked', async () => {
  engine.reset()
  const song = fakeSong({ downloadUrl: '' })
  const token = remember(song)
  await assert.rejects(engine.resolve({ source: 'migu', token }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'blocked')
    return true
  })
})

test('resolve：加密流（非 http 地址）报 unsupported，与 blocked 区分', async () => {
  engine.reset()
  const song = fakeSong({ downloadUrl: 'magnet:?xt=urn:btih:abc' })
  const token = remember(song)
  await assert.rejects(engine.resolve({ source: 'migu', token }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'unsupported')
    return true
  })
})

test('lyric：返回歌词与音源中文名（拿不到时为空串，不抛错）', async () => {
  engine.reset()
  const mock = installMigu({ count: 1 })
  try {
    const page = await engine.search({ source: 'migu', keyword: 'love', limit: 1 })
    const result = await engine.lyric({ source: 'migu', token: page.items[0].token })
    assert.equal(result.source, '咪咕音乐')
    assert.match(result.lyric, /第一行/)

    const empty = fakeSong({ lyric: '' })
    const emptyToken = remember(empty)
    const fallback = await engine.lyric({ source: 'migu', token: emptyToken })
    assert.deepEqual(fallback, { lyric: '', source: '咪咕音乐' })
  } finally {
    mock.restore()
  }
})

test('download：缺目标路径报 invalid（HLS 由引擎合并，HTTP 直链不走这里）', async () => {
  engine.reset()
  const mock = installMigu({ count: 1 })
  try {
    const page = await engine.search({ source: 'migu', keyword: 'love', limit: 1 })
    await assert.rejects(
      engine.downloadHlsTo({ source: 'migu', token: page.items[0].token, path: '' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'invalid')
        return true
      }
    )
  } finally {
    mock.restore()
  }
})

test('download：没有播放地址时报 blocked', async () => {
  engine.reset()
  const song = fakeSong({ downloadUrl: '' })
  const token = remember(song)
  await assert.rejects(
    engine.downloadHlsTo({ source: 'migu', token, path: 'Z:/tmp/x.ts' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'blocked')
      return true
    }
  )
})

test('tag：文件不存在报 notfound', async () => {
  await assert.rejects(
    engine.tag({ path: 'Z:/definitely/not/here.mp3', title: 'a', artists: 'b', album: 'c' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'notfound')
      return true
    }
  )
})

test('sources / ping：登记 15 个音源且字段完整', () => {
  const list = engine.sources()
  assert.equal(list.length, 15)
  assert.deepEqual(
    list.map((item) => item.key),
    [
      'kugou', 'migu', 'qianqian', 'fivesing', 'bodian', 'streetvoice', 'bilibili',
      'jiosaavn', 'jamendo', 'ccmixter', 'opengameart', 'wikimedia', 'audius', 'fma', 'soundcloud'
    ]
  )
  const labelOf = (key: string): string => list.find((item) => item.key === key)?.label ?? ''
  assert.equal(labelOf('migu'), '咪咕音乐')
  assert.equal(labelOf('fivesing'), '5sing 原创')
  assert.equal(labelOf('soundcloud'), 'SoundCloud')

  const info = engine.ping()
  assert.equal((info.sources as unknown[]).length, 15)
  assert.equal(info.executable, 'node')
})
