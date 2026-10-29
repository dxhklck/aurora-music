/**
 * 竞态门闩单测。
 *
 * 覆盖的是「后发的请求先回来」这类时序：它不报错，只会让用户看到错的内容
 * （播错歌、列表与关键词对不上），所以必须由测试兜住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLatestGate } from '../src/renderer/src/core/latest.ts'

test('只有最新领的号算数', () => {
  const gate = createLatestGate()
  const first = gate.next()
  assert.equal(gate.isCurrent(first), true)
  const second = gate.next()
  assert.equal(gate.isCurrent(first), false)
  assert.equal(gate.isCurrent(second), true)
})

test('后发先回：先领号的请求完成时必须被判为过期', () => {
  const gate = createLatestGate()
  const slow = gate.next() // 用户点的第一首，取址很慢
  const fast = gate.next() // 用户又点了第二首，很快就回来了
  assert.equal(gate.isCurrent(fast), true, '后发的请求应当生效')
  assert.equal(gate.isCurrent(slow), false, '先发的请求晚到时必须丢弃')
})

test('invalidate 让所有在途请求失效', () => {
  const gate = createLatestGate()
  const token = gate.next()
  gate.invalidate()
  assert.equal(gate.isCurrent(token), false)
  // 作废后再领号，仍然从新的基准继续
  const next = gate.next()
  assert.equal(gate.isCurrent(next), true)
})

test('current 只读取不领号（翻页跟随当前请求用）', () => {
  const gate = createLatestGate()
  const token = gate.next()
  assert.equal(gate.current(), token)
  assert.equal(gate.current(), token)
  // 读取没有让号前进，所以原请求仍然有效
  assert.equal(gate.isCurrent(token), true)
})
