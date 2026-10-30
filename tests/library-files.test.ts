/**
 * 本地库文件操作的纯函数单测。
 *
 * 这两个函数决定「哪些文件允许被删」和「导出后叫什么名字」，
 * 算错了不会抛异常，只会删错文件或写出非法文件名，所以必须有测试兜底。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'

import { isInsideDir, renderNameTemplate } from '../src/main/utils.ts'
import type { LibraryTrack } from '../src/shared/types.ts'

function track(patch: Partial<LibraryTrack> & { song?: Partial<LibraryTrack['song']> } = {}): LibraryTrack {
  const { song, ...rest } = patch
  return {
    id: 'local:test',
    filePath: '',
    fileName: 'fallback.mp3',
    size: 1024,
    ext: 'flac',
    downloadedAt: 0,
    ...rest,
    song: {
      id: 'local:test',
      platform: 'local',
      name: '晴天',
      artists: ['周杰伦'],
      album: '叶惠美',
      coverUrl: null,
      duration: 269_000,
      ...song
    }
  }
}

test('isInsideDir：目录内的文件才算可删', () => {
  const root = resolve('/music/downloads')
  assert.equal(isInsideDir(resolve(root, 'a.mp3'), root), true)
  assert.equal(isInsideDir(resolve(root, 'sub/b.flac'), root), true)
})

test('isInsideDir：目录自身与相邻同名目录都不算', () => {
  const root = resolve('/music/downloads')
  assert.equal(isInsideDir(root, root), false)
  // downloads2 以 downloads 开头，前缀比较法会误判，这里必须为 false
  assert.equal(isInsideDir(resolve('/music/downloads2/a.mp3'), root), false)
  // 用 .. 绕出去
  assert.equal(isInsideDir(resolve(root, '../other/a.mp3'), root), false)
})

test('renderNameTemplate：按模板替换歌手/歌名/专辑/格式', () => {
  const name = renderNameTemplate('{artist} - {name} [{album}]', track())
  assert.equal(name, '周杰伦 - 晴天 [叶惠美]')
})

test('renderNameTemplate：空专辑不会留下「A -  - B」的残渣', () => {
  const name = renderNameTemplate('{artist} - {album} - {name}', track({ song: { album: '' } }))
  assert.equal(name, '周杰伦 - 晴天')
})

test('renderNameTemplate：非法字符被清洗，模板全空时回退歌名', () => {
  const name = renderNameTemplate('{name}:{artist}?', track())
  assert.ok(!/[\\/:*?"<>|]/.test(name), `仍含非法字符: ${name}`)
  assert.equal(renderNameTemplate('{album}', track({ song: { album: '' } })), '晴天')
})
