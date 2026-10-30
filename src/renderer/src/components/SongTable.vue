<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Song } from '@shared/types'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { formatBytes, formatDuration } from '@shared/lyric'
import { usePlayerStore } from '../stores/player'
import { useDownloadStore } from '../stores/download'
import { usePlaylistStore } from '../stores/playlists'
import { useLibraryStore } from '../stores/library'
import { useAppStore } from '../stores/app'

const props = withDefaults(
  defineProps<{
    songs: Song[]
    loading?: boolean
    showAlbum?: boolean
    showPlatform?: boolean
    /** 显示文件大小列；平台不返回 fileSize 时显示 — */
    showSize?: boolean
    removable?: boolean
    /** 移除按钮的提示文案（本地库里它是「删除文件」，歌单里是「移出歌单」） */
    removeTitle?: string
    /** 显示「编辑信息」按钮（只给本地库用） */
    editable?: boolean
    /** 显示多选列与批量下载工具条 */
    selectable?: boolean
    /** 列头可点击排序（排序本身由父组件做，这里只发事件） */
    sortable?: boolean
    sortKey?: string
    sortDir?: 'asc' | 'desc'
    /** 显示「更多操作」按钮（本地库用它挂复制/导出/删除） */
    menuable?: boolean
    /** 歌单排序模式：每行显示上移/下移按钮，隐藏收藏等操作避免挤爆 */
    moveable?: boolean
    emptyTitle?: string
    emptyHint?: string
  }>(),
  {
    loading: false,
    showAlbum: true,
    showPlatform: false,
    showSize: false,
    removable: false,
    removeTitle: '从列表中移除',
    editable: false,
    selectable: false,
    sortable: false,
    sortKey: '',
    sortDir: 'desc',
    menuable: false,
    moveable: false,
    emptyTitle: '暂无歌曲',
    emptyHint: '换个关键词或切换音源试试'
  }
)

const emit = defineEmits<{
  remove: [song: Song]
  edit: [song: Song]
  move: [song: Song, direction: 'up' | 'down']
  sort: [key: string]
  /** 打开行菜单：第三项是这次要操作的对象（右键多选时是整批） */
  menu: [song: Song, event: MouseEvent, selection: Song[]]
}>()

const player = usePlayerStore()
const download = useDownloadStore()
const playlists = usePlaylistStore()
const library = useLibraryStore()
const app = useAppStore()

/** 已下载集合：搜索/榜单里标出哪些歌已在本地库，避免重复下载 */
const downloadedKeys = computed(
  () => new Set(library.items.map((item) => `${item.song.platform}:${item.song.id}`))
)

function isDownloaded(song: Song): boolean {
  return downloadedKeys.value.has(keyOf(song))
}

function onDownloadClick(song: Song): void {
  if (isDownloaded(song)) {
    app.toast('这首歌已在音乐库里', 'info')
    return
  }
  void download.enqueue(song)
}

const selected = ref<Set<string>>(new Set())
/** Shift 范围选：记住上一次点击的行号 */
const lastIndex = ref(-1)

const currentKey = computed(() =>
  player.current ? `${player.current.platform}:${player.current.id}` : ''
)

const selectedSongs = computed(() => props.songs.filter((song) => selected.value.has(keyOf(song))))
const allSelected = computed(
  () => props.songs.length > 0 && selectedSongs.value.length === props.songs.length
)

function keyOf(song: Song): string {
  return `${song.platform}:${song.id}`
}

function toggleSelect(song: Song, index: number, event?: MouseEvent): void {
  const key = keyOf(song)
  const next = new Set(selected.value)
  if (event?.shiftKey && lastIndex.value >= 0) {
    const from = Math.min(lastIndex.value, index)
    const to = Math.max(lastIndex.value, index)
    const shouldSelect = !selected.value.has(key)
    for (let i = from; i <= to; i += 1) {
      const current = props.songs[i]
      if (!current) continue
      if (shouldSelect) next.add(keyOf(current))
      else next.delete(keyOf(current))
    }
  } else if (next.has(key)) {
    next.delete(key)
  } else {
    next.add(key)
  }
  selected.value = next
  lastIndex.value = index
}

function clearSelection(): void {
  selected.value = new Set()
  lastIndex.value = -1
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(props.songs.map(keyOf))
}

defineExpose({ clearSelection })

/**
 * 菜单入口：右键行，或点行尾「更多」。
 * 右键已选中的行 → 对整批操作；右键未选中的行 → 先清掉旧选择，只对这一行，
 * 避免「看着选中 3 首、菜单却只删 1 首」这种歧义。
 */
function openRowMenu(song: Song, event: MouseEvent): void {
  const key = keyOf(song)
  if (props.selectable && selected.value.size && !selected.value.has(key)) clearSelection()
  const selection =
    props.selectable && selected.value.has(key) && selected.value.size > 1 ? selectedSongs.value : [song]
  emit('menu', song, event, selection)
}

function downloadSelected(): void {
  void download.enqueueMany(selectedSongs.value)
  selected.value = new Set()
}

function downloadAll(): void {
  void download.enqueueMany(props.songs)
}

function play(index: number): void {
  player.setQueue(props.songs, index)
}

function addNext(song: Song): void {
  player.playNext(song)
}

function toggleFavorite(song: Song): void {
  void playlists.toggleFavorite(song)
}

/** VIP 角标：平台明确标记付费，或平台侧标记不可直接播放 */
function isVip(song: Song): boolean {
  return song.vip === true || song.streamable === false
}

/** 音质角标文案：优先结构化档位（SQ=无损 / HQ=320k），引擎音源回退到码率描述 */
function qualityBadge(song: Song): string {
  if (song.qualityMax === 'lossless') return 'SQ'
  if (song.qualityMax === 'high') return 'HQ'
  return song.qualityLabel ?? ''
}
</script>

<template>
  <div class="table" :class="{ selectable, moveable }">
    <div v-if="selectable" class="bulk">
      <button class="btn" @click="toggleAll">
        <Icon :name="allSelected ? 'close' : 'check'" :size="13" />
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
      <span class="bulk-count">{{ selectedSongs.length }} / {{ songs.length }} 首</span>
      <!-- 默认是搜索页的批量下载；本地库用自己的操作条覆盖这个插槽 -->
      <slot name="bulk" :selected="selectedSongs" :clear="clearSelection">
        <button class="btn primary" :disabled="!selectedSongs.length" @click="downloadSelected">
          <Icon name="download" :size="13" /> 下载选中
        </button>
        <button class="btn" :disabled="!songs.length" @click="downloadAll">
          <Icon name="download" :size="13" /> 全部下载
        </button>
      </slot>
    </div>

    <div class="head">
      <span v-if="selectable" class="c-check" />
      <span class="c-index">#</span>
      <span class="c-title" :class="{ 'sort-cell': sortable }" @click="sortable && emit('sort', 'name')">
        标题
        <em v-if="sortable && sortKey === 'name'" class="arrow">{{ sortDir === 'asc' ? '↑' : '↓' }}</em>
      </span>
      <span
        v-if="showAlbum"
        class="c-album"
        :class="{ 'sort-cell': sortable }"
        @click="sortable && emit('sort', 'album')"
      >
        专辑
        <em v-if="sortable && sortKey === 'album'" class="arrow">{{ sortDir === 'asc' ? '↑' : '↓' }}</em>
      </span>
      <span v-if="showPlatform" class="c-platform">音源</span>
      <span class="c-dur" :class="{ 'sort-cell': sortable }" @click="sortable && emit('sort', 'duration')">
        时长
        <em v-if="sortable && sortKey === 'duration'" class="arrow">{{ sortDir === 'asc' ? '↑' : '↓' }}</em>
      </span>
      <span v-if="showSize" class="c-size" :class="{ 'sort-cell': sortable }" @click="sortable && emit('sort', 'size')">
        大小
        <em v-if="sortable && sortKey === 'size'" class="arrow">{{ sortDir === 'asc' ? '↑' : '↓' }}</em>
      </span>
      <span class="c-actions" />
    </div>

    <!-- 没有结果时才铺骨架；已经流式吐出歌曲时就别盖住 -->
    <template v-if="loading && !songs.length">
      <div v-for="i in 8" :key="i" class="skeleton-row">
        <span class="skeleton" style="width: 22px; height: 12px" />
        <span class="skeleton" style="width: 38px; height: 38px; border-radius: 9px" />
        <span class="skeleton" style="width: 34%; height: 12px" />
        <span class="skeleton" style="width: 18%; height: 12px" />
      </div>
    </template>

    <template v-else-if="songs.length">
      <div
        v-for="(song, index) in songs"
        :key="keyOf(song) + index"
        class="row"
        :class="{
          playing: keyOf(song) === currentKey,
          picked: selected.has(keyOf(song)),
          missing: !!song.extra?.missing
        }"
        @dblclick="play(index)"
        @contextmenu.prevent="openRowMenu(song, $event)"
      >
        <span v-if="selectable" class="c-check">
          <button
            class="pick"
            :class="{ on: selected.has(keyOf(song)) }"
            :title="selected.has(keyOf(song)) ? '取消选择' : '选择（Shift 可连选）'"
            @click.stop="toggleSelect(song, index, $event)"
          >
            <Icon v-if="selected.has(keyOf(song))" name="check" :size="11" />
          </button>
        </span>

        <span class="c-index">
          <span v-if="keyOf(song) === currentKey && player.playing" class="eq">
            <i /><i /><i /><i />
          </span>
          <template v-else>
            <span class="num">{{ String(index + 1).padStart(2, '0') }}</span>
            <button class="play-mini" @click.stop="play(index)">
              <Icon name="play" :size="12" />
            </button>
          </template>
        </span>

        <div class="c-title">
          <CoverArt
            :src="song.coverUrl"
            :seed="keyOf(song)"
            :size="38"
            :radius="9"
            :song="song"
          />
          <div class="title-text">
            <div class="t-line">
              <strong class="truncate">{{ song.name }}</strong>
              <em v-if="song.extra?.missing" class="badge miss" title="文件已不在磁盘上，可用「重新定位」找回">缺失</em>
              <em v-if="isVip(song)" class="badge vip" title="VIP 曲目：登录后可播放完整版本">VIP</em>
              <em v-if="qualityBadge(song)" class="badge q-badge" :class="{ sq: song.qualityMax === 'lossless' }">
                {{ qualityBadge(song) }}
              </em>
            </div>
            <small class="truncate">{{ song.artists.join(' / ') || '未知歌手' }}</small>
          </div>
        </div>

        <span v-if="showAlbum" class="c-album truncate">{{ song.album || '—' }}</span>
        <span v-if="showPlatform" class="c-platform">
          <em class="plat">{{ song.platform }}</em>
        </span>

        <span class="c-dur">
          {{ formatDuration(song.duration) }}
        </span>

        <span v-if="showSize" class="c-size">
          {{ song.fileSize ? formatBytes(song.fileSize) : '—' }}
        </span>

        <span class="c-actions">
          <button
            v-if="!moveable"
            class="fav"
            :class="{ active: playlists.isFavorite(song) }"
            :title="playlists.isFavorite(song) ? '取消收藏' : '收藏到我喜欢'"
            @click.stop="toggleFavorite(song)"
          >
            <Icon :name="playlists.isFavorite(song) ? 'heart-filled' : 'heart'" :size="15" />
          </button>
          <button v-if="moveable" class="mv" title="上移" @click.stop="emit('move', song, 'up')">
            ↑
          </button>
          <button v-if="moveable" class="mv" title="下移" @click.stop="emit('move', song, 'down')">
            ↓
          </button>
          <button v-if="!moveable" title="加入歌单" @click.stop="playlists.openPicker(song)">
            <Icon name="playlist-add" :size="15" />
          </button>
          <button v-if="!moveable" title="下一首播放" @click.stop="addNext(song)">
            <Icon name="plus" :size="15" />
          </button>
          <button v-if="editable" title="编辑歌曲信息" @click.stop="emit('edit', song)">
            <Icon name="pencil" :size="15" />
          </button>
          <button
            v-else-if="!moveable"
            :class="{ done: isDownloaded(song) }"
            :title="isDownloaded(song) ? '已在音乐库' : '下载'"
            @click.stop="onDownloadClick(song)"
          >
            <Icon :name="isDownloaded(song) ? 'check' : 'download'" :size="15" />
          </button>
          <button v-if="removable" :title="removeTitle" @click.stop="emit('remove', song)">
            <Icon name="trash" :size="15" />
          </button>
          <button v-if="menuable" title="更多操作" @click.stop="openRowMenu(song, $event)">
            <Icon name="more" :size="15" />
          </button>
        </span>
      </div>

      <div v-if="loading" class="stream-row">
        <span class="pulse" />
        还在解析剩下的歌曲…
      </div>
    </template>

    <div v-else class="empty">
      <strong>{{ emptyTitle }}</strong>
      <span>{{ emptyHint }}</span>
    </div>
  </div>
</template>

<style scoped>
.table {
  width: 100%;
}

.head,
.row {
  display: grid;
  grid-template-columns: 46px minmax(0, 2.4fr) minmax(0, 1.3fr) 92px 112px;
  align-items: center;
  gap: 12px;
}

.head:has(.c-platform) {
  grid-template-columns: 46px minmax(0, 2.2fr) minmax(0, 1.2fr) 76px 92px 112px;
}

/* 大小列：64px，插在时长与操作列之间 */
.head:has(.c-size),
.row:has(.c-size) {
  grid-template-columns: 46px minmax(0, 2.4fr) minmax(0, 1.3fr) 92px 64px 112px;
}

/* 多选列：只在 selectable 时插入一列 24px */
.table.selectable .head,
.table.selectable .row {
  grid-template-columns: 24px 46px minmax(0, 2.4fr) minmax(0, 1.3fr) 92px 112px;
}
.table.selectable .head:has(.c-platform),
.table.selectable .row:has(.c-platform) {
  grid-template-columns: 24px 46px minmax(0, 2.2fr) minmax(0, 1.2fr) 76px 92px 112px;
}
.table.selectable .head:has(.c-size),
.table.selectable .row:has(.c-size) {
  grid-template-columns: 24px 46px minmax(0, 2.4fr) minmax(0, 1.3fr) 92px 64px 112px;
}

.bulk {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  row-gap: 8px;
  padding: 0 12px 10px;
}
.bulk-count {
  margin-right: auto;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.bulk .btn {
  height: 28px;
  padding: 0 11px;
  font-size: 11.5px;
}

.c-check {
  display: flex;
  align-items: center;
  justify-content: center;
}
.pick {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  background: var(--panel);
  color: #fff;
  cursor: pointer;
  transition: all 0.15s var(--ease);
}
.pick:hover {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
}
.pick.on {
  background: var(--accent);
  border-color: var(--accent);
}
.row.picked {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.head {
  padding: 0 12px 10px;
  font-size: 11px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
  letter-spacing: 0.4px;
}

.row {
  padding: 7px 12px;
  border-radius: 12px;
  transition: background 0.16s var(--ease);
  cursor: default;
}
.row:hover {
  /* --panel 只有 4.5% 白，深色底上几乎看不出；用 --text 混合保持两套主题都可见 */
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.row.playing {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.row.playing .title-text strong {
  color: color-mix(in srgb, var(--accent) 72%, #fff);
}

.c-index {
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  display: flex;
  align-items: center;
  justify-content: center;
}

.num {
  display: block;
}
.play-mini {
  display: none;
  color: var(--text);
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--border-strong);
  place-items: center;
}
.row:hover .num {
  display: none;
}
.row:hover .play-mini {
  display: grid;
}

.eq {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}
.eq i {
  width: 2px;
  background: var(--accent);
  border-radius: 2px;
  animation: bounce 0.9s ease-in-out infinite;
}
.eq i:nth-child(1) {
  height: 6px;
}
.eq i:nth-child(2) {
  height: 12px;
  animation-delay: 0.15s;
}
.eq i:nth-child(3) {
  height: 8px;
  animation-delay: 0.3s;
}
.eq i:nth-child(4) {
  height: 13px;
  animation-delay: 0.45s;
}
@keyframes bounce {
  0%,
  100% {
    transform: scaleY(0.45);
  }
  50% {
    transform: scaleY(1);
  }
}

.c-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.title-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.t-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.t-line strong {
  font-size: 13px;
  font-weight: 500;
  min-width: 0;
}
.title-text small {
  font-size: 11px;
  color: var(--text-3);
}

.badge {
  flex: none;
  font-style: normal;
  font-size: 9px;
  line-height: 1;
  padding: 2.5px 4.5px;
  border-radius: 4px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
/* VIP：琥珀金实底，一眼可辨 */
.badge.vip {
  background: linear-gradient(135deg, #f7b733, #e8890c);
  color: #2b1a02;
}
/* 音质：描边样式；SQ（无损）用金色描边加重 */
.badge.q-badge {
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  color: color-mix(in srgb, var(--accent) 80%, #fff);
}
.badge.q-badge.sq {
  border-color: rgba(230, 194, 104, 0.65);
  color: #e6c268;
}
/* 缺失：灰底，提醒这行播不了 */
.badge.miss {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-3);
}
.row.missing .title-text strong,
.row.missing .c-album,
.row.missing .c-dur,
.row.missing .c-size {
  opacity: 0.55;
}

/* 可排序的列头 */
.sort-cell {
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}
.sort-cell:hover {
  color: var(--text);
}
.sort-cell .arrow {
  margin-left: 3px;
  font-style: normal;
  font-size: 10px;
  color: var(--accent);
}

.c-album {
  font-size: 11.5px;
  color: var(--text-3);
}

.c-dur {
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}

.c-size {  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.plat {
  font-style: normal;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel-strong);
  color: var(--text-2);
}

.c-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.row:hover .c-actions {
  opacity: 1;
}
/* 排序模式：↑↓ 是主要操作，不能等 hover 才出现 */
.table.moveable .c-actions {
  opacity: 1;
}
.c-actions button {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  color: var(--text-2);
}
.c-actions button:hover {
  background: var(--border-strong);
  color: var(--text);
}

.c-actions .fav.active {
  color: var(--accent);
}
.c-actions .fav.active :deep(svg) {
  filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 60%, transparent));
}

/* 已下载：用绿色对勾替代下载图标，一眼看出哪些不用再下 */
.c-actions button.done {
  color: #3ddc97;
}
/* 歌单排序模式的 ↑↓ 按钮 */
.c-actions .mv {
  font-size: 15px;
  line-height: 1;
  color: var(--text-2);
}
.c-actions .mv:hover {
  color: var(--accent);
}

.skeleton-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px;
}

/* 流式搜索的收尾提示：已有结果但引擎还在解析剩下的 */
.stream-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 12px 6px;
  font-size: 11.5px;
  color: var(--text-3);
}

.stream-row .pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent);
  animation: stream-pulse 1.4s ease-in-out infinite;
}

@keyframes stream-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

/* ---------------- 移动端（≤640px）：行卡片布局 ----------------
   隐藏序号/专辑/音源/大小列，歌名区独占 1fr 保证完整可读；
   操作按钮常显（触屏没有 hover），时长保留。 */
@media (max-width: 640px) {
  .head {
    display: none;
  }

  .row,
  .row:has(.c-platform),
  .row:has(.c-size) {
    grid-template-columns: minmax(0, 1fr) auto auto;
    gap: 8px;
    padding: 9px 10px;
  }
  .table.selectable .row,
  .table.selectable .row:has(.c-platform),
  .table.selectable .row:has(.c-size) {
    grid-template-columns: 24px minmax(0, 1fr) auto auto;
  }

  .c-index,
  .c-album,
  .c-platform,
  .c-size {
    display: none;
  }

  .row:hover .num {
    display: block;
  }
  .row:hover .play-mini {
    display: none;
  }

  .c-title {
    gap: 10px;
  }

  .c-actions {
    opacity: 1;
  }
  .c-actions button {
    width: 30px;
    height: 30px;
  }

  .bulk {
    flex-wrap: wrap;
  }
}
</style>
