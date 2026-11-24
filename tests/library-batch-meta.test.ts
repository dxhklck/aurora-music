/**
 * 批量元数据编辑的契约护栏：补丁字段、封面选择入口和“不碰远端封面服务”的边界。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const source = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

test('批量元数据补丁支持歌名与封面路径', async () => {
  const api = await source('src/shared/api.ts')
  const block = api.match(/updateLibraryMetaMany\([\s\S]*?\): Promise<LibraryOpReport>/)?.[0]
  assert.ok(block, '找不到 updateLibraryMetaMany 声明')
  for (const field of ['artists?', 'album?', 'name?', 'coverPath?']) {
    assert.ok(block.includes(field), `批量补丁缺少 ${field}`)
  }

  const library = await source('src/main/services/library.ts')
  assert.ok(library.includes('persistCover(patch.coverPath'), '封面路径未写入本地封面存储')
  assert.ok(!library.includes("from './cover'"), '本地批量封面不应复用远端 cover 服务')
})

test('曲库界面提供单曲歌名与多选封面入口', async () => {
  const view = await source('src/renderer/src/views/LibraryView.vue')
  assert.ok(view.includes('metaIds.length === 1'), '歌名字段未限制单选')
  assert.ok(view.includes('chooseLibraryCover'), '缺少封面选择入口')
  assert.ok(view.includes('metaCoverPath.value ? { coverPath:'), '封面路径未传给批量更新')
})
