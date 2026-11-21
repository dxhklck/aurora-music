/**
 * 单曲音源失败记录的纯逻辑。
 * 只保留网络/解析错误，且每个上限有界，避免把「VIP 没版权」当成整个平台坏了。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Song } from '../src/shared/types.ts'
import {
  clearFailures,
  recordFailure,
  recordUnknownFailure,
  snapshotFailures
} from '../src/main/services/source-failures.ts'

const song: Song = {
  id: 's1',
  platform: 'netease',
  name: '测试歌曲',
  artists: ['测试歌手'],
  album: '',
  coverUrl: null,
  duration: 1000
}

test('仅记录传输/解析类失败，按平台覆盖去重', () => {
  clearFailures()
  recordFailure(song, 'blocked', 'VIP', 'netease', 10)
  assert.equal(snapshotFailures().items.length, 0)

  recordFailure(song, 'network', '超时', 'netease', 20)
  recordFailure(song, 'parse', '解析失败', 'netease', 30)
  const items = snapshotFailures().items
  assert.equal(items.length, 2)
  assert.equal(items[0].code, 'parse')
  assert.deepEqual(items[0].artists, ['测试歌手'])
})

test('每首歌最多三条，总量有上限', () => {
  clearFailures()
  for (let i = 0; i < 8; i += 1) {
    recordFailure(song, i % 2 ? 'network' : 'parse', `失败 ${i}`, `src-${i}`, i)
  }
  assert.equal(snapshotFailures().items.length, 3)
})

test('渲染层传来的错误只取结构化字段', () => {
  clearFailures()
  recordUnknownFailure(song, { code: 'network', provider: 'qq', message: '请求失败' })
  const item = snapshotFailures().items[0]
  assert.equal(item.platform, 'qq')
  assert.equal(item.code, 'network')
  assert.equal(item.message, '请求失败')
})
