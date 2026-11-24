/**
 * 「导入账号歌单」契约护栏。
 *
 * 这些类型要跨主进程 / preload / 渲染层三处使用，漏一个字段编译器不一定发现
 * （IPC 返回的只是 any 形状），所以用纯文本断言钉住关键声明。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

async function source(path: string): Promise<string> {
  return readFile(join(root, path), 'utf8')
}

test('Playlist 持久化远端 id 与摘要类型', async () => {
  const types = await source('src/shared/types.ts')
  const playlist = types.match(/export interface Playlist \{[\s\S]*?\n\}/)
  assert.ok(playlist, '找不到 Playlist 接口')
  assert.match(playlist[0], /neteaseId\?: string/, 'Playlist 缺少 neteaseId 字段')
  assert.match(playlist[0], /qqId\?: string/, 'Playlist 缺少 qqId 字段')
  assert.match(playlist[0], /lastSyncAt\?: number/, 'Playlist 缺少 lastSyncAt 字段')
  assert.match(types, /export interface RemoteSyncPlan \{/, '缺少 RemoteSyncPlan 类型')
  assert.match(types, /export interface RemoteSyncResult \{/, '缺少 RemoteSyncResult 类型')

  const summary = types.match(/export interface RemotePlaylistSummary \{[\s\S]*?\n\}/)
  assert.ok(summary, '缺少 RemotePlaylistSummary 类型')
  for (const field of ['id: string', 'name: string', 'trackCount: number', 'coverUrl', 'creator']) {
    assert.ok(summary[0].includes(field), `RemotePlaylistSummary 缺少 ${field}`)
  }
})

test('shared API 定义远端歌单平台类型', async () => {
  const api = await source('src/shared/api.ts')
  assert.match(
    api,
    /export type RemotePlaylistPlatform = 'netease' \| 'qq'/,
    '缺少 RemotePlaylistPlatform 类型'
  )
})

test('netease provider 暴露账号歌单列表详情', async () => {
  const netease = await source('src/main/providers/netease.ts')
  assert.match(netease, /accountUid\(/, '缺少 accountUid 取当前账号 uid')
  assert.match(netease, /async userPlaylists\(/, '缺少 userPlaylists')
  assert.match(netease, /async userPlaylistDetail\(/, '缺少 userPlaylistDetail')
  assert.match(netease, /api\/user\/playlist/, '账号歌单列表未使用 /api/user/playlist')
})

test('qq provider 使用账号歌单接口与 g_tk', async () => {
  const qq = await source('src/main/providers/qq.ts')
  assert.match(qq, /qqGtk\(/, 'QQ 歌单接口需要 g_tk')
  assert.match(qq, /fcg_user_created_diss/, '账号歌单列表未使用 fcg_user_created_diss')
  assert.match(qq, /fcg_ucc_getcdinfo_byids_cp/, '歌单详情未使用 fcg_ucc_getcdinfo_byids_cp')
  assert.match(qq, /async userPlaylists\(/, '缺少 userPlaylists')
  assert.match(qq, /async userPlaylistDetail\(/, '缺少 userPlaylistDetail')
})

test('MusicProvider 声明可选的账号歌单方法', async () => {
  const types = await source('src/main/providers/types.ts')
  assert.match(types, /userPlaylists\?\(\)/, 'MusicProvider 缺少可选 userPlaylists')
  assert.match(types, /userPlaylistDetail\?\(/, 'MusicProvider 缺少可选 userPlaylistDetail')
})

test('IPC 三通道定义唯一，并在 preload / main 对齐', async () => {
  const ipc = await source('src/shared/ipc.ts')
  const channels: Record<string, string> = {
    playlistRemoteList: 'playlist:remote-list',
    playlistRemoteDetail: 'playlist:remote-detail',
    playlistSyncRemote: 'playlist:sync-remote',
    playlistSyncPlan: 'playlist:sync-plan',
    playlistSyncApply: 'playlist:sync-apply'
  }
  for (const [key, value] of Object.entries(channels)) {
    assert.match(ipc, new RegExp(`${key}: '${value}'`), `IPC 缺少 ${key}`)
  }

  const preload = await source('src/preload/index.ts')
  for (const key of Object.keys(channels)) {
    assert.ok(preload.includes(`IPC.${key}`), `preload 未引用 IPC.${key}`)
  }

  const main = await source('src/main/ipc.ts')
  for (const key of Object.keys(channels)) {
    assert.ok(main.includes(`IPC.${key}`), `主进程未注册 IPC.${key}`)
  }
})

test('AuroraApi 与 catalog 暴露远端歌单能力', async () => {
  const api = await source('src/shared/api.ts')
  assert.match(api, /remotePlaylists\(platform: RemotePlaylistPlatform\)/, '缺少 remotePlaylists 声明')
  assert.match(api, /remotePlaylistDetail\([\s\S]*?platform: RemotePlaylistPlatform/, '缺少 remotePlaylistDetail 声明')
  assert.match(api, /syncRemotePlaylist\(payload:/, '缺少 syncRemotePlaylist 声明')
  assert.match(api, /planRemoteSyncPlaylist\(payload:/, '缺少 planRemoteSyncPlaylist 声明')
  assert.match(api, /applyRemoteSyncPlaylist\(payload:/, '缺少 applyRemoteSyncPlaylist 声明')

  const catalog = await source('src/main/services/catalog.ts')
  assert.match(catalog, /async remotePlaylists\(/, 'catalog 缺少 remotePlaylists')
  assert.match(catalog, /async remotePlaylistDetail\(/, 'catalog 缺少 remotePlaylistDetail')

  const playlists = await source('src/main/services/playlists.ts')
  assert.match(playlists, /async syncRemote\(/, '歌单服务缺少 syncRemote')
  assert.match(playlists, /planRemoteSync\(/, '歌单服务缺少 planRemoteSync')
  assert.match(playlists, /async applyRemoteSync\(/, '歌单服务缺少 applyRemoteSync')
})
