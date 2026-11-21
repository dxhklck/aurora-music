/**
 * 「导入账号歌单」渲染层护栏。
 *
 * store 与面板都是薄封装，真正的风险是漏接 API、找错返回项或把不该有的
 * 分享链接 / 下载入口带进来。这里做纯文本检查，不启动浏览器环境。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

async function source(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8')
}

test('store syncRemote 调用 shared API 并按 idField 返回', async () => {
  const store = await source('src/renderer/src/stores/playlists.ts')
  assert.match(store, /async function syncRemote\(/, '缺少 syncRemote')
  assert.ok(store.includes('window.api.syncRemotePlaylist'), '未调用 shared API')
  assert.ok(store.includes("platform === 'qq' ? 'qqId' : 'neteaseId'"), '返回项查找未按平台 id 字段')
  assert.match(store, /^\s{4}syncRemote,/m, 'store 未导出 syncRemote')
})

test('面板含平台切换/登录引导/VIP 提示/无分享链接输入/无下载调用', async () => {
  const panel = await source('src/renderer/src/components/ImportPlaylistPanel.vue')
  for (const text of ['网易云音乐', 'QQ 音乐', '去登录', '会员歌曲']) {
    assert.ok(panel.includes(text), `面板缺少「${text}」`)
  }
  assert.ok(panel.includes('window.api.remotePlaylists'), '未读取远端歌单列表')
  assert.ok(panel.includes('window.api.remotePlaylistDetail'), '未读取歌单详情')
  assert.ok(
    panel.includes('playlists.planRemoteSync') && panel.includes('playlists.applyRemoteSync'),
    '未调用差异计划 / 应用同步'
  )
  assert.ok(panel.includes('ConfirmDialog'), '远端删歌缺少确认弹窗')
  assert.ok(panel.includes('默认会从本地歌单中保留这些歌'), '缺少默认保留提示')
  assert.ok(!/placeholder="[^"]*分享/.test(panel), '本期不做分享链接输入')
  assert.ok(!panel.includes('parseQqPlaylistId'), '本期不做分享链接解析')
  assert.ok(!/enqueueDownload|download\(/.test(panel), '导入歌单不应触发下载')
})

test('SideBar 标题栏并列导入与新建', async () => {
  const sidebar = await source('src/renderer/src/components/SideBar.vue')
  assert.ok(sidebar.includes('导入账号歌单'), '侧栏缺少导入入口')
  assert.ok(sidebar.includes('新建歌单'), '侧栏缺少新建入口')
  assert.ok(sidebar.includes('ImportPlaylistPanel'), '侧栏未挂载导入面板')
})
