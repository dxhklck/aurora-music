/**
 * 纯函数单测：不依赖 Electron 运行时，直接跑 Node。
 *
 *   npm run test:unit
 *
 * 只覆盖「算错了不会报错、但会让用户看到错数据」的地方：
 * 歌词时间轴、文件名清洗、字节格式化、HTML 实体还原。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildLyric,
  findLyricIndex,
  formatBytes,
  formatDuration,
  lyricToLrc,
  parseLrc,
  parseQrc,
  parseYrc
} from '../src/shared/lyric.ts'
import { decodeHtml, sanitizeFileName, uniqueFilePath } from '../src/main/utils.ts'
import { decryptQrc, extractQrcLyric } from '../src/main/providers/qrc.ts'
import {
  composeQQCookie,
  cookieFromHeader,
  hash33,
  parsePtuiCB,
  wapiAes,
  wapiBody
} from '../src/main/services/qrlogin-util.ts'

test('parseLrc：一行多时间戳会展开成多行', () => {
  const raw = ['[00:12.00][01:20.50]副歌重复', '[00:30.123]主歌'].join('\n')
  const { lines } = parseLrc(raw)
  assert.equal(lines.length, 3)
  assert.deepEqual(
    lines.map((line) => line.time),
    [12_000, 30_123, 80_500]
  )
  assert.equal(lines[0].text, '副歌重复')
  assert.equal(lines[2].text, '副歌重复')
})

test('parseLrc：offset 元数据与时间排序', () => {
  const raw = ['[offset:-500]', '[00:10.00]B', '[00:05.00]A'].join('\n')
  const parsed = parseLrc(raw)
  assert.equal(parsed.offset, -500)
  assert.deepEqual(
    parsed.lines.map((line) => line.text),
    ['A', 'B']
  )
})

test('parseLrc：没有时间轴时降级为 plain', () => {
  const parsed = parseLrc('第一句\n第二句')
  assert.equal(parsed.lines.length, 0)
  assert.equal(parsed.plain, '第一句\n第二句')
})

test('buildLyric：译文按时间戳合并', () => {
  const lrc = '[00:01.00]hello'
  const translation = '[00:01.00]你好'
  const lyric = buildLyric(lrc, translation, 'test')
  assert.equal(lyric.lines.length, 1)
  assert.equal(lyric.lines[0].translation, '你好')
  assert.equal(lyric.translated, true)
})

test('parseYrc：逐字时间轴是绝对毫秒，且忽略 JSON 元信息行', () => {
  // 真实 yrc：前几行是 {"t":0,"c":[...]} 的作词/作曲元信息，正文才是 [行起点,行时长](字起点,字时长,0)字
  const raw = [
    '{"t":0,"c":[{"tx":"作词: "},{"tx":"赵雷"}]}',
    '[1000,2000](1000,500,0)你(1500,500,0)好'
  ].join('\n')
  const lines = parseYrc(raw)
  assert.equal(lines.length, 1)
  assert.equal(lines[0].time, 1000)
  assert.equal(lines[0].endTime, 3000)
  assert.equal(lines[0].words?.length, 2)
  assert.equal(lines[0].words?.[0].time, 1000)
  assert.equal(lines[0].words?.[1].time, 1500)
  assert.equal(lines[0].text, '你好')
})

test('findLyricIndex：命中区间与边界', () => {
  const lines = [
    { time: 0, text: 'a', translation: '' },
    { time: 1000, text: 'b', translation: '' },
    { time: 3000, text: 'c', translation: '' }
  ]
  assert.equal(findLyricIndex(lines, 0), 0)
  assert.equal(findLyricIndex(lines, 999), 0)
  assert.equal(findLyricIndex(lines, 1000), 1)
  assert.equal(findLyricIndex(lines, 2999), 1)
  assert.equal(findLyricIndex(lines, 9999), 2)
})

test('lyricToLrc：序列化后能再解析回来', () => {
  const lyric = {
    lines: [
      { time: 1500, text: '第一句', translation: 'first' },
      { time: 72_000, text: '第二句', translation: '' }
    ],
    offset: 0,
    translated: true,
    source: 'test'
  }
  const text = lyricToLrc(lyric)
  const parsed = parseLrc(text)
  assert.equal(parsed.lines.length, 2)
  assert.equal(parsed.lines[0].time, 1500)
  assert.equal(parsed.lines[1].time, 72_000)
})

test('formatDuration / formatBytes 边界', () => {
  assert.equal(formatDuration(0), '00:00')
  assert.equal(formatDuration(65_000), '01:05')
  assert.equal(formatDuration(3_723_000), '62:03')
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024 * 3.5), '3.5 MB')
})

test('sanitizeFileName：非法字符、尾部点号、超长截断', () => {
  assert.equal(sanitizeFileName('a/b:c*?"<>|d'), 'a b c d')
  assert.equal(sanitizeFileName('  周杰伦 - 稻香.  '), '周杰伦 - 稻香')
  assert.equal(sanitizeFileName(''), 'untitled')
  assert.equal(sanitizeFileName('x'.repeat(200)).length, 120)
})

test('decodeHtml：数字实体与命名实体', () => {
  assert.equal(decodeHtml('A&amp;B'), 'A&B')
  assert.equal(decodeHtml('&#58;'), ':')
  assert.equal(decodeHtml('&#x4e2d;'), '中')
  assert.equal(decodeHtml('&unknown;'), '&unknown;')
})

test('uniqueFilePath：同名文件自动追加序号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-test-'))
  const first = await uniqueFilePath(dir, 'song', 'mp3')
  assert.ok(first.endsWith('song.mp3'))
  await writeFile(first, 'x')
  const second = await uniqueFilePath(dir, 'song', 'mp3')
  assert.ok(second.endsWith('song (1).mp3'))
})

test('decryptQrc：3DES+zlib 解出的 XML 含逐字时间戳', () => {
  // fixture 由 Python Crypto.DES3(ECB) + zlib 交叉加密生成，验证 Node 侧互通
  const hex = readFileSync(join(import.meta.dirname, 'fixtures', 'qrc.hex'), 'utf8')
  const xml = decryptQrc(hex)
  assert.match(xml, /<LyricContent>/)
  assert.match(xml, /青花瓷/)

  // QRC 是「文字在前、时间戳在后」，与网易云 YRC 互为镜像，必须走 parseQrc
  const content = extractQrcLyric(xml)
  const { lines, offset } = parseQrc(content)
  assert.equal(offset, 0)
  assert.equal(lines.length, 2, '元数据行应被 parseQrc 过滤')
  assert.equal(lines[0].text, '青花瓷')
  assert.equal(lines[0].time, 1000)
  assert.equal(lines[0].endTime, 3400)
  assert.equal(lines[0].words?.length, 3)
  assert.deepEqual(
    lines[0].words?.map((w) => [w.text, w.time, w.duration]),
    [
      ['青', 1000, 600],
      ['花', 1600, 500],
      ['瓷', 2100, 600]
    ]
  )
  assert.equal(lines[1].text, '天青色等烟雨')
  assert.equal(lines[1].words?.length, 6)
  assert.equal(lines[1].words?.[1].time, 4150)
  assert.equal(lines[1].endTime, 6500)

  // 逐字歌词经 buildLyric(qrc) 后应标记 wordByWord，供 UI 走卡拉OK渲染
  const lyric = buildLyric('', '', 'QQ 音乐', content, 'qrc')
  assert.equal(lyric.wordByWord, true)
  assert.equal(lyric.lines.length, 2)
  assert.equal(lyric.lines[0].words?.[0].text, '青')
})

test('parseQrc：两种括号变体与异常行', () => {
  const { lines, offset } = parseQrc(
    ['[offset:250]', '[0,100]你(0,500)好(500,500)', '[2000,500]纯文本行', '[3000,100]a(3000,50,9)b(3050,50)'].join('\n')
  )
  assert.equal(offset, 250)
  assert.equal(lines.length, 3)
  assert.equal(lines[0].text, '你好')
  assert.deepEqual(
    lines[0].words?.map((w) => w.duration),
    [500, 500]
  )
  assert.equal(lines[1].text, '纯文本行')
  assert.equal(lines[1].words, undefined)
  // 三数字变体：第三个数忽略，前两个照常用
  assert.equal(lines[2].text, 'ab')
  assert.equal(lines[2].words?.length, 2)
})

test('decryptQrc：非法输入抛错而不是崩掉调用方', () => {
  assert.throws(() => decryptQrc(''), /8 的倍数/)
  assert.throws(() => decryptQrc('zz'), /hex|长度/)
  assert.throws(() => decryptQrc('00'.repeat(16)), /解密|解压/)
})

/* ---------------- 扫码登录 ---------------- */

test('hash33：与网页版登录 JS 算法一致', () => {
  // 手算参照：h = (h << 5) + h + c，'a'→97，'b'→97*33+98=3299，'c'→3299*33+99=108966
  assert.equal(hash33('abc'), 108966)
  assert.equal(hash33('a'), 97)
  // g_tk 种子 5381（QQ 接口惯例）：逐步 (5381*33+97)→*33+98→*33+99
  assert.equal(hash33('abc', 5381), 2147483647 & (((5381 * 33 + 97) * 33 + 98) * 33 + 99))
})

test('parsePtuiCB：解析 QQ 登录轮询响应', () => {
  const waiting = parsePtuiCB("ptuiCB('66','0','','0','二维码未失效。', '')")
  assert.ok(waiting)
  assert.equal(waiting.code, '66')
  assert.equal(waiting.args.length, 6)
  const success = parsePtuiCB("ptuiCB('0','0','https://x?ptsigx=ABC&s_url=y&uin=123&service=z','0','登录成功', '')")
  assert.equal(success?.code, '0')
  assert.match(success?.args[2] ?? '', /ptsigx=ABC/)
  // 垃圾输入不能崩
  assert.equal(parsePtuiCB('<html>error</html>'), null)
  assert.equal(parsePtuiCB("ptuiCB('xx')"), null)
})

test('cookieFromHeader：从 Set-Cookie 里按名字取值', () => {
  const headers = [
    'Path=/; HttpOnly',
    'MUSIC_U=00AB12; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/',
    '__csrf=abcdef; Path=/'
  ]
  assert.equal(cookieFromHeader(headers, 'MUSIC_U'), '00AB12')
  assert.equal(cookieFromHeader(headers, '__csrf'), 'abcdef')
  assert.equal(cookieFromHeader(headers, 'missing'), '')
})

test('composeQQCookie：拼出 y.qq.com web 端可用的登录 Cookie', () => {
  const cookie = composeQQCookie(123456789, 'MUSICKEY_XYZ')
  assert.equal(cookie, 'uin=o123456789; qm_keyst=MUSICKEY_XYZ; qqmusic_key=MUSICKEY_XYZ; tmeLoginType=1')
})

test('wapiBody：网易云 weapi 请求体形状正确（双重 AES + RSA）', () => {
  // AES 确定性输出可做黄金值：key=0CoJUm6Qyw8W8jud, iv=0102030405060708
  assert.equal(wapiAes('{"type":1}', '0CoJUm6Qyw8W8jud'), 'huTohECphyUpWFnxKqFLew==')
  const body = wapiBody({ type: 1 })
  assert.match(body.params, /^[A-Za-z0-9+/=]+$/)
  // encSecKey 是 RSA(128 字节) 的 hex
  assert.match(body.encSecKey, /^[0-9a-f]{256}$/)
})
