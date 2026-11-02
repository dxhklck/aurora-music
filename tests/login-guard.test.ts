import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAllowedLoginUrl } from '../src/main/services/login-guard.ts'

test('QQ 音乐自己的域放行', () => {
  assert.equal(isAllowedLoginUrl('qq', 'https://y.qq.com/'), true)
  assert.equal(isAllowedLoginUrl('qq', 'https://ptlogin2.qq.com/cgi-bin/login'), true)
  assert.equal(isAllowedLoginUrl('qq', 'https://xui.ptlogin2.qq.com/x/y'), true)
  assert.equal(isAllowedLoginUrl('qq', 'https://qq.com/'), true)
})

test('网易云自己的域放行', () => {
  assert.equal(isAllowedLoginUrl('netease', 'https://music.163.com/'), true)
  assert.equal(isAllowedLoginUrl('netease', 'https://login.163.com/?foo=1'), true)
})

test('后缀像但不是子域的域名必须挡住', () => {
  // 这是用 `.qq.com` 而不是 `endsWith('qq.com')` 的原因
  assert.equal(isAllowedLoginUrl('qq', 'https://evilqq.com/'), false)
  assert.equal(isAllowedLoginUrl('qq', 'https://qq.com.evil.com/'), false)
  assert.equal(isAllowedLoginUrl('netease', 'https://fake163.com/'), false)
})

test('跨平台不放行：QQ 登录窗打不开网易云', () => {
  assert.equal(isAllowedLoginUrl('qq', 'https://music.163.com/'), false)
  assert.equal(isAllowedLoginUrl('netease', 'https://y.qq.com/'), false)
})

test('非 http(s) 协议一律拒绝', () => {
  assert.equal(isAllowedLoginUrl('qq', 'file:///C:/Windows/System32/calc.exe'), false)
  assert.equal(isAllowedLoginUrl('qq', 'javascript:alert(1)'), false)
  // Electron 内部页（chrome:// 等）不是合法目标
  assert.equal(isAllowedLoginUrl('netease', 'chrome://settings'), false)
})

test('畸形 URL 不抛错，按拒绝处理', () => {
  assert.equal(isAllowedLoginUrl('qq', 'not a url'), false)
  assert.equal(isAllowedLoginUrl('qq', ''), false)
})

test('大小写与端口不影响判定', () => {
  assert.equal(isAllowedLoginUrl('qq', 'https://Y.QQ.COM/'), true)
  assert.equal(isAllowedLoginUrl('qq', 'https://y.qq.com:443/'), true)
})
