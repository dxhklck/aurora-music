<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Song } from '@shared/types'
import { FAVORITES_ID } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import Icon from '../components/Icon.vue'
import { usePlaylistStore } from '../stores/playlists'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'
import { formatDuration } from '@shared/lyric'

const props = defineProps<{ id?: string }>()

const playlists = usePlaylistStore()
const player = usePlayerStore()
const app = useAppStore()
const download = useDownloadStore()
const router = useRouter()

const playlistId = computed(() => props.id ?? FAVORITES_ID)
const playlist = computed(() => playlists.find(playlistId.value))
const songs = computed<Song[]>(() => playlist.value?.songs ?? [])
const isFavorites = computed(() => playlistId.value === FAVORITES_ID)
const totalDuration = computed(() => songs.value.reduce((sum, song) => sum + (song.duration || 0), 0))
/** 歌单封面：自定义优先，其次首曲封面，都没有时回落到图标 */
const coverBroken = ref(false)
const cover = computed(() => {
  const custom = isFavorites.value ? '' : (playlist.value?.cover ?? '')
  if (custom && !coverBroken.value) return custom
  return isFavorites.value ? '' : (songs.value[0]?.coverUrl ?? '')
})

/* ---------------- 歌单内搜索 ---------------- */
const query = ref('')
const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return songs.value
  return songs.value.filter((song) =>
    [song.name, ...song.artists, song.album ?? ''].join(' ').toLowerCase().includes(keyword)
  )
})

/* ---------------- 简介 ---------------- */
const editingDesc = ref(false)
const descDraft = ref('')
const descInput = ref<HTMLInputElement | null>(null)

async function startEditDesc(): Promise<void> {
  if (isFavorites.value) return
  descDraft.value = playlist.value?.description ?? ''
  editingDesc.value = true
  await nextTick()
  descInput.value?.select()
}

async function commitDesc(): Promise<void> {
  if (!editingDesc.value) return
  editingDesc.value = false
  const text = descDraft.value.trim()
  if (text === (playlist.value?.description ?? '')) return
  await playlists.updateMeta(playlistId.value, { description: text })
}

async function changeCover(): Promise<void> {
  if (isFavorites.value) return
  const chosen = await playlists.chooseCover()
  if (!chosen) return
  coverBroken.value = false
  await playlists.updateMeta(playlistId.value, { cover: chosen })
}

async function resetCover(): Promise<void> {
  coverBroken.value = false
  await playlists.updateMeta(playlistId.value, { cover: '' })
}

// 换歌单时清空搜索词，否则新歌单会莫名只剩几首
watch(playlistId, () => {
  query.value = ''
  coverBroken.value = false
  editingDesc.value = false
})

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

/* ---------------- 多选批量 ---------------- */

function playPicked(picked: Song[], clear: () => void): void {
  if (!picked.length) return
  player.setQueue(picked, 0)
  clear()
}

function queuePicked(picked: Song[], clear: () => void): void {
  if (!picked.length) return
  picked.forEach((song) => player.appendToQueue(song))
  app.toast(`已把 ${picked.length} 首排进队列`, 'success')
  clear()
}

/** 和单曲「加入歌单」同一面板：可追加到已有歌单，也可新建 */
function addPicked(picked: Song[], clear: () => void): void {
  if (!picked.length) return
  playlists.openPicker(picked)
  clear()
}

function downloadPicked(picked: Song[], clear: () => void): void {
  if (!picked.length) return
  void download.enqueueMany(picked)
  clear()
}

async function removePicked(picked: Song[], clear: () => void): Promise<void> {
  if (!picked.length) return
  for (const song of picked) await playlists.removeSong(playlistId.value, song)
  clear()
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
  menuOpen.value = false
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

async function importM3u(targetId?: string): Promise<void> {
  menuOpen.value = false
  const result = await window.api.importPlaylistM3u(targetId)
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
  const verb = targetId ? '追加' : '导入'
  app.toast(
    result.missing
      ? `已${verb} ${result.matched} 首；${result.missing} 首在本地库里找不到`
      : `已${verb} ${result.matched} 首${targetId ? `到《${result.name}》` : ''}`,
    result.missing ? 'info' : 'success'
  )
  if (!targetId && result.playlistId) void router.push(`/playlist/${result.playlistId}`)
}

/* M3U 菜单：把「导出 / 导入为新歌单 / 追加到本歌单」收在一个入口里，按钮行不再膨胀 */
const menuOpen = ref(false)
</script>

<template>
  <div class="playlist">
    <header class="head">
      <div class="art" :class="{ fav: isFavorites }">
        <img v-if="cover" :src="cover" class="art-cover" alt="" @error="coverBroken = true" />
        <Icon v-else :name="isFavorites ? 'heart-filled' : 'list'" :size="34" />
        <button
          v-if="!isFavorites && playlist"
          class="art-edit"
          title="更换封面"
          @click="changeCover"
        >
          <Icon name="pencil" :size="14" />
        </button>
        <button
          v-if="!isFavorites && playlist?.cover"
          class="art-reset"
          title="恢复默认封面"
          @click="resetCover"
        >
          <Icon name="close" :size="12" />
        </button>
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

        <div class="desc-row">
          <input
            v-if="editingDesc"
            ref="descInput"
            v-model="descDraft"
            class="desc-input"
            maxlength="120"
            placeholder="一句话介绍这个歌单"
            @blur="commitDesc"
            @keydown.enter="commitDesc"
            @keydown.esc="editingDesc = false"
          />
          <p v-else-if="playlist?.description" class="desc" @click="startEditDesc">
            {{ playlist.description }}
          </p>
          <button v-else-if="!isFavorites && playlist" class="desc-add" @click="startEditDesc">
            + 添加简介
          </button>
        </div>

        <p class="meta">
          {{ songs.length }} 首
          <template v-if="totalDuration"> · {{ formatDuration(totalDuration) }}</template>
          <template v-if="query.trim()"> · 找到 {{ filtered.length }} 首</template>
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
      <div class="m3u">
        <button class="btn" :class="{ active: menuOpen }" @click="menuOpen = !menuOpen">
          <Icon name="export" :size="15" /> M3U
        </button>
        <template v-if="menuOpen">
          <div class="m3u-mask" @click="menuOpen = false" />
          <div class="m3u-menu">
            <button :disabled="!songs.length" @click="exportM3u">
              导出为 M3U<small>只含本地文件</small>
            </button>
            <button @click="importM3u()">导入为新歌单</button>
            <button v-if="playlist" @click="importM3u(playlistId)">
              追加到《{{ playlist.name }}》
            </button>
          </div>
        </template>
      </div>

      <label class="find" :class="{ on: query.trim() }">
        <Icon name="search" :size="14" />
        <input v-model="query" placeholder="在歌单内搜索" spellcheck="false" />
        <button v-if="query" class="find-clear" title="清空" @click.prevent="query = ''">
          <Icon name="close" :size="12" />
        </button>
      </label>
    </div>

    <SongTable
      :songs="filtered"
      :selectable="!sorting && !query.trim()"
      :removable="!sorting"
      :moveable="sorting"
      show-size
      :empty-title="
        query.trim()
          ? '没有匹配的歌曲'
          : isFavorites
            ? '还没有收藏的歌曲'
            : '这个歌单还是空的'
      "
      :empty-hint="
        query.trim() ? '换个关键词试试，歌名、歌手、专辑都能搜' : '在任意列表点红心收藏，或用「加入歌单」按钮把歌放进来'
      "
      @remove="remove"
      @move="move"
    >
      <template #bulk="{ selected: picked, clear }">
        <button class="btn primary" :disabled="!picked.length" @click="playPicked(picked, clear)">
          <Icon name="play" :size="13" /> 播放选中
        </button>
        <button class="btn" :disabled="!picked.length" @click="queuePicked(picked, clear)">
          <Icon name="queue" :size="13" /> 加入队列
        </button>
        <button class="btn" :disabled="!picked.length" @click="addPicked(picked, clear)">
          <Icon name="playlist-add" :size="13" /> 加入歌单
        </button>
        <button class="btn" :disabled="!picked.length" @click="downloadPicked(picked, clear)">
          <Icon name="download" :size="13" /> 下载
        </button>
        <button class="btn" :disabled="!picked.length" @click="removePicked(picked, clear)">
          <Icon name="trash" :size="13" /> {{ isFavorites ? '取消收藏' : '移出歌单' }}
        </button>
      </template>
    </SongTable>
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
  position: relative;
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

/* 封面上的小按钮：不占布局，悬停才显形 */
.art-edit,
.art-reset {
  position: absolute;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.52);
  backdrop-filter: blur(6px);
  opacity: 0;
  transition: opacity 0.15s;
}
.art-edit {
  left: 8px;
  bottom: 8px;
}
.art-reset {
  right: 8px;
  top: 8px;
  width: 22px;
  height: 22px;
}
.art:hover .art-edit,
.art:hover .art-reset {
  opacity: 1;
}

.desc-row {
  margin-top: 8px;
  min-height: 20px;
}
.desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-2);
  cursor: text;
  max-width: 620px;
}
.desc:hover {
  color: var(--text);
}
.desc-add {
  font-size: 12px;
  color: var(--text-3);
  padding: 2px 0;
  background: none;
  border: none;
}
.desc-add:hover {
  color: var(--accent);
}
.desc-input {
  width: min(520px, 60vw);
  height: 28px;
  padding: 0 10px;
  font-size: 12.5px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 50%, transparent);
  background: rgba(255, 255, 255, 0.06);
  color: var(--text);
  outline: none;
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
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
}
.actions .btn.active {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

/* M3U 下拉：一个入口装三个动作，遮罩负责点外部关闭 */
.m3u {
  position: relative;
}
.m3u .btn.active {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.m3u-mask {
  position: fixed;
  inset: 0;
  z-index: 20;
}
.m3u-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 21;
  min-width: 196px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  border-radius: 12px;
  background: var(--overlay-bg);
  border: 1px solid var(--overlay-border);
  box-shadow: var(--shadow);
}
.m3u-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 10px;
  border-radius: 8px;
  text-align: left;
  font-size: 12px;
  color: var(--text-2);
}
.m3u-menu button:hover:not(:disabled) {
  background: var(--row-hover);
  color: var(--text);
}
.m3u-menu button:disabled {
  opacity: 0.4;
  cursor: default;
}
.m3u-menu small {
  font-size: 10px;
  color: var(--text-3);
}

.find {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-3);
  transition: border-color 0.15s;
}
.find:focus-within,
.find.on {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--text-2);
}
.find input {
  width: 132px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
}
.find-clear {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--text-3);
}
.find-clear:hover {
  background: var(--panel-strong);
  color: var(--text);
}
</style>
