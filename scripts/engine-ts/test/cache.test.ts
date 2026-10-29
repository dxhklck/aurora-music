/**
 * 状态管理：token 缓存、搜索结果缓存（TTL / 容量淘汰）、同 key 并发合并、
 * 以及稳定 id 与模糊匹配这两个「跨重启仍然要正确」的算法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearCaches,
  dropToken,
  pickBest,
  readSearchCache,
  recall,
  remember,
  stableId,
  withSearchLock,
  writeSearchCache
} from '../../../src/main/engine/ts/cache'
import type { SongInfo } from '../../../src/main/engine/ts/types'
import { loadJson } from './helpers'

interface ParityCase {
  input: Record<string, unknown>
  out: unknown
}

const parity = loadJson<Record<string, ParityCase[]>>('parity.json')

function song(overrides: Partial<SongInfo> & Pick<SongInfo, 'songName'>): SongInfo {
  return {
    source: 'test',
    identifier: '',
    singers: '',
    album: '',
    ext: 'mp3',
    fileSizeBytes: 0,
    bitrate: 0,
    codec: '',
    durationS: 0,
    coverUrl: '',
    downloadUrl: '',
    headers: {},
    cookies: {},
    protocol: 'HTTP',
    lyric: '',
    ...overrides
  }
}

test('stableId 在缺 identifier 时用元信息 md5 前 16 位', () => {
  for (const item of parity.stableId) {
    const input = item.input as Record<string, unknown>
    const built = song({
      songName: String(input.song_name ?? ''),
      identifier: input.identifier === null || input.identifier === undefined ? '' : String(input.identifier),
      singers: String(input.singers ?? ''),
      album: String(input.album ?? '')
    })
    assert.equal(stableId(built), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
  // identifier 为纯空白时视作缺失（cleanText 归一），退回 md5
  assert.equal(stableId(song({ songName: 'A', identifier: '  ' })), stableId(song({ songName: 'A' })))
})

test('pickBest 的评分与阈值逐用例符合既定规则', () => {
  for (const raw of parity.pickBest as unknown as Array<{
    target: Record<string, unknown>
    items: Array<Record<string, unknown>>
    bestIndex: number
  }>) {
    const target = raw
    const items = target.items.map((entry, index) =>
      song({
        identifier: String(index),
        songName: String(entry.song_name ?? ''),
        singers: String(entry.singers ?? ''),
        album: String(entry.album ?? ''),
        durationS: Number(entry.duration_s ?? 0)
      })
    )
    const chosen = pickBest(
      {
        name: String(target.target.name ?? ''),
        artists: String(target.target.artists ?? ''),
        durationMs: Number(target.target.durationMs ?? 0)
      },
      items
    )
    assert.equal(chosen ? Number(chosen.identifier) : -1, raw.bestIndex, `target=${JSON.stringify(target.target)}`)
  }
})

test('pickBest 的边界：5000ms 内加分、超过 30000ms 扣分', () => {
  const items = [
    song({ identifier: 'a', songName: '歌', singers: '人', durationS: 100 }),
    song({ identifier: 'b', songName: '歌', singers: '人', durationS: 105 }),
    song({ identifier: 'c', songName: '歌', singers: '人', durationS: 140 })
  ]
  // 100s：完全相同 60 + 歌手 30 + 时长 10 = 100
  assert.equal(pickBest({ name: '歌', artists: '人', durationMs: 100_000 }, items)?.identifier, 'a')
  // 105s 差 5000ms：不满足 <5000，只加 60 + 30
  assert.equal(pickBest({ name: '歌', artists: '人', durationMs: 105_000 }, items)?.identifier, 'b')
  // 目标 140s，b 差 35s 扣分后 75，c 命中 100
  assert.equal(pickBest({ name: '歌', artists: '人', durationMs: 140_000 }, items)?.identifier, 'c')
})

test('remember / recall：同一首歌复用 token，不同歌曲互不影响', () => {
  clearCaches()
  const first = song({ songName: '稻香', singers: '周杰伦', album: '魔杰座', identifier: '1' })
  const second = song({ songName: '晴天', singers: '周杰伦', album: '叶惠美', identifier: '2' })
  const token = remember(first)
  assert.equal(remember(first), token)
  const other = remember(second)
  assert.notEqual(other, token)
  assert.equal(recall(token)?.songName, '稻香')
  assert.equal(recall('not-a-token'), null)
})

test('dropToken 同时清掉 id → token 的反向索引', () => {
  clearCaches()
  const item = song({ songName: 'A', identifier: '9' })
  const token = remember(item)
  dropToken(token)
  assert.equal(recall(token), null)
  // 重新 remember 应该生成新 token（旧映射已删除）
  const again = remember(item)
  assert.notEqual(again, token)
  assert.equal(recall(again)?.identifier, '9')
})

test('搜索缓存 180 秒过期，过期后读不到', (t) => {
  clearCaches()
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  writeSearchCache('k', { items: [1] })
  assert.deepEqual(readSearchCache('k'), { items: [1] })
  t.mock.timers.tick(179_999)
  assert.deepEqual(readSearchCache('k'), { items: [1] })
  t.mock.timers.tick(1)
  assert.equal(readSearchCache('k'), null)
  clearCaches()
})

test('搜索缓存超过 200 条时淘汰最旧的一条', (t) => {
  clearCaches()
  t.mock.timers.enable({ apis: ['Date'], now: 2_000_000 })
  for (let index = 0; index <= 200; index += 1) {
    writeSearchCache(`key-${index}`, index)
    t.mock.timers.tick(1)
  }
  assert.equal(readSearchCache('key-0'), null, '最旧的一条应被淘汰')
  assert.equal(readSearchCache('key-1'), 1)
  assert.equal(readSearchCache('key-200'), 200)
  clearCaches()
})

test('同 key 并发请求合并：只执行一次，双方拿到同一结果', async () => {
  clearCaches()
  let runs = 0
  const first = withSearchLock('same', async () => {
    runs += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { value: 1 }
  })
  const second = withSearchLock('same', async () => {
    runs += 1
    return { value: 2 }
  })
  const [a, b] = await Promise.all([first, second])
  assert.equal(runs, 1)
  assert.equal(a, b)
  assert.deepEqual(a, { value: 1 })
  // 完成后锁释放，下一次会真正执行
  const third = await withSearchLock('same', async () => {
    runs += 1
    return { value: 3 }
  })
  assert.deepEqual(third, { value: 3 })
  assert.equal(runs, 2)
  clearCaches()
})

test('任务失败时锁必须释放，不能让后续请求一直拿到同一个失败', async () => {
  clearCaches()
  await assert.rejects(withSearchLock('bad', async () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal(await withSearchLock('bad', async () => 42), 42)
  clearCaches()
})

test('不同 key 的请求互不阻塞', async () => {
  clearCaches()
  const slow = withSearchLock('slow', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    return 'slow'
  })
  const fast = withSearchLock('fast', async () => 'fast')
  assert.equal(await fast, 'fast')
  assert.equal(await slow, 'slow')
  clearCaches()
})
