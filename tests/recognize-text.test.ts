import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RECOGNIZE_KEYWORD_MAX,
  externalSearchLinks,
  searchKeywords,
  trackLabel
} from '../src/shared/recognize-text.ts'

test('trackLabel 拼「歌名 - 歌手」，缺一个就只给有的', () => {
  assert.equal(trackLabel('暧昧', '王菲'), '暧昧 - 王菲')
  assert.equal(trackLabel('暧昧', ''), '暧昧')
  assert.equal(trackLabel('', '王菲'), '王菲')
  assert.equal(trackLabel('', ''), '')
})

test('trackLabel 压掉多余空白，不吞掉歌名里的连字符', () => {
  assert.equal(trackLabel('  暧昧    (Live) ', '  王菲 '), '暧昧 (Live) - 王菲')
  assert.equal(trackLabel('Lo-Fi', 'A'), 'Lo-Fi - A')
})

test('searchKeywords 先带歌手，再退到只搜歌名', () => {
  assert.deepEqual(searchKeywords('暧昧', '王菲'), ['暧昧 王菲', '暧昧'])
})

test('searchKeywords 没有歌手时不重复造一条一样的', () => {
  assert.deepEqual(searchKeywords('暧昧', ''), ['暧昧'])
  assert.deepEqual(searchKeywords('暧昧', '   '), ['暧昧'])
})

test('searchKeywords 遇到纯标点 / 表情直接不给候选', () => {
  assert.deepEqual(searchKeywords('', ''), [])
  assert.deepEqual(searchKeywords('……', '😀😀'), [])
  assert.deepEqual(searchKeywords('♪', ''), [])
})

test('searchKeywords 每条都不超过关键词上限', () => {
  const title = '长'.repeat(80)
  const list = searchKeywords(title, '歌手')
  assert.ok(list.length > 0)
  for (const keyword of list) assert.ok(keyword.length <= RECOGNIZE_KEYWORD_MAX)
})

test('单字歌名也能搜（中文单字标题很常见）', () => {
  assert.deepEqual(searchKeywords('氧', '歌手'), ['氧 歌手', '氧'])
  assert.deepEqual(searchKeywords('殇', ''), ['殇'])
  assert.equal(trackLabel('氧', ''), '氧')
  assert.equal(externalSearchLinks('氧', '').length, 3)
})

test('externalSearchLinks 给出三个平台，关键词做了 URL 编码', () => {
  const links = externalSearchLinks('暧昧', '王菲')
  assert.deepEqual(
    links.map((link) => link.id),
    ['qq', 'kugou', 'bilibili']
  )
  const encoded = encodeURIComponent('暧昧 王菲')
  for (const link of links) assert.ok(link.url.includes(encoded), link.url)
  assert.ok(links.every((link) => link.url.startsWith('https://')))
})

test('externalSearchLinks 没有可用关键词时返回空数组', () => {
  assert.deepEqual(externalSearchLinks('', ''), [])
  assert.deepEqual(externalSearchLinks('……', ''), [])
})

test('externalSearchLinks 里的 & 与 # 已被编码，不会截断 URL', () => {
  const [qq] = externalSearchLinks('Rock & Roll', 'AC/DC')
  assert.ok(qq.url.includes('%26'))
  assert.ok(!qq.url.includes('&Roll'))
  // 平台自己的分隔符仍在
  assert.ok(qq.url.startsWith('https://y.qq.com/n/ryqq/search?w='))
})
