/**
 * 任务栏媒体面板封面地址的还原规则。
 *
 * 这条规则的由来：Electron 45（Chromium 156）起，`MediaMetadata.artwork` 的 src
 * 只接受 http/https/data/blob，自定义协议会被静默丢弃。本项目封面走
 * `muse://media/?u=` 代理，升级后任务栏就再也没有封面了——界面上看不出来，
 * 只有渲染层一条警告。所以必须把它还原成原始 http(s) 地址。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { artworkSrc } from '../src/renderer/src/core/artwork.ts'

const origin = 'https://p1.music.126.net/abc.jpg?param=320y320'

test('代理地址还原成原始 https 地址', () => {
  const proxied = `muse://media/?u=${encodeURIComponent(origin)}&r=${encodeURIComponent('https://music.163.com/')}`
  assert.equal(artworkSrc(proxied), origin)
})

test('已经是 https 的原样返回', () => {
  assert.equal(artworkSrc(origin), origin)
})

test('http 图升到 https：渲染层 CSP 不允许 http 图', () => {
  assert.equal(
    artworkSrc('http://img1.kuwo.cn/star/albumcover/1.jpg'),
    'https://img1.kuwo.cn/star/albumcover/1.jpg'
  )
  const proxied = `muse://media/?u=${encodeURIComponent('http://p1.music.126.net/a.jpg')}`
  assert.equal(artworkSrc(proxied), 'https://p1.music.126.net/a.jpg')
})

test('data 与 blob 允许（Chromium 的白名单里）', () => {
  assert.equal(artworkSrc('data:image/png;base64,AAA'), 'data:image/png;base64,AAA')
  assert.equal(artworkSrc('blob:http://localhost/abc'), 'blob:http://localhost/abc')
})

test('本地封面文件给不了系统，返回 undefined', () => {
  assert.equal(artworkSrc('muse://local/?p=%2Fhome%2Fme%2Fcovers%2F1.jpg'), undefined)
})

test('代理里包的不是 http(s) 时返回 undefined', () => {
  assert.equal(artworkSrc(`muse://media/?u=${encodeURIComponent('file:///etc/passwd')}`), undefined)
  assert.equal(artworkSrc('muse://media/?u='), undefined)
})

test('空值与畸形输入不抛错', () => {
  assert.equal(artworkSrc(''), undefined)
  assert.equal(artworkSrc(null), undefined)
  assert.equal(artworkSrc(undefined), undefined)
  assert.equal(artworkSrc('   '), undefined)
  assert.equal(artworkSrc('not a url'), undefined)
})
