import type { RemotePlaylistPlatform } from '@shared/api'
import type { Playlist, Song } from '@shared/types'

export interface RemoteSyncPayload {
  platform: RemotePlaylistPlatform
  name: string
  remoteId: string
  songs: Song[]
}

const keyOf = (song: Song): string => `${song.platform}:${song.id}`

/** 同一首歌可能在多个平台存在，按 platform:id 去重 */
function dedupe(songs: Song[]): Song[] {
  const seen = new Set<string>()
  const result: Song[] = []
  for (const song of songs) {
    if (!song?.id || !song?.platform) continue
    const key = keyOf(song)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(song)
  }
  return result
}

/**
 * 把远端歌单同步进本地列表（纯函数，不修改入参）。
 *
 * 匹配只用「平台 + 远端 id」：两个平台可能返回相同的数字 id，
 * 用 id 字段区分（neteaseId / qqId）才不会互相覆盖。
 * 已同步过的歌单原地更新，id 保持不变——正在播放、收藏里保存的引用都还指向它。
 */
export function syncRemotePlaylistInList(
  list: Playlist[],
  payload: RemoteSyncPayload,
  now = Date.now()
): Playlist[] {
  const label = payload.platform === 'qq' ? 'QQ 音乐' : '网易云'
  const prefix = payload.platform === 'qq' ? 'qq' : 'ne'
  const name = `${label} · ${payload.name}`
  const songs = dedupe(payload.songs)
  const link =
    payload.platform === 'qq' ? { qqId: payload.remoteId } : { neteaseId: payload.remoteId }
  const idField = payload.platform === 'qq' ? 'qqId' : 'neteaseId'

  const index = list.findIndex((item) => item[idField] === payload.remoteId)
  if (index >= 0) {
    const next = [...list]
    next[index] = { ...next[index], name, songs, updatedAt: now, ...link }
    return next
  }

  return [
    ...list,
    {
      id: `${prefix}-${payload.remoteId}`,
      name,
      songs,
      createdAt: now,
      updatedAt: now,
      ...link
    }
  ]
}
