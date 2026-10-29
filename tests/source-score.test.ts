/**
 * 换源调度评分单测。
 *
 * 这段逻辑决定「先试哪个源」，错了不会报错，只会让播放变慢或换源失败，
 * 所以边界比公式本身更重要：样本不足、恢复、窗口滚动。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceScoreboard } from '../src/main/services/source-score.ts'

test('样本不足时给中性分，不拿一两次运气排序', () => {
  const board = new SourceScoreboard()
  assert.equal(board.score('a'), 0.5, '没有样本应当是中性分')
  board.record('a', 100, true)
  board.record('a', 100, true)
  assert.equal(board.score('a'), 0.5, '不足 3 条仍是中性分')
  board.record('a', 100, true)
  assert.ok(board.score('a') > 0.5, '满 3 条后按实测算分')
})

test('又快又稳的源分数高于又慢又失败的源', () => {
  const board = new SourceScoreboard()
  for (let i = 0; i < 5; i += 1) board.record('fast', 400, true)
  for (let i = 0; i < 5; i += 1) board.record('slow', 9000, false)
  assert.ok(board.score('fast') > board.score('slow'))
  assert.equal(board.score('slow'), 0, '全失败应当是 0 分')
})

test('成功但很慢的源，分数低于成功且快的源', () => {
  const board = new SourceScoreboard()
  for (let i = 0; i < 5; i += 1) board.record('quick', 300, true)
  for (let i = 0; i < 5; i += 1) board.record('lethargic', 8000, true)
  assert.ok(board.score('quick') > board.score('lethargic'))
})

test('滑动窗口只保留最近 N 条，坏记录会被挤出去', () => {
  const board = new SourceScoreboard(5)
  for (let i = 0; i < 5; i += 1) board.record('src', 20_000, false)
  assert.equal(board.score('src'), 0)
  // 之后连续成功 5 次，早先的失败样本应当全部滚出窗口
  for (let i = 0; i < 5; i += 1) board.record('src', 500, true)
  assert.equal(board.samples('src'), 5)
  assert.ok(board.score('src') > 1, '恢复后分数要能自己爬回来')
})

test('p50 取中位数，不受单次极值牵动', () => {
  const board = new SourceScoreboard()
  board.record('src', 100, true)
  board.record('src', 200, true)
  board.record('src', 60_000, true)
  assert.equal(board.p50('src'), 200, '一次 60s 卡顿不该把中位耗时拖到分钟级')
  assert.equal(board.p50('unknown'), null)
})
