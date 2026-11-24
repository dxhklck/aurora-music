/**
 * 快捷键扩展契约：新增命令必须在设置归一化、描述表和渲染命令处理里对齐。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const source = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

test('快捷键类型、默认值与归一化包含 lyric / drive', async () => {
  const types = await source('src/shared/types.ts')
  assert.match(types, /lyric\?: string/)
  assert.match(types, /drive\?: string/)

  const settings = await source('src/main/services/settings.ts')
  assert.ok(settings.includes("lyric: pick(source.lyric)"), '归一化未处理 lyric')
  assert.ok(settings.includes("drive: pick(source.drive)"), '归一化未处理 drive')

  const shortcuts = await source('src/main/shortcuts.ts')
  assert.match(shortcuts, /'toggle' \| 'next' \| 'prev' \| 'lyric' \| 'drive'/)
  assert.ok(shortcuts.includes('if (!binding.accelerator) continue'), '空快捷键不应注册')
})

test('渲染层能处理 lyric / drive 命令', async () => {
  const app = await source('src/renderer/src/App.vue')
  assert.ok(app.includes("command === 'lyric'"), '未处理 lyric 命令')
  assert.ok(app.includes("command === 'drive'"), '未处理 drive 命令')

  const settingsView = await source('src/renderer/src/views/SettingsView.vue')
  assert.ok(settingsView.includes("{ key: 'lyric', label: '桌面歌词' }"))
  assert.ok(settingsView.includes("{ key: 'drive', label: '驾驶模式' }"))
})
