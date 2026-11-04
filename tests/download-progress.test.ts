/**
 * 任务栏下载进度单测。
 *
 * 这段逻辑只在「任务栏上那根进度条」里可见，写错不会让任何第地方报错，
 * 只会让用户盯着一条不动的进度条怀疑下载卡死了。三个边界必须锁死：
 * 空队列（清掉进度条）、只在排队（不确定态）、总量未知（不确定态）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { DownloadTask } from '../src/shared/types.ts'
import { taskbarProgress } from '../src/shared/download-progress.ts'

function task(
  id: string,
  status: DownloadTask['status'],
  received: number,
  total: number
): DownloadTask {
  return {
    id,
    song: {
      id: `song-${id}`,
      platform: 'netease',
      name: '测试曲目',
      artists: [],
      album: '',
      coverUrl: null,
      duration: 0
    },
    status,
    progress: total > 0 ? received / total : -1,
    received,
    total,
    speed: 0,
    attempt: 1,
    createdAt: 0
  }
}

test('没有任务时清除进度条', () => {
  assert.equal(taskbarProgress([]), -1)
})

test('只有已结束的任务时也清除进度条', () => {
  assert.equal(taskbarProgress([task('a', 'done', 100, 100)]), -1)
  assert.equal(taskbarProgress([task('a', 'failed', 0, 100)]), -1)
})

test('只在排队时进入不确定态', () => {
  assert.equal(taskbarProgress([task('a', 'queued', 0, 100)]), 2)
})

test('按字节加权，而不是各自百分比取平均', () => {
  // 3 MB 已完成 + 60 MB 未开始：平均百分比会给出 50%，加权后应是 4.8%
  const tasks = [task('small', 'downloading', 3_000_000, 3_000_000), task('big', 'downloading', 0, 60_000_000)]
  const value = taskbarProgress(tasks)
  assert.ok(Math.abs(value - 3 / 63) < 1e-9, `期望 3/63，实际 ${value}`)
})

test('总量未知的任务不参与加权，也不把进度算成 0', () => {
  const tasks = [task('known', 'downloading', 50, 100), task('unknown', 'downloading', 5000, 0)]
  assert.equal(taskbarProgress(tasks), 0.5)
})

test('全部任务总量未知时退回不确定态', () => {
  assert.equal(taskbarProgress([task('a', 'downloading', 123, 0)]), 2)
})

test('服务端多报字节时不越过 100%', () => {
  assert.equal(taskbarProgress([task('a', 'downloading', 120, 100)]), 1)
})

test('已结束的任务不参与加权', () => {
  const tasks = [task('done', 'done', 100, 100), task('active', 'downloading', 25, 100)]
  assert.equal(taskbarProgress(tasks), 0.25)
})
