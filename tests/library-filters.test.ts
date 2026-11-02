/**
 * 本地库筛选/排序/删除判定的单测。
 *
 * 重点是 `isInDownloadDir`：它是整个应用里唯一决定「能不能真删用户文件」的判断。
 * 判宽了会删掉用户导入的原始文件（不可挽回），判窄了确认框说删 3 个、实际删 2 个。
 * 这两种错误都不会抛异常，只会在用户那里表现为「文件没了」或「数量对不上」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  confirmSummary,
  dirOf,
  isImported,
  isInDownloadDir,
  matchesFilters,
  sortTracks,
  splitPending,
  EMPTY_FILTERS
} from '../src/renderer/src/views/library/filters.ts'
import type { LibraryTrack } from '../src/shared/types.ts'

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function track(
  filePath: string,
  overrides: Partial<LibraryTrack> & { name?: string; album?: string; artists?: string[] } = {}
): LibraryTrack {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  return {
    id: overrides.id ?? `local:${filePath}`,
    filePath,
    fileName: name,
    size: overrides.size ?? 1000,
    ext: overrides.ext ?? 'mp3',
    downloadedAt: overrides.downloadedAt ?? 0,
    missing: overrides.missing,
    song: {
      id: `local:${filePath}`,
      platform: 'local',
      name: overrides.name ?? name.replace(/\.[^.]+$/, ''),
      artists: overrides.artists ?? [],
      album: overrides.album ?? '',
      coverUrl: null,
      duration: overrides.song?.duration ?? 0
    }
  } as LibraryTrack
}

// ─────────────────────────── 删除判定 ───────────────────────────

test('下载目录内的文件判定为可删', () => {
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music\\a.mp3', 'D:\\Music\\Aurora Music'), true)
})

test('大小写不同仍算同一个目录（Windows 不区分大小写）', () => {
  assert.equal(isInDownloadDir('d:/music/aurora music/a.mp3', 'D:\\Music\\Aurora Music'), true)
})

test('反斜杠与正斜杠混用不影响判定', () => {
  assert.equal(isInDownloadDir('D:/Music/Aurora Music/a.mp3', 'D:\\Music\\Aurora Music'), true)
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music\\a.mp3', 'D:/Music/Aurora Music'), true)
})

test('下载目录带尾斜杠不影响判定', () => {
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music\\a.mp3', 'D:\\Music\\Aurora Music\\'), true)
})

test('相邻同名目录不算「在里面」：Aurora Music2 必须判 false', () => {
  // 这是 startsWith(root) 的经典误判：确认框会说「删除」，而那是用户自己的目录
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music2\\a.mp3', 'D:\\Music\\Aurora Music'), false)
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music-old\\a.mp3', 'D:\\Music\\Aurora Music'), false)
})

test('下载目录是盘符根时一律判 false（宁可只移除，不误删整盘）', () => {
  assert.equal(isInDownloadDir('D:\\Music\\a.mp3', 'D:\\'), false)
  assert.equal(isInDownloadDir('D:\\Music\\a.mp3', 'D:'), false)
})

test('下载目录为空时一律判 false', () => {
  assert.equal(isInDownloadDir('D:\\Music\\a.mp3', ''), false)
})

test('带 .. 的路径一律判 false（保守方向）', () => {
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music\\..\\secret\\a.mp3', 'D:\\Music\\Aurora Music'), false)
})

test('目录本身不是文件，判 false', () => {
  assert.equal(isInDownloadDir('D:\\Music\\Aurora Music', 'D:\\Music\\Aurora Music'), false)
})

test('dirOf 同时处理两种分隔符', () => {
  assert.equal(dirOf('D:\\Music\\a.mp3'), 'D:\\Music')
  assert.equal(dirOf('/home/user/music/a.mp3'), '/home/user/music')
  assert.equal(dirOf('a.mp3'), '')
})

test('isImported 按 id 前缀判断，不受下载目录改动影响', () => {
  assert.equal(isImported('local:D:\\Music\\a.mp3'), true)
  assert.equal(isImported('qq:123456'), false)
  assert.equal(isImported('netease:789'), false)
})

// ─────────────────────────── 筛选 ───────────────────────────

test('关键词能命中歌手与专辑，也能命中文件名与路径', () => {
  const item = track('D:\\Music\\周杰伦 - 夜曲.mp3', { name: '夜曲', album: '十一月的萧邦', artists: ['周杰伦'] })
  assert.equal(matchesFilters(item, { ...EMPTY_FILTERS, keyword: '周杰伦' }), true)
  assert.equal(matchesFilters(item, { ...EMPTY_FILTERS, keyword: '萧邦' }), true)
  assert.equal(matchesFilters(item, { ...EMPTY_FILTERS, keyword: '夜曲' }), true)
  assert.equal(matchesFilters(item, { ...EMPTY_FILTERS, keyword: '林俊杰' }), false)
})

test('来源筛选按 id 前缀区分下载与导入', () => {
  const downloaded = track('D:\\Music\\Aurora Music\\a.mp3', { id: 'qq:1' })
  const imported = track('D:\\My Music\\b.mp3', { id: 'local:D:\\My Music\\b.mp3' })
  assert.equal(matchesFilters(downloaded, { ...EMPTY_FILTERS, source: 'download' }), true)
  assert.equal(matchesFilters(downloaded, { ...EMPTY_FILTERS, source: 'imported' }), false)
  assert.equal(matchesFilters(imported, { ...EMPTY_FILTERS, source: 'imported' }), true)
})

test('文件夹筛选按完整目录精确匹配', () => {
  const item = track('D:\\Music\\Aurora Music\\a.mp3')
  assert.equal(matchesFilters(item, { ...EMPTY_FILTERS, folder: 'D:\\Music\\Aurora Music' }), true)
  assert.equal(matchesFilters(item, { ...EMPTY_FILTERS, folder: 'D:\\Music' }), false)
})

// ─────────────────────────── 排序 ───────────────────────────

test('空专辑在正序与反序下都沉底', () => {
  const withAlbum = track('D:\\m\\a.mp3', { album: '十一月的萧邦' })
  const noAlbum = track('D:\\m\\b.mp3', { album: '' })
  const asc = sortTracks([noAlbum, withAlbum], 'album', 'asc', collator)
  const desc = sortTracks([noAlbum, withAlbum], 'album', 'desc', collator)
  assert.deepEqual(asc.map((t) => t.song.album), ['十一月的萧邦', ''])
  // 反序时不能把「无专辑」翻到最前面——那是最容易写错的一行
  assert.deepEqual(desc.map((t) => t.song.album), ['十一月的萧邦', ''])
})

test('时长为 0 的条目同样沉底（时长未知不参与比较）', () => {
  const known = track('D:\\m\\a.mp3')
  known.song.duration = 200_000
  const unknown = track('D:\\m\\b.mp3')
  unknown.song.duration = 0
  const asc = sortTracks([unknown, known], 'duration', 'asc', collator)
  assert.deepEqual(asc.map((t) => t.song.duration), [200_000, 0])
})

test('按添加时间排序回到原始先后', () => {
  const first = track('D:\\m\\a.mp3', { downloadedAt: 100 })
  const second = track('D:\\m\\b.mp3', { downloadedAt: 200 })
  const desc = sortTracks([first, second], 'added', 'desc', collator)
  assert.deepEqual(desc.map((t) => t.downloadedAt), [200, 100])
})

test('sortTracks 不修改入参数组', () => {
  const items = [track('D:\\m\\b.mp3', { downloadedAt: 2 }), track('D:\\m\\a.mp3', { downloadedAt: 1 })]
  const copy = [...items]
  sortTracks(items, 'added', 'asc', collator)
  assert.deepEqual(items, copy)
})

// ─────────────────────────── 确认文案 ───────────────────────────

test('splitPending 分组并统计字节数，缺失文件不计入', () => {
  const items = [
    track('D:\\Music\\Aurora Music\\a.mp3', { size: 100 }),
    track('D:\\Music\\Aurora Music\\b.mp3', { size: 200, missing: true }),
    track('D:\\My Music\\c.mp3', { size: 400 })
  ]
  const split = splitPending(items, 'D:\\Music\\Aurora Music')
  assert.equal(split.deletable.length, 2)
  assert.equal(split.imported.length, 1)
  assert.equal(split.bytes, 100)
})

test('确认文案三分支与数字一致', () => {
  assert.equal(confirmSummary({ deletable: [], imported: [track('D:\\u\\a.mp3')] }, 'delete'), '从库移除 1 首')
  assert.equal(
    confirmSummary({ deletable: [track('D:\\d\\a.mp3')], imported: [] }, 'delete'),
    '删除 1 个文件'
  )
  assert.equal(
    confirmSummary(
      { deletable: [track('D:\\d\\a.mp3'), track('D:\\d\\b.mp3')], imported: [track('D:\\u\\c.mp3')] },
      'delete'
    ),
    '删除 2 个 · 移除 1 个'
  )
  assert.equal(
    confirmSummary({ deletable: [track('D:\\d\\a.mp3')], imported: [track('D:\\u\\c.mp3')] }, 'remove'),
    '从库移除 2 首'
  )
})
