/**
 * 账号歌单同步的纯函数。
 *
 * 关键语义：同一平台 + 远端 id 原地更新（歌单 id 不变，正在播放/收藏引用还能对上），
 * 首次导入才新建；不同平台的远端 id 即使数字相同也不能互相覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Playlist, Song } from '../src/shared/types.ts'
import { syncRemotePlaylistInList } from '../src/main/services/remote-sync.ts'

function song(platform: string, id: string, name = `曲目 ${id}`): Song {
  return {
    id,
    platform,
    name,
    artists: ['测试歌手'],
    album: '测试专辑',
    coverUrl: null,
    duration: 180_000
  }
}

test('首次同步新建带平台 id 的歌单', () => {
  const result = syncRemotePlaylistInList(
    [],
    { platform: 'netease', name: '我的歌单', remoteId: '123', songs: [song('netease', 's1')] },
    1_000
  )
  assert.equal(result.length, 1)
  const item = result[0]
  assert.equal(item.id, 'ne-123')
  assert.equal(item.name, '网易云 · 我的歌单')
  assert.equal(item.neteaseId, '123')
  assert.equal(item.qqId, undefined)
  assert.equal(item.songs.length, 1)
  assert.equal(item.createdAt, 1_000)
  assert.equal(item.updatedAt, 1_000)
})

test('重复同步同平台 remoteId 原地更新', () => {
  const first = syncRemotePlaylistInList(
    [],
    { platform: 'netease', name: '旧名字', remoteId: '123', songs: [song('netease', 's1')] },
    1_000
  )
  const second = syncRemotePlaylistInList(
    first,
    { platform: 'netease', name: '新名字', remoteId: '123', songs: [song('netease', 's2')] },
    2_000
  )
  assert.equal(second.length, 1, '重复同步不应新建歌单')
  assert.equal(second[0].id, first[0].id, '歌单 id 必须保持不变')
  assert.equal(second[0].name, '网易云 · 新名字')
  assert.equal(second[0].songs[0].id, 's2', '曲目应整体替换')
  assert.equal(second[0].createdAt, 1_000)
  assert.equal(second[0].updatedAt, 2_000)
})

test('QQ 与网易相同 remoteId 不串单', () => {
  const netease = syncRemotePlaylistInList(
    [],
    { platform: 'netease', name: '同 id', remoteId: '42', songs: [song('netease', 'n1')] },
    1_000
  )
  const both = syncRemotePlaylistInList(
    netease,
    { platform: 'qq', name: '同 id', remoteId: '42', songs: [song('qq', 'q1')] },
    2_000
  )
  assert.equal(both.length, 2)
  assert.deepEqual(
    both.map((item) => item.id),
    ['ne-42', 'qq-42']
  )
  assert.equal(both[0].songs[0].id, 'n1')
  assert.equal(both[1].songs[0].id, 'q1')
})

test('同步曲目按 platform:id 去重', () => {
  const result = syncRemotePlaylistInList(
    [],
    {
      platform: 'qq',
      name: '去重',
      remoteId: '7',
      songs: [song('qq', '1'), song('qq', '1'), song('netease', '1')]
    },
    1_000
  )
  assert.deepEqual(
    result[0].songs.map((item) => `${item.platform}:${item.id}`),
    ['qq:1', 'netease:1']
  )
})

test('既有歌单列表不被修改', () => {
  const list: Playlist[] = []
  const result = syncRemotePlaylistInList(
    list,
    { platform: 'netease', name: 'x', remoteId: '9', songs: [] },
    1_000
  )
  assert.equal(list.length, 0, '纯函数不应修改入参')
  assert.equal(result.length, 1)
})
