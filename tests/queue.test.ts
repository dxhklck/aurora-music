/**
 * 队列重排的纯函数单测。
 *
 * `moveIndex` 算错的后果不是报错，而是「拖一下队列，正在播的变成别的歌」——
 * 播放不会中断，所以现场极难察觉，必须由测试兜住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createUidFactory, moveIndex, moveItem } from '../src/renderer/src/core/queue.ts'

test('uid 工厂会话内递增且不重复', () => {
  const next = createUidFactory()
  const seen = Array.from({ length: 50 }, () => next())
  assert.equal(new Set(seen).size, 50, '50 次必须产生 50 个不同的 uid')
  assert.equal(seen[0], 'q1')
  assert.equal(seen[49], 'q50')
})

test('两个工厂互不影响（不同 store 实例不串号）', () => {
  const a = createUidFactory('a')
  const b = createUidFactory('b')
  assert.equal(a(), 'a1')
  assert.equal(b(), 'b1')
  assert.equal(a(), 'a2')
})

test('moveItem 把元素搬到目标位置', () => {
  const list = ['A', 'B', 'C', 'D']
  assert.deepEqual(moveItem(list, 0, 3), ['B', 'C', 'D', 'A'])
  assert.deepEqual(moveItem(list, 3, 0), ['D', 'A', 'B', 'C'])
  assert.deepEqual(moveItem(list, 1, 2), ['A', 'C', 'B', 'D'])
})

test('moveItem 不修改入参，越界时返回等值副本', () => {
  const list = ['A', 'B', 'C']
  const out = moveItem(list, 0, 9)
  assert.deepEqual(list, ['A', 'B', 'C'], '原数组必须保持不变')
  assert.deepEqual(out, ['A', 'B', 'C'])
  assert.notEqual(out, list, '返回的是新数组')
})

test('moveItem 原地移动返回等值副本', () => {
  const list = ['A', 'B', 'C']
  const out = moveItem(list, 1, 1)
  assert.deepEqual(out, list)
  assert.notEqual(out, list)
})

test('moveIndex：拖动当前正在播的那一首，下标跟着走', () => {
  // [A,B,C,D] 正在播 C(index 2)，把它拖到末尾
  assert.equal(moveIndex(2, 2, 3), 3)
  // 拖到最前
  assert.equal(moveIndex(2, 2, 0), 0)
})

test('moveIndex：把前面的项拖到当前项之后，当前下标减一', () => {
  // [A,B,C,D] 播 C(2)，把 A(0) 拖到末尾 → [B,C,D,A]，C 变成 1
  assert.equal(moveIndex(2, 0, 3), 1)
  // 拖到 C 当前位置之前一格 → [B,A,C,D]，C 仍是 2
  assert.equal(moveIndex(2, 0, 1), 2)
})

test('moveIndex：把后面的项拖到当前项之前，当前下标加一', () => {
  // [A,B,C,D] 播 C(2)，把 D(3) 拖到位置 1 → [A,D,B,C]，C 变成 3
  assert.equal(moveIndex(2, 3, 1), 3)
  // 拖到紧挨着 C 的前面 → [A,B,D,C]，C 变成 3
  assert.equal(moveIndex(2, 3, 2), 3)
})

test('moveIndex：改动不跨越当前项时下标不变', () => {
  // 播 C(2)，在它前面内部互换：A 与 B 换位，C 仍是 2
  assert.equal(moveIndex(2, 0, 1), 2)
  // 在它后面内部互换：C(2) 之后的两项换位
  assert.equal(moveIndex(2, 3, 4), 2)
})

test('moveIndex：原地不动与非法下标原样返回', () => {
  assert.equal(moveIndex(2, 1, 1), 2)
  assert.equal(moveIndex(-1, 0, 3), -1)
})
