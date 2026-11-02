/**
 * 收听报告的聚合规则。
 *
 * 这里的坑几乎全在日期上：本地日期 vs UTC、跨月、跨年、补零、
 * 「今天还没听不算断签」。这些算错不会抛异常，只会让报告数字莫名其妙。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  activeDays,
  dayKey,
  formatListenTime,
  lastDays,
  listenStreak,
  platformBreakdown,
  topSongs
} from '../src/renderer/src/views/stats/aggregate.ts'
import type { Song } from '../src/shared/types.ts'

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: 'a',
    platform: 'netease',
    name: '歌',
    artists: ['歌手'],
    album: '',
    coverUrl: null,
    duration: 200_000,
    ...overrides
  } as Song
}

const stat = (count: number, lastAt: number, s = song()) => ({ count, lastAt, song: s })

test('日期键用本地时区，且补零', () => {
  assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05')
  assert.equal(dayKey(new Date(2026, 11, 31)), '2026-12-31')
})

test('最近 N 天按升序、结尾是今天', () => {
  const today = new Date(2026, 10, 2)
  const points = lastDays({ '2026-11-02': 60_000 }, 3, today)
  assert.deepEqual(
    points.map((item) => item.key),
    ['2026-10-31', '2026-11-01', '2026-11-02']
  )
  assert.equal(points[2].ms, 60_000)
  assert.equal(points[0].ms, 0)
})

test('跨月与跨年都正确（含闰年 2 月）', () => {
  const points = lastDays({}, 4, new Date(2024, 2, 1)) // 2024-03-01，闰年
  assert.deepEqual(
    points.map((item) => item.key),
    ['2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01']
  )
})

test('热力图分列：每 7 天进下一周', () => {
  const points = lastDays({}, 14, new Date(2026, 10, 2))
  assert.equal(points[0].week, 0)
  assert.equal(points[6].week, 0)
  assert.equal(points[7].week, 1)
  assert.equal(points[13].week, 1)
})

test('Top N 只统计窗口内，并按次数排序', () => {
  const now = new Date(2026, 10, 2).getTime()
  const songs = {
    a: stat(5, now - 1000, song({ id: 'a' })),
    b: stat(9, now - 2 * 24 * 3600_000, song({ id: 'b' })),
    old: stat(50, now - 40 * 24 * 3600_000, song({ id: 'old' }))
  }
  const top = topSongs(songs, 2, 7, now)
  assert.deepEqual(
    top.map((item) => item.song.id),
    ['b', 'a']
  )
})

test('Top N 的次数相同时，最近听过的靠前', () => {
  const now = new Date(2026, 10, 2).getTime()
  const songs = {
    a: stat(3, now - 5000, song({ id: 'a' })),
    b: stat(3, now - 1000, song({ id: 'b' }))
  }
  assert.deepEqual(
    topSongs(songs, 5, 7, now).map((item) => item.song.id),
    ['b', 'a']
  )
})

test('来源分布按次数汇总并降序', () => {
  const songs = {
    a: stat(2, 0, song({ platform: 'netease' })),
    b: stat(3, 0, song({ platform: 'qq' })),
    c: stat(1, 0, song({ platform: 'netease' }))
  }
  assert.deepEqual(platformBreakdown(songs), [
    { platform: 'netease', count: 3 },
    { platform: 'qq', count: 3 }
  ])
})

test('活跃天数只数有收听的日子', () => {
  assert.equal(activeDays({ '2026-11-01': 0, '2026-11-02': 1000 }), 1)
})

test('连续天数：今天没听时从昨天数起，不算断', () => {
  const today = new Date(2026, 10, 2)
  const days = { '2026-11-01': 1000, '2026-10-31': 1000, '2026-10-29': 1000 }
  assert.equal(listenStreak(days, today), 2)
})

test('连续天数：今天听了就把今天算进去', () => {
  const today = new Date(2026, 10, 2)
  const days = { '2026-11-02': 1000, '2026-11-01': 1000 }
  assert.equal(listenStreak(days, today), 2)
})

test('连续天数：断档处停下', () => {
  const today = new Date(2026, 10, 2)
  const days = { '2026-11-02': 1000, '2026-10-31': 1000 }
  assert.equal(listenStreak(days, today), 1)
})

test('时长格式化', () => {
  assert.equal(formatListenTime(30_000), '不到 1 分钟')
  assert.equal(formatListenTime(90_000), '1 分钟')
  assert.equal(formatListenTime(3 * 3600_000 + 20 * 60_000), '3 小时 20 分钟')
  assert.equal(formatListenTime(2 * 3600_000), '2 小时')
})
