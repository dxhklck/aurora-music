<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Song } from '@shared/types'
import { FAVORITES_ID } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import Icon from '../components/Icon.vue'
import { usePlaylistStore } from '../stores/playlists'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { formatDuration } from '@shared/lyric'

const props = defineProps<{ id?: string }>()

const playlists = usePlaylistStore()
const player = usePlayerStore()
const app = useAppStore()
const router = useRouter()

const playlistId = computed(() => props.id ?? FAVORITES_ID)
const playlist = computed(() => playlists.find(playlistId.value))
const songs = computed<Song[]>(() => playlist.value?.songs ?? [])
const isFavorites = computed(() => playlistId.value === FAVORITES_ID)
const totalDuration = computed(() => songs.value.reduce((sum, song) => sum + (song.duration || 0), 0))
/** 歌单封面：用首曲封面兜底，没有封面或空歌单时回落到图标 */
const cover = computed(() => (isFavorites.value ? '' : songs.value[0]?.coverUrl ?? ''))

const renaming = ref(false)
const draft = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

/** 排序模式：开启后列表行显示上移/下移按钮 */
const sorting = ref(false)
async function move(song: Song, direction: 'up' | 'down'): Promise<void> {
  await playlists.moveSong(playlistId.value, song, direction)
}

function playAll(): void {
  if (songs.value.length) player.setQueue(songs.value, 0)
}

async function remove(song: Song): Promise<void> {
  await playlists.removeSong(playlistId.value, song)
}

async function startRename(): Promise<void> {
  if (isFavorites.value) return
  draft.value = playlist.value?.name ?? ''
  renaming.value = true
  await nextTick()
  nameInput.value?.select()
}

async function commitRename(): Promise<void> {
  if (!renaming.value) return
  renaming.value = false
  const name = draft.value.trim()
  if (name && name !== playlist.value?.name) await playlists.rename(playlistId.value, name)
}

async function removePlaylist(): Promise<void> {
  if (isFavorites.value) return
  await playlists.remove(playlistId.value)
  void router.push('/favorites')
}

/**
 * 导出为 M3U。
 *
 * 只有本地曲目写得进去：在线曲目的地址需要本项目的主进程代理与鉴权，
 * 写进 M3U 别的播放器也播不了，反而让用户以为导出成功了。
 * 所以跳过多少首必须说清楚，不能静默丢弃。
 */
async function exportM3u(): Promise<void> {
  const result = await window.api.exportPlaylistM3u({
    id: playlistId.value,
    name: playlist.value?.name ?? '播放列表'
  })
  if (result.canceled) return
  if (!result.saved) {
    app.toast(
      result.skipped ? `${result.skipped} 首都不是本地文件，无法写进 M3U` : '这个歌单是空的',
      'error'
    )
    return
  }
  app.toast(
    result.skipped
      ? `已导出 ${result.saved} 首；${result.skipped} 首在线曲目未导出，先下载再导`
      : `已导出 ${result.saved} 首到 ${result.path.split(/[\\/]/).pop()}`,
    result.skipped ? 'info' : 'success'
  )
}

async function importM3u(): Promise<void> {
  const result = await window.api.importPlaylistM3u()
  if (result.canceled) return
  await playlists.load()
  if (!result.total) {
    app.toast('这个文件里没有可识别的曲目', 'error')
    return
  }
  if (!result.matched) {
    app.toast(`${result.total} 首都没有匹配到本地库里的文件`, 'error')
    return
  }
  app.toast(
    result.missing
      ? `已导入 ${result.matched} 首；${result.missing} 首在本地库里找不到`
      : `已导入 ${result.matched} 首`,
    result.missing ? 'info' : 'success'
  )
  if (result.playlistId) void router.push(`/playlist/${result.playlistId}`)
}
</script>

<template>
  <div class="playlist">
    <header class="head">
      <div class="art" :class="{ fav: isFavorites }">
        <img v-if="cover" :src="cover" class="art-cover" alt="" />
        <Icon v-else :name="isFavorites ? 'heart-filled' : 'list'" :size="34" />
      </div>
      <div class="info">
        <p class="kind">{{ isFavorites ? '收藏夹' : '自建歌单' }}</p>
        <div class="title-row">
          <input
            v-if="renaming"
            ref="nameInput"
            v-model="draft"
            class="name-input"
            maxlength="40"
            @blur="commitRename"
            @keydown.enter="commitRename"
            @keydown.esc="renaming = false"
          />
          <h1 v-else class="truncate">{{ playlist?.name ?? '歌单不存在' }}</h1>
          <button v-if="!isFavorites && playlist" class="mini" title="重命名" @click="startRename">
            <Icon name="pencil" :size="14" />
          </button>
        </div>
        <p class="meta">
          {{ songs.length }} 首
          <template v-if="totalDuration"> · {{ formatDuration(totalDuration) }}</template>
        </p>
      </div>
    </header>

    <div class="actions">
      <button class="btn primary" :disabled="!songs.length" @click="playAll">
        <Icon name="play" :size="15" /> 播放全部
      </button>
      <button
        class="btn"
        :class="{ active: sorting }"
        :disabled="!songs.length"
        @click="sorting = !sorting"
      >
        <Icon name="list" :size="15" /> {{ sorting ? '完成排序' : '排序' }}
      </button>
      <button v-if="!isFavorites && playlist" class="btn" @click="removePlaylist">
        <Icon name="trash" :size="15" /> 删除歌单
      </button>
      <button class="btn" :disabled="!songs.length" title="导出为 M3U（只含本地文件）" @click="exportM3u">
        <Icon name="export" :size="15" /> 导出 M3U
      </button>
      <button class="btn" title="从 M3U 导入成新歌单" @click="importM3u">
        <Icon name="download" :size="15" /> 导入 M3U
      </button>
    </div>

    <SongTable
      :songs="songs"
      :removable="!sorting"
      :moveable="sorting"
      show-size
      :empty-title="isFavorites ? '还没有收藏的歌曲' : '这个歌单还是空的'"
      empty-hint="在任意列表点红心收藏，或用「加入歌单」按钮把歌放进来"
      @remove="remove"
      @move="move"
    />
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-end;
  gap: 20px;
  margin: 14px 0 22px;
}

.art {
  width: 132px;
  height: 132px;
  border-radius: 18px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.9);
  background: linear-gradient(140deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.04));
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}
.art.fav {
  background: linear-gradient(140deg, color-mix(in srgb, var(--accent) 62%, transparent), color-mix(in srgb, var(--accent-2) 42%, transparent));
  border-color: transparent;
}
/* 首曲封面铺满方形封面框 */
.art-cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: inherit;
  display: block;
}

.info {
  min-width: 0;
  padding-bottom: 4px;
}
.kind {
  margin: 0 0 8px;
  font-size: 10.5px;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--text-3);
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.title-row h1 {
  margin: 0;
  font-size: 30px;
  font-weight: 750;
  letter-spacing: -0.6px;
}
.name-input {
  height: 40px;
  padding: 0 12px;
  font-size: 24px;
  font-weight: 700;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  color: var(--text);
  outline: none;
  min-width: 0;
}
.mini {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.mini:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}
.meta {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-3);
}

.actions {
  display: flex;
  gap: 10px;
  margin-bottom: 22px;
}
.actions .btn.active {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
</style>
