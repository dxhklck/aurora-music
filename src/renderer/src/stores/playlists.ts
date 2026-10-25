import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Playlist, Song } from '@shared/types'
import { FAVORITES_ID } from '@shared/types'
import { useAppStore } from './app'
import { plain } from '../core/plain'

const keyOf = (song: Song): string => `${song.platform}:${song.id}`

/**
 * 收藏与自建歌单。所有写操作都返回完整列表，store 直接整体替换，
 * 避免主进程与渲染层各维护一份导致不一致。
 */
export const usePlaylistStore = defineStore('playlists', () => {
  const items = ref<Playlist[]>([])
  const loaded = ref(false)
  /** 待加入歌单的歌曲：非空时弹出选择器 */
  const pickerSong = ref<Song | null>(null)

  const favorites = computed(() => items.value.find((item) => item.id === FAVORITES_ID))
  const custom = computed(() => items.value.filter((item) => item.id !== FAVORITES_ID))
  const favoriteKeys = computed(
    () => new Set((favorites.value?.songs ?? []).map((song) => keyOf(song)))
  )

  function isFavorite(song?: Song | null): boolean {
    return !!song && favoriteKeys.value.has(keyOf(song))
  }

  function find(id: string): Playlist | undefined {
    return items.value.find((item) => item.id === id)
  }

  async function load(): Promise<void> {
    items.value = await window.api.listPlaylists()
    loaded.value = true
  }

  async function create(name: string, songs: Song[] = []): Promise<Playlist | null> {
    const before = new Set(items.value.map((item) => item.id))
    items.value = await window.api.createPlaylist(name, plain(songs))
    return items.value.find((item) => !before.has(item.id)) ?? null
  }

  async function rename(id: string, name: string): Promise<void> {
    items.value = await window.api.renamePlaylist(id, name)
  }

  async function remove(id: string): Promise<void> {
    items.value = await window.api.removePlaylist(id)
    useAppStore().toast('歌单已删除', 'info')
  }

  async function addSongs(id: string, songs: Song[]): Promise<void> {
    const target = find(id)
    const before = target?.songs.length ?? 0
    items.value = await window.api.addPlaylistSongs(id, plain(songs))
    const after = find(id)?.songs.length ?? 0
    useAppStore().toast(
      after > before ? `已加入《${find(id)?.name ?? ''}》` : '这些歌已经在歌单里了',
      after > before ? 'success' : 'info'
    )
  }

  async function removeSong(id: string, song: Song): Promise<void> {
    items.value = await window.api.removePlaylistSong(id, song.platform, song.id)
  }

  async function toggleFavorite(song: Song): Promise<void> {
    const result = await window.api.toggleFavorite(plain(song))
    items.value = result.list
  }

  function openPicker(song: Song): void {
    pickerSong.value = song
  }

  function closePicker(): void {
    pickerSong.value = null
  }

  return {
    items,
    loaded,
    pickerSong,
    favorites,
    custom,
    favoriteKeys,
    isFavorite,
    find,
    load,
    create,
    rename,
    remove,
    addSongs,
    removeSong,
    toggleFavorite,
    openPicker,
    closePicker
  }
})
