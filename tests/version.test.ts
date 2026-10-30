/**
 * 自动更新的版本比较单测。
 *
 * 这段逻辑决定「要不要提示用户升级」。判错的方向只有两个，后果都很直接：
 * 该提示不提示（更新源落后时永远不提示），或者提示降级（把旧版本当新版本）。
 * 尤其是 1.3.9 → 1.3.10 这种跨十位的情况，字符串比较会判反，必须锁死。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isNewerVersion } from '../src/main/utils.ts'

test('跨十位要按数字比，不能按字符串比', () => {
  assert.equal(isNewerVersion('1.3.10', '1.3.9'), true)
  assert.equal(isNewerVersion('1.3.9', '1.3.10'), false)
})

test('同版本不算更新', () => {
  assert.equal(isNewerVersion('1.3.9', '1.3.9'), false)
})

test('前缀 v 与缺位的段都能处理', () => {
  assert.equal(isNewerVersion('v1.4.0', '1.3.9'), true)
  assert.equal(isNewerVersion('2.0', '1.9.9'), true)
  assert.equal(isNewerVersion('1.0', '1.0.0'), false)
})

test('更新源落后时不提示降级', () => {
  // GitCode 还停在 1.3.9、本机已经是 1.3.10 的情形
  assert.equal(isNewerVersion('1.3.9', '1.3.10'), false)
  assert.equal(isNewerVersion('1.2.0', '1.3.9'), false)
})

test('预发布后缀按同版本处理（本项目不发预发布）', () => {
  assert.equal(isNewerVersion('1.3.9-beta.1', '1.3.9'), false)
})

test('空值与垃圾输入不会误判成更新', () => {
  assert.equal(isNewerVersion('', '1.0.0'), false)
  assert.equal(isNewerVersion('abc', '1.0.0'), false)
})
