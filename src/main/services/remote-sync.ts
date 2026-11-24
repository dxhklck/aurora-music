import type { RemotePlaylistPlatform } from '@shared/api'
import type { Playlist, RemoteSyncPlan, RemoteSyncResult, Song } from '@shared/types'

export interface RemoteSyncPayload {
  platform: RemotePlaylistPlatform
  name: string
  remoteId: string
  songs: Song[]
}

export interface RemoteSyncApplyPayload extends RemoteSyncPayload {
  deleteRemoteMissing: boolean
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

function matchIndex(list: Playlist[], payload: RemoteSyncPayload): number {
  const idField = payload.platform === 'qq' ? 'qqId' : 'neteaseId'
  return list.findIndex((item) => item[idField] === payload.remoteId)
}

function targetInfo(payload: RemoteSyncPayload): { label: string; prefix: string } {
  return payload.platform === 'qq'
    ? { label: 'QQ 音乐', prefix: 'qq' }
    : { label: '网易云', prefix: 'ne' }
}

function buildPlaylist(
  existing: Playlist | undefined,
  payload: RemoteSyncPayload,
  songs: Song[],
  now: number
): Playlist {
  const { label, prefix } = targetInfo(payload)
  const name = `${label} · ${payload.name}`
  const link =
    payload.platform === 'qq' ? { qqId: payload.remoteId } : { neteaseId: payload.remoteId }
  if (existing) {
    return { ...existing, name, songs, updatedAt: now, lastSyncAt: now, ...link }
  }
  return {
    id: `${prefix}-${payload.remoteId}`,
    name,
    songs,
    createdAt: now,
    updatedAt: now,
    lastSyncAt: now,
    ...link
  }
}

/** 生成差异计划：远端删歌默认保留，确认后才在 apply 阶段移除。纯函数，不修改入参 */
export function planRemoteSyncInList(
  list: Playlist[],
  payload: RemoteSyncPayload,
  now = Date.now()
): { plan: RemoteSyncPlan; list: Playlist[] } {
  const remoteSongs = dedupe(payload.songs)
  const remoteKeys = new Set(remoteSongs.map(keyOf))
  const index = matchIndex(list, payload)
  const existing = index >= 0 ? list[index] : undefined
  const localKeys = new Set((existing?.songs ?? []).map(keyOf))
  const added = remoteSongs.filter((song) => !localKeys.has(keyOf(song)))
  const keptMissing = (existing?.songs ?? []).filter((song) => !remoteKeys.has(keyOf(song)))
  const playlist = buildPlaylist(existing, payload, remoteSongs, now)
  const next = [...list]
  if (index >= 0) next[index] = playlist
  else next.push(playlist)
  return {
    plan: { playlist, added, keptMissing, missingCount: keptMissing.length },
    list: next
  }
}

/** 按确认结果落盘差异；deleteRemoteMissing 为真才移除远端已删曲目 */
export function applyRemoteSyncInList(
  list: Playlist[],
  payload: RemoteSyncApplyPayload,
  now = Date.now()
): { result: RemoteSyncResult; list: Playlist[] } {
  const { plan, list: plannedList } = planRemoteSyncInList(list, payload, now)
  const kept = new Set(plan.keptMissing.map(keyOf))
  const removed = payload.deleteRemoteMissing ? plan.keptMissing : []
  const finalSongs = payload.deleteRemoteMissing
    ? plan.playlist.songs
    : [...plan.playlist.songs, ...plan.keptMissing]
  const playlist = { ...plan.playlist, songs: dedupe(finalSongs), updatedAt: now, lastSyncAt: now }
  const index = matchIndex(plannedList, payload)
  const next = [...plannedList]
  if (index >= 0) next[index] = playlist
  return {
    result: { playlist, added: plan.added, keptMissing: kept.size ? plan.keptMissing : [], removed },
    list: next
  }
}
