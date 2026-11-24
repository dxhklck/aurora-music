/**
 * 桌面歌词主题跟随契约：主题由主窗口推送，子窗口写 data-theme，自定义色继续覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const source = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

test('LyricWindowState 推送主题', async () => {
  const types = await source('src/shared/types.ts')
  const block = types.match(/export interface LyricWindowState \{[\s\S]*?\n\}/)?.[0]
  assert.ok(block, '找不到 LyricWindowState')
  assert.match(block, /theme\?: 'dark' \| 'light'/)

  const app = await source('src/renderer/src/App.vue')
  assert.ok(app.includes('theme: resolvedTheme.value'), '主窗口未推送主题')
  assert.ok(!app.includes('歌词窗口恒定深色'), '旧的固定深色注释应删除')
})

test('歌词窗口应用主题且保留自定义颜色', async () => {
  const view = await source('src/renderer/src/views/DesktopLyric.vue')
  assert.ok(view.includes('document.documentElement.dataset.theme = payload.theme'), '未应用主题')
  assert.ok(view.includes('if (style.color) vars[\'--ly-user\']'), '自定义颜色覆盖不应被移除')

  const doc = await source('docs/desktop-lyric.md')
  assert.ok(doc.includes('跟随主窗口主题'), '文档未更新主题行为')
})
