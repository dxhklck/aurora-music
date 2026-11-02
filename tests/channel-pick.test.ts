import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickChannel } from '../src/main/update-logic.ts'

test('主源已同步：第一个渠道命中，不多探', () => {
  const decision = pickChannel(
    [
      { id: 'gitcode', version: '1.3.12' },
      { id: 'github', version: '1.3.12' }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: 0, reason: 'same' })
})

test('主源落后、备用源已同步：顺延到备用源', () => {
  const decision = pickChannel(
    [
      { id: 'gitcode', version: '1.3.11' },
      { id: 'github', version: '1.3.12' }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: 1, reason: 'same' })
})

test('主源落后、备用源有新版：顺延并报「有新版」', () => {
  const decision = pickChannel(
    [
      { id: 'gitcode', version: '1.3.11' },
      { id: 'github', version: '1.3.13' }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: 1, reason: 'newer' })
})

test('主源抛错（版本为 null）：顺延到能拿到的那个', () => {
  const decision = pickChannel(
    [
      { id: 'gitcode', version: null },
      { id: 'github', version: '1.3.12' }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: 1, reason: 'same' })
})

test('渠道顺序优先于版本高低：后面的源版本更高也不抢前面的', () => {
  // 主源已同步就停在这里——它足够回答「有没有新版」，没必要为了一个更高版本号
  // 去跨洋请求（那个更高版本可能是别的渠道上的预发布）。
  const decision = pickChannel(
    [
      { id: 'gitcode', version: '1.3.12' },
      { id: 'github', version: '1.4.0' }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: 0, reason: 'same' })
})

test('全部落后（本地构建 / 刚回滚）：取版本最高者兜底', () => {
  const decision = pickChannel(
    [
      { id: 'gitcode', version: '1.2.0' },
      { id: 'github', version: '1.3.0' },
      { id: 'mirror', version: '1.3.11' }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: 2, reason: 'stale' })
})

test('全部不可达：返回 -1，由调用方报「所有渠道均不可达」', () => {
  const decision = pickChannel(
    [
      { id: 'gitcode', version: null },
      { id: 'github', version: null }
    ],
    '1.3.12'
  )
  assert.deepEqual(decision, { index: -1, reason: 'none' })
})

test('空探测列表不炸', () => {
  assert.deepEqual(pickChannel([], '1.3.12'), { index: -1, reason: 'none' })
})
