/**
 * 权限判定护栏。
 *
 * 背景：Electron 的两个权限 handler 给的不是同一种 details 结构，
 * 早期统一按单数 mediaType 解析，导致 setPermissionRequestHandler 永远拿到
 * undefined → 麦克风被拒 → 听歌识曲「麦克风」入口整个不可用，而系统声音
 * （display-capture 分支）仍正常，实测很容易漏掉。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkMediaType,
  permissionAllowed,
  requestMediaTypes
} from '../src/main/services/permissions.ts'

test('request handler 的 mediaTypes 是数组', () => {
  assert.deepEqual(requestMediaTypes({ mediaTypes: ['audio'] }), ['audio'])
  assert.deepEqual(requestMediaTypes({ mediaTypes: ['audio', 'video'] }), ['audio', 'video'])
  // 这正是踩过的坑：把 request 的 details 当成 check 的结构读
  assert.deepEqual(requestMediaTypes({ mediaType: 'audio' }), [])
  assert.deepEqual(requestMediaTypes({ mediaTypes: 'audio' }), [])
  assert.deepEqual(requestMediaTypes(null), [])
})

test('check handler 的 mediaType 是单数字符串', () => {
  assert.equal(checkMediaType({ mediaType: 'audio' }), 'audio')
  assert.equal(checkMediaType({ mediaType: 'unknown' }), 'unknown')
  assert.equal(checkMediaType({ mediaTypes: ['audio'] }), undefined)
  assert.equal(checkMediaType(undefined), undefined)
})

test('media 只放行纯音频，摄像头与混合请求一律拒绝', () => {
  assert.equal(permissionAllowed('media', ['audio'], false), true)
  assert.equal(permissionAllowed('media', ['video'], false), false)
  assert.equal(permissionAllowed('media', ['audio', 'video'], false), false)
  assert.equal(permissionAllowed('media', [], false), false)
  assert.equal(permissionAllowed('media', ['unknown'], false), false)
})

test('display-capture 只给主窗口，其它权限全部拒绝', () => {
  assert.equal(permissionAllowed('display-capture', [], true), true)
  assert.equal(permissionAllowed('display-capture', [], false), false)
  assert.equal(permissionAllowed('speaker-selection', [], false), true)
  assert.equal(permissionAllowed('geolocation', [], true), false)
  assert.equal(permissionAllowed('clipboard-read', [], true), false)
})
