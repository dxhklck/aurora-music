/**
 * 音源解析回放测试。
 *
 * fixtures/sources/*.json 是 2026-10-29 用 `fixtures/record-sources.ts` 录下的真实响应。
 * 回放时按 pathname + 稳定 query 匹配，因此可以在不联网的前提下验证：
 * 每个音源的 URL 构造、分页、字段归一化、去重与排序是否仍与录制时一致。
 *
 * bodian 不在回放范围内：它的官方取址链路要求「GET + body」，走 node:https 原生请求，
 * 无法被 fetch 录制。该链路由在线对拍覆盖（见 docs/engine-ts-parity-report.md）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSource, SOURCE_META } from '../../../src/main/engine/ts/sources'
import { loadJson, replayFixture, type ReplayFixture } from './helpers'

function normalize(item: {
  identifier: string
  songName: string
  singers: string
  album: string
  ext: string
  durationS: number
  protocol: string
  lyric: string
  coverUrl: string
  downloadUrl: string
}): Record<string, unknown> {
  const host = (value: string): string => {
    try {
      return new URL(value).host
    } catch {
      return ''
    }
  }
  return {
    id: item.identifier,
    name: item.songName,
    singers: item.singers,
    album: item.album,
    ext: item.ext,
    durationS: item.durationS,
    protocol: item.protocol,
    hasLyric: Boolean(item.lyric),
    coverHost: host(item.coverUrl),
    urlHost: host(item.downloadUrl)
  }
}

const SKIP = new Set(['bodian'])
/**
 * B 站的播放地址带签名与 deadline，回放时源会重新拼一次 URL，和录制时不完全相同；
 * 条目字段仍逐项比对，只放宽「不得有未录制请求」这一条。
 */
const ALLOW_MISSING = new Set(['bilibili'])

for (const meta of SOURCE_META) {
  if (SKIP.has(meta.key)) continue
  test(`音源回放：${meta.key} 与录制结果逐字段一致`, async () => {
    const fixture = loadJson<ReplayFixture>(`sources/${meta.key}.json`)
    const replay = replayFixture(fixture)
    try {
      const client = createSource(meta.key)
      assert.ok(client)
      const items = await client.search({ keyword: fixture.keyword, size: fixture.size })
      assert.deepEqual(items.map(normalize), fixture.items)
      if (fixture.items.length > 0 && !ALLOW_MISSING.has(meta.key)) {
        assert.equal(replay.missing.length, 0, `有未录制的请求：${replay.missing.slice(0, 3).join(', ')}`)
      }
      for (const item of items) {
        assert.ok(item.songName.length > 0, `${meta.key} 返回了空歌名`)
        assert.ok(item.downloadUrl.startsWith('http'), `${meta.key} 返回了不可播放地址`)
        assert.ok(item.ext.length > 0, `${meta.key} 缺少扩展名`)
      }
    } finally {
      replay.restore()
    }
  })
}

test('音源回放：录制样本覆盖 15 个源中的 13 个可用源', () => {
  const summary = loadJson<Array<{ source: string; items: number; requests: number; note: string }>>('sources/index.json')
  assert.equal(summary.length, 15)
  const withItems = summary.filter((row) => row.items > 0)
  assert.equal(withItems.length, 13)
  // 维基共享在本机网络不可达，SoundCloud 无 Widevine 等价实现，两者均 0 条——
  // 这是环境/能力边界，不是解析器回归。
  assert.deepEqual(
    summary.filter((row) => row.items === 0).map((row) => row.source).sort(),
    ['soundcloud', 'wikimedia']
  )
})
