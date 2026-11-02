/**
 * M3U 读写规则。
 *
 * 这里只测纯函数：真正的文件对话框、路径匹配、写盘在 `m3u-io` 与 IPC 层，
 * 那部分靠集成自检与手动验证。M3U 的坑几乎全在解析容错上——
 * 别的播放器写出来的文件五花八门，读不进来用户只会说「导入没反应」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildM3u, parseM3u, resolveLocation } from '../src/main/services/m3u.ts'

test('导出：标准扩展 M3U，时长毫秒转秒', () => {
  const text = buildM3u([
    { path: 'D:\\Music\\a.mp3', durationMs: 213_400, title: '夜曲', artist: '周杰伦' },
    { path: 'D:\\Music\\b.flac', durationMs: 0, title: '无时长', artist: '' }
  ])
  assert.equal(
    text,
    ['#EXTM3U', '#EXTINF:213,周杰伦 - 夜曲', 'D:\\Music\\a.mp3', '#EXTINF:-1,无时长', 'D:\\Music\\b.flac', ''].join(
      '\n'
    )
  )
})

test('导入：自己写出来的文件能原样读回', () => {
  const text = buildM3u([{ path: '/music/a.mp3', durationMs: 213_400, title: '夜曲', artist: '周杰伦' }])
  const parsed = parseM3u(text)
  assert.deepEqual(parsed, [{ location: '/music/a.mp3', duration: 213, title: '夜曲', artist: '周杰伦' }])
})

test('导入：BOM + CRLF 不影响', () => {
  const parsed = parseM3u('\uFEFF#EXTM3U\r\n#EXTINF:100,歌手 - 歌名\r\n/music/a.mp3\r\n')
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0].location, '/music/a.mp3')
  assert.equal(parsed[0].duration, 100)
})

test('导入：EXTINF 带属性（属性里的逗号不能把标题切坏）', () => {
  const parsed = parseM3u(
    '#EXTM3U\n#EXTINF:-1 tvg-id="abc" group-title="Rock, Pop",歌手 - 歌名\n/music/a.mp3\n'
  )
  assert.equal(parsed[0].title, '歌名')
  assert.equal(parsed[0].artist, '歌手')
})

test('导入：裸路径（没有 EXTINF）也能读', () => {
  const parsed = parseM3u('#EXTM3U\n/music/a.mp3\n/music/b.mp3\n')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].duration, -1)
  assert.equal(parsed[1].location, '/music/b.mp3')
})

test('导入：标题里没有分隔符时整串当歌名', () => {
  const parsed = parseM3u('#EXTM3U\n#EXTINF:10,只有歌名\n/music/a.mp3\n')
  assert.deepEqual(
    { title: parsed[0].title, artist: parsed[0].artist },
    { title: '只有歌名', artist: '' }
  )
})

test('导入：其它注释与空行被忽略，不产生条目', () => {
  const parsed = parseM3u('#EXTM3U\n\n#PLAYLIST:我的歌单\n#EXTINF:10,A - B\n/music/a.mp3\n\n')
  assert.equal(parsed.length, 1)
})

test('导入：Windows 反斜杠路径原样保留', () => {
  const parsed = parseM3u('#EXTM3U\n#EXTINF:10,A - B\nD:\\Music\\a.mp3\n')
  assert.equal(parsed[0].location, 'D:\\Music\\a.mp3')
})

test('相对路径按播放列表所在目录展开', () => {
  assert.equal(resolveLocation('a.mp3', 'D:\\Music'), 'D:\\Music\\a.mp3')
  assert.equal(resolveLocation('sub/a.mp3', '/home/me/music'), '/home/me/music/sub/a.mp3')
  assert.equal(resolveLocation('.\\a.mp3', 'D:\\Music\\'), 'D:\\Music\\a.mp3')
})

test('绝对路径与 URL 不被拼接', () => {
  assert.equal(resolveLocation('D:/Music/a.mp3', '/base'), 'D:/Music/a.mp3')
  assert.equal(resolveLocation('/abs/a.mp3', '/base'), '/abs/a.mp3')
  assert.equal(resolveLocation('\\\\nas\\share\\a.mp3', '/base'), '\\\\nas\\share\\a.mp3')
  assert.equal(resolveLocation('https://x/a.mp3', '/base'), 'https://x/a.mp3')
})
