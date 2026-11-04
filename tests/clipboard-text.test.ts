import test from 'node:test'
import assert from 'node:assert/strict'
import { CLIPBOARD_KEYWORD_MAX, clipboardKeyword } from '../src/shared/clipboard-text.ts'

test('普通歌名原样返回', () => {
  assert.equal(clipboardKeyword('周杰伦 晴天'), '周杰伦 晴天')
  assert.equal(clipboardKeyword('  周杰伦 - 晴天  '), '周杰伦 - 晴天')
})

test('分享文案里的链接被剔除，标题留下', () => {
  assert.equal(clipboardKeyword('周杰伦《晴天》 https://music.163.com/song?id=186016'), '周杰伦《晴天》')
  assert.equal(clipboardKeyword('https://y.qq.com/n/ryqq/songDetail/abc'), '')
})

test('多行只取第一行有内容的', () => {
  assert.equal(clipboardKeyword('\n\n富士山下\n快去听'), '富士山下')
})

test('连续空白压成一个空格', () => {
  assert.equal(clipboardKeyword('周杰伦    -    晴天'), '周杰伦 - 晴天')
  assert.equal(clipboardKeyword('周杰伦\u3000晴天'), '周杰伦 晴天')
})

test('超长文本按上限截断', () => {
  const long = '歌'.repeat(200)
  assert.equal(clipboardKeyword(long).length, CLIPBOARD_KEYWORD_MAX)
  assert.equal(clipboardKeyword(long), '歌'.repeat(CLIPBOARD_KEYWORD_MAX))
})

test('空内容与纯符号返回空串', () => {
  assert.equal(clipboardKeyword(''), '')
  assert.equal(clipboardKeyword('   \n\t  '), '')
  assert.equal(clipboardKeyword('😀😀😀😀'), '')
  assert.equal(clipboardKeyword('……！！！'), '')
  assert.equal(clipboardKeyword('a'), '', '单字符不足两字，视为无意义')
})

test('中英混排与数字都算可搜内容', () => {
  assert.equal(clipboardKeyword('周杰伦 Jay Chou 2003'), '周杰伦 Jay Chou 2003')
  assert.equal(clipboardKeyword('七里香'), '七里香')
})
