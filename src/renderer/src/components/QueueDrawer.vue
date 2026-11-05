<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Song } from '@shared/types'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { usePlayerStore } from '../stores/player'
import { usePlaylistStore } from '../stores/playlists'
import { useDownloadStore } from '../stores/download'
import { useSearchStore } from '../stores/search'
import { formatDuration } from '@shared/lyric'

const player = usePlayerStore()
const playlists = usePlaylistStore()
const download = useDownloadStore()
const search = useSearchStore()
const router = useRouter()

/**
 * 用 uid 判断「正在播的那行」，不用 platform:id——
 * 同一首歌可以在队列里出现多次（反复点「下一首播放」），按 id 判断会让两行同时亮起。
 */
const currentUid = computed(() => player.current?.uid ?? '')

/* ---------------- 拖拽重排 ----------------
   列表项的 key 是 uid（不是 index），所以重排只移动 DOM 而不是重建：
   封面不重新请求、正在播那行的 .eq 动画不会重头开始。 */
const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)

function onDragStart(index: number, event: DragEvent): void {
  dragFrom.value = index
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  // 某些内核不设数据就不肯开始拖拽
  event.dataTransfer.setData('text/plain', String(index))
}

function onDragOver(index: number): void {
  if (dragFrom.value === null || dragFrom.value === index) return
  dragOver.value = index
}

function onDrop(index: number): void {
  if (dragFrom.value !== null) player.moveQueueItem(dragFrom.value, index)
  onDragEnd()
}

function onDragEnd(): void {
  dragFrom.value = null
  dragOver.value = null
}

/* ---------------- 行内操作 ----------------
   和歌曲列表同一套图标语义：收藏 / 加入歌单 / 下载 / 搜索 / 移出队列 */

function downloadSong(song: Song): void {
  void download.enqueue(song)
}

/** 拿歌名 + 歌手回搜索页再搜一遍（找同名翻唱、其它演绎） */
function searchSong(song: Song): void {
  const keyword = [song.name, ...song.artists].filter(Boolean).join(' ').trim()
  if (!keyword) return
  player.showQueue = false
  void router.push({ name: 'search' })
  void search.run(keyword)
}

/**
 * 整批存歌单：走和单曲「加入歌单」同一个面板，
 * 既能追加到已有歌单，也能在面板里新建一个，不再只有「新建」一条路。
 * uid 是会话内的定位标记，落盘前剥掉。
 */
function saveToPlaylist(): void {
  if (!player.queue.length) return
  playlists.openPicker(player.queue.map(({ uid: _uid, ...song }) => song))
}

/* ---------------- 多选 ----------------
   队列里同一首歌可以出现多次，选中项按 uid 记，不按 platform:id。 */
const selecting = ref(false)
const selected = ref(new Set<string>())

const selectedCount = computed(() => selected.value.size)
const allSelected = computed(
  () => player.queue.length > 0 && selected.value.size === player.queue.length
)

function toggleSelecting(): void {
  selecting.value = !selecting.value
  if (!selecting.value) selected.value.clear()
}

function togglePick(uid: string): void {
  if (!selecting.value) return
  if (selected.value.has(uid)) selected.value.delete(uid)
  else selected.value.add(uid)
}

function toggleAll(): void {
  if (allSelected.value) selected.value.clear()
  else selected.value = new Set(player.queue.map((song) => song.uid))
}

/** 选中项转成干净 Song（剥掉 uid），三个批量动作共用 */
function pickedSongs(): Song[] {
  return player.queue
    .filter((song) => selected.value.has(song.uid))
    .map(({ uid: _uid, ...song }) => song)
}

function removePicked(): void {
  if (!selected.value.size) return
  player.removeMany([...selected.value])
  selected.value.clear()
}

function downloadPicked(): void {
  const songs = pickedSongs()
  if (!songs.length) return
  void download.enqueueMany(songs)
  selected.value.clear()
}

function savePicked(): void {
  const songs = pickedSongs()
  if (!songs.length) return
  playlists.openPicker(songs)
  selected.value.clear()
}
</script>

<template>
  <transition name="slide">
    <aside v-if="player.showQueue" class="drawer glass">
      <header class="head">
        <div>
          <strong>播放队列</strong>
          <small>{{ player.queue.length }} 首</small>
        </div>
        <div class="row" style="gap: 4px">
          <button
            class="icon-btn"
            :class="{ on: selecting }"
            :title="selecting ? '退出多选' : '多选'"
            @click="toggleSelecting"
          >
            <Icon name="check" :size="16" />
          </button>
          <button class="icon-btn" title="存为歌单" @click="saveToPlaylist">
            <Icon name="plus" :size="16" />
          </button>
          <button class="icon-btn" title="清空" @click="player.clearQueue()">
            <Icon name="trash" :size="16" />
          </button>
          <button class="icon-btn" title="关闭" @click="player.showQueue = false">
            <Icon name="close" :size="16" />
          </button>
        </div>
      </header>

      <div v-if="selecting" class="bulk">
        <button class="bulk-all" @click="toggleAll">
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
        <span class="bulk-count">已选 {{ selectedCount }} 首</span>
        <div class="bulk-acts">
          <button :disabled="!selectedCount" @click="removePicked">移出</button>
          <button :disabled="!selectedCount" @click="downloadPicked">下载</button>
          <button :disabled="!selectedCount" @click="savePicked">存歌单</button>
        </div>
      </div>

      <div class="list">
        <div
          v-for="(song, index) in player.queue"
          :key="song.uid"
          class="item"
          :class="{
            playing: song.uid === currentUid,
            dragging: dragFrom === index,
            'drop-target': dragOver === index && dragFrom !== index,
            selecting,
            picked: selected.has(song.uid)
          }"
          :draggable="!selecting"
          @dragstart="onDragStart(index, $event)"
          @dragover.prevent="onDragOver(index)"
          @drop.prevent="onDrop(index)"
          @dragend="onDragEnd"
          @click="togglePick(song.uid)"
          @dblclick="!selecting && player.playAt(index)"
        >
          <button v-if="!selecting" class="idx" @click.stop="player.playAt(index)">
            <span v-if="song.uid === currentUid && player.playing" class="eq">
              <i /><i /><i />
            </span>
            <Icon v-else name="play" :size="12" />
          </button>
          <span v-else class="pick" :class="{ on: selected.has(song.uid) }">
            <Icon v-if="selected.has(song.uid)" name="check" :size="11" />
          </span>
          <CoverArt
            :src="song.coverUrl"
            :seed="`${song.platform}:${song.id}`"
            :size="36"
            :radius="8"
            :song="song"
          />
          <div class="text">
            <strong class="truncate">{{ song.name }}</strong>
            <small class="truncate">{{ song.artists.join(' / ') }}</small>
          </div>
          <span class="dur">{{ formatDuration(song.duration) }}</span>
          <span v-if="!selecting" class="acts">
            <button
              class="act fav"
              :class="{ on: playlists.isFavorite(song) }"
              :title="playlists.isFavorite(song) ? '取消收藏' : '收藏到我喜欢'"
              @click.stop="playlists.toggleFavorite(song)"
            >
              <Icon :name="playlists.isFavorite(song) ? 'heart-filled' : 'heart'" :size="14" />
            </button>
            <button class="act" title="加入歌单" @click.stop="playlists.openPicker(song)">
              <Icon name="playlist-add" :size="14" />
            </button>
            <button class="act" title="下载" @click.stop="downloadSong(song)">
              <Icon name="download" :size="14" />
            </button>
            <button class="act" title="搜索这首歌（歌名 + 歌手）" @click.stop="searchSong(song)">
              <Icon name="search" :size="14" />
            </button>
            <button class="act" title="移出队列" @click.stop="player.removeAt(index)">
              <Icon name="trash" :size="14" />
            </button>
          </span>
        </div>

        <div v-if="!player.queue.length" class="empty">
          <strong>队列是空的</strong>
          <span>在歌曲上点「下一首播放」或双击任意列表</span>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped>
.drawer {
  position: fixed;
  right: 16px;
  bottom: calc(var(--player) + 6px);
  /* 420：留出行内 5 个操作图标的位置后，歌名仍有 150px 左右 */
  width: 420px;
  /* 手机窄屏（≤640px）不能超出视口，留出左右 12px 呼吸 */
  max-width: calc(100vw - 24px);
  max-height: min(62vh, 560px);
  border-radius: 20px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  /* 近实心底：0.72 的半透明叠在亮色页面上会糊成灰，正文对比度直接掉没 */
  background: var(--overlay-bg);
  border: 1px solid var(--overlay-border);
  backdrop-filter: blur(26px) saturate(1.4);
  -webkit-backdrop-filter: blur(26px) saturate(1.4);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 10px 18px;
  border-bottom: 1px solid var(--border);
}
.head strong {
  font-size: 14px;
}
.head small {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-2);
}
/* 头部图标按钮的「开启」态（多选） */
.icon-btn.on {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.list {
  overflow-y: auto;
  padding: 8px;
  flex: 1;
}

.item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 12px;
  transition: background 0.16s;
}
.item:hover {
  background: var(--row-hover);
}
/* 正在播放：整行强调色底 + 左侧竖条。只染歌名时在一片灰里根本指不出是哪一行 */
.item.playing {
  background: var(--row-active);
}
.item.playing::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 9px;
  bottom: 9px;
  width: 2px;
  border-radius: 999px;
  background: var(--accent);
}
.item.playing .text strong {
  /* 混 text 而不是纯白：浅色主题下才不会糊成一片浅色 */
  color: color-mix(in srgb, var(--accent) 80%, var(--text));
}

/* 拖拽重排：拖动项淡出，落点在顶部画一条高亮线（比整块描边更接近「插到这里」） */
.item[draggable='true'] {
  cursor: grab;
}
.item.dragging {
  opacity: 0.35;
}
.item.drop-target {
  box-shadow: inset 0 2px 0 var(--accent);
}

/* 多选态：整行可点，选中行用强调色底标出来 */
.item.selecting {
  cursor: pointer;
}
.item.picked {
  background: var(--row-active);
}
.item.picked .text strong {
  color: color-mix(in srgb, var(--accent) 80%, var(--text));
}

.pick {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  display: grid;
  place-items: center;
  color: #fff;
  transition: background 0.12s, border-color 0.12s;
}
.pick.on {
  background: var(--accent);
  border-color: var(--accent);
}

/* 批量条：和头部区分开，只在多选时出现 */
.bulk {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
}
.bulk-all {
  height: 24px;
  padding: 0 8px;
  border-radius: 7px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 11px;
}
.bulk-all:hover {
  background: var(--panel-strong);
  color: var(--text);
}
.bulk-count {
  color: var(--text-3);
}
.bulk-acts {
  margin-left: auto;
  display: flex;
  gap: 6px;
}
.bulk-acts button {
  height: 24px;
  padding: 0 9px;
  border-radius: 7px;
  border: 1px solid var(--border);
  color: var(--text-2);
  font-size: 11px;
}
.bulk-acts button:hover:not(:disabled) {
  background: var(--panel-strong);
  color: var(--text);
}
.bulk-acts button:disabled {
  opacity: 0.38;
  cursor: default;
}


.idx {
  width: 22px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.eq {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.eq i {
  width: 2px;
  background: var(--accent);
  border-radius: 2px;
  animation: bounce 0.9s ease-in-out infinite;
}
.eq i:nth-child(1) {
  height: 5px;
  animation-delay: 0s;
}
.eq i:nth-child(2) {
  height: 11px;
  animation-delay: 0.18s;
}
.eq i:nth-child(3) {
  height: 7px;
  animation-delay: 0.36s;
}
@keyframes bounce {
  0%,
  100% {
    transform: scaleY(0.5);
  }
  50% {
    transform: scaleY(1);
  }
}

.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.text strong {
  font-size: 12.5px;
  font-weight: 500;
}
.text small {
  font-size: 10.5px;
  /* 歌手从 0.4 提到 0.66：小字再叠低透明度，等于看不见 */
  color: var(--text-2);
}

.dur {
  font-size: 10.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

/* 行内操作：与歌曲列表同一套图标，悬停才浮出（行宽只够 5 个 22px） */
.acts {
  flex: none;
  display: flex;
  align-items: center;
  gap: 1px;
  opacity: 0;
  transition: opacity 0.14s;
}
.item:hover .acts {
  opacity: 1;
}
.act {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-2);
  transition: color 0.14s, background 0.14s;
}
.act:hover {
  color: var(--text);
  background: var(--panel-strong);
}
.act.fav.on {
  color: var(--accent);
}

.slide-enter-active,
.slide-leave-active {
  transition: all 0.26s var(--ease);
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateX(24px) translateY(8px);
}
</style>
