/**
 * 换源匹配打分的单测。
 *
 * 这套分数决定「自动换源换到的是不是同一首歌」，阈值 70 是唯一的一道闸。
 * 算错不会报错，只会让用户听到另一首歌——所以每个档位都要钉住。
 * 下面的期望值都是按 match.ts 的算式实测出来的，不是估的。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dedupeAlternatives, normalize, rankMatches } from '../src/main/services/match.ts'
import type { AlternativeTrack, Song } from '../src/shared/types.ts'

function song(patch: Partial<Song> = {}): Song {
  return {
    id: 'x',
    platform: 'netease',
    name: '晴天',
    artists: ['周杰伦'],
    album: '叶惠美',
    coverUrl: null,
    duration: 269_000,
    ...patch
  }
}

test('normalize：大小写、空格、括号、标点都不参与比较', () => {
  assert.equal(normalize('晴天（Live）'), normalize('晴天live'))
  assert.equal(normalize('Hello, World!'), normalize('helloworld'))
  assert.equal(normalize('A - B'), normalize('ab'))
  // 书名号目前不在归一化范围内，保持现状（歌名里少见，改了会动到已跑通的换源行为）
  assert.notEqual(normalize('《晴天》'), normalize('晴天'))
})

test('同名 + 同歌手 + 时长接近 = 100', () => {
  const ranked = rankMatches(song(), [song({ platform: 'qq', duration: 270_000 })])
  assert.equal(ranked[0].score, 100)
})

test('同名 + 同歌手，时长差 30 秒以上扣 15 分', () => {
  // 269s vs 310s，差 41 秒：60 + 30 - 15 = 75，仍在阈值之上
  const ranked = rankMatches(song(), [song({ platform: 'qq', duration: 310_000 })])
  assert.equal(ranked[0].score, 75)
})

test('只有同名、歌手不同、时长差 20 秒：60 分，判为不匹配', () => {
  // 60 分是「同名但歌手不同」的原始分；时长差在 5–30 秒之间不加不扣
  const ranked = rankMatches(song(), [
    song({ platform: 'qq', artists: ['某翻唱歌手'], duration: 289_000 })
  ])
  assert.equal(ranked[0].score, 60)
  assert.ok(ranked[0].score < 70)
})

test('只有同名、歌手不同、时长还差 41 秒：45 分，双重扣分', () => {
  // 60 - 15。这一档专门钉住「翻唱 + 时长也对不上」不会被误判成原唱
  const ranked = rankMatches(song(), [
    song({ platform: 'qq', artists: ['某翻唱歌手'], duration: 310_000 })
  ])
  assert.equal(ranked[0].score, 45)
})

test('同名 + 歌手不同但时长接近：正好 70，会被当作同一首', () => {
  // 有意留的口子：部分平台歌手字段缺失或写法完全不同，靠时长兜底
  const ranked = rankMatches(song(), [
    song({ platform: 'qq', artists: ['未知'], duration: 268_000 })
  ])
  assert.equal(ranked[0].score, 70)
})

test('名字包含 + 同歌手 + 时长接近：75 分，会通过阈值', () => {
  // 「晴天 Live」这种情况：名字不是完全相同，但时长对得上，判为同一内容
  const ranked = rankMatches(song(), [song({ platform: 'qq', name: '晴天 Live' })])
  assert.equal(ranked[0].score, 75)
  assert.ok(ranked[0].score >= 70)
})

test('名字包含 + 同歌手 + 时长差 20 秒：65 分，判为不匹配', () => {
  // 35 + 30 = 65，时长差在 5–30 秒之间既不扣也不加
  const ranked = rankMatches(song(), [
    song({ platform: 'qq', name: '晴天 Live', duration: 289_000 })
  ])
  assert.equal(ranked[0].score, 65)
  assert.ok(ranked[0].score < 70)
})

test('名字完全不沾边的候选不进入结果', () => {
  const ranked = rankMatches(song(), [
    song({ platform: 'qq', name: '完全不同的歌' }),
    song({ platform: 'kuwo', name: '晴天' })
  ])
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0].song.name, '晴天')
})

test('结果按分数从高到低排，最高分在最前', () => {
  const ranked = rankMatches(song(), [
    song({ platform: 'a', name: '晴天 Live', duration: 269_000 }), // 75
    song({ platform: 'b', name: '晴天', duration: 269_000 }), // 100
    song({ platform: 'c', name: '晴天', artists: ['别人'], duration: 269_000 }) // 70
  ])
  assert.deepEqual(
    ranked.map((item) => item.song.platform),
    ['b', 'a', 'c']
  )
  assert.deepEqual(
    ranked.map((item) => item.score),
    [100, 75, 70]
  )
})

test('目标没有时长时，不因为缺失而扣分', () => {
  const ranked = rankMatches(song({ duration: 0 }), [song({ platform: 'qq' })])
  assert.equal(ranked[0].score, 90, '缺时长只是拿不到那 10 分，不该反过来扣')
})

test('歌手名互相包含也算同歌手（「周杰伦」与「周杰伦 Jay Chou」）', () => {
  const ranked = rankMatches(song(), [song({ platform: 'qq', artists: ['周杰伦 Jay Chou'] })])
  assert.equal(ranked[0].score, 100)
})

function alt(platform: string, id: string, score: number): AlternativeTrack {
  return { song: song({ platform, id }), score, platformName: platform }
}

test('候选去重按 platform:id，保留先出现的（分数更高的那个）', () => {
  const result = dedupeAlternatives([
    alt('qq', 'a', 100),
    alt('qq', 'a', 60),
    alt('kuwo', 'a', 90)
  ])
  assert.equal(result.length, 2)
  assert.deepEqual(
    result.map((item) => `${item.song.platform}:${item.song.id}:${item.score}`),
    ['qq:a:100', 'kuwo:a:90']
  )
})

test('候选截断到 12 条，且保持传入顺序（分数降序）', () => {
  const list = Array.from({ length: 20 }, (_, i) => alt('qq', `id${i}`, 100 - i))
  const result = dedupeAlternatives(list)
  assert.equal(result.length, 12)
  assert.equal(result[0].score, 100)
  assert.equal(result[11].score, 89)
})
