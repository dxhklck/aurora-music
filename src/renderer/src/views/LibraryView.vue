<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { DuplicateGroup, LibraryOpReport, LibraryTrack, Song } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Icon from '../components/Icon.vue'
import { useLibraryStore } from '../stores/library'
import { useDownloadStore } from '../stores/download'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { formatBytes } from '@shared/lyric'

const library = useLibraryStore()
const download = useDownloadStore()
const player = usePlayerStore()
const app = useAppStore()
const dir = ref('')
const tableRef = ref<InstanceType<typeof SongTable> | null>(null)

/* ---------------- 搜索 / 筛选 / 排序 ---------------- */

type SortKey = 'added' | 'name' | 'artist' | 'album' | 'duration' | 'size' | 'ext'

const SORT_LABELS: Record<SortKey, string> = {
  added: '添加时间',
  name: '歌名',
  artist: '歌手',
  album: '专辑',
  duration: '时长',
  size: '大小',
  ext: '格式'
}

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

const keyword = ref('')
const filterArtist = ref('')
const filterAlbum = ref('')
const filterExt = ref('')
const filterFolder = ref('')
/** 来源：下载目录里的是应用下回来的，其余是用户导入的 */
const sourceFilter = ref<'' | 'download' | 'imported'>('')
const sortKey = ref<SortKey>('added')
const sortDir = ref<'asc' | 'desc'>('desc')

const artists = computed(() => {
  const set = new Set<string>()
  for (const item of library.items) for (const name of item.song.artists) if (name) set.add(name)
  return [...set].sort(collator.compare)
})

const albums = computed(() => {
  const set = new Set<string>()
  for (const item of library.items) {
    if (filterArtist.value && !item.song.artists.includes(filterArtist.value)) continue
    if (item.song.album) set.add(item.song.album)
  }
  return [...set].sort(collator.compare)
})

const exts = computed(() => [...new Set(library.items.map((item) => item.ext).filter(Boolean))].sort())

/** 所在文件夹：下载目录与导入目录常常混在一起，按目录收敛比翻列表快 */
const folders = computed(() => {
  const map = new Map<string, string>()
  for (const item of library.items) {
    const dir = dirOf(item.filePath)
    if (dir) map.set(dir, dir.split(/[\\/]/).pop() || dir)
  }
  return [...map.entries()].sort((a, b) => collator.compare(a[1], b[1]))
})

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
  return index > 0 ? path.slice(0, index) : ''
}

const hasFilter = computed(
  () =>
    !!(
      keyword.value.trim() ||
      filterArtist.value ||
      filterAlbum.value ||
      filterExt.value ||
      filterFolder.value ||
      sourceFilter.value
    )
)

function clearFilters(): void {
  keyword.value = ''
  filterArtist.value = ''
  filterAlbum.value = ''
  filterExt.value = ''
  filterFolder.value = ''
  sourceFilter.value = ''
}

function onArtistChange(): void {
  if (filterAlbum.value && !albums.value.includes(filterAlbum.value)) filterAlbum.value = ''
}

/** 空值（空专辑 / 时长未知）不参与比较，永远沉底 */
function isBlank(track: LibraryTrack): boolean {
  if (sortKey.value === 'album') return !track.song.album
  if (sortKey.value === 'artist') return !track.song.artists.length
  if (sortKey.value === 'duration') return !track.song.duration
  return false
}

function compareTracks(a: LibraryTrack, b: LibraryTrack): number {
  switch (sortKey.value) {
    case 'name':
      return collator.compare(a.song.name, b.song.name)
    case 'artist':
      return collator.compare(a.song.artists.join('/'), b.song.artists.join('/'))
    case 'album':
      return collator.compare(a.song.album, b.song.album)
    case 'duration':
      return a.song.duration - b.song.duration
    case 'size':
      return a.size - b.size
    case 'ext':
      return collator.compare(a.ext, b.ext)
    default:
      return a.downloadedAt - b.downloadedAt
  }
}

/** 导入条目的 id 是 local:<绝对路径>，下载条目是 <平台>:<songId>；比路径判断稳，改了下载目录也不会串 */
function isImported(item: LibraryTrack): boolean {
  return item.id.startsWith('local:')
}

const filtered = computed(() => {
  const key = keyword.value.trim().toLowerCase()
  const rows = library.items.filter((item) => {
    if (filterArtist.value && !item.song.artists.includes(filterArtist.value)) return false
    if (filterAlbum.value && item.song.album !== filterAlbum.value) return false
    if (filterExt.value && item.ext !== filterExt.value) return false
    if (filterFolder.value && dirOf(item.filePath) !== filterFolder.value) return false
    if (sourceFilter.value === 'download' && isImported(item)) return false
    if (sourceFilter.value === 'imported' && !isImported(item)) return false
    if (!key) return true
    return (
      item.song.name.toLowerCase().includes(key) ||
      item.song.album.toLowerCase().includes(key) ||
      item.song.artists.join(' ').toLowerCase().includes(key) ||
      item.fileName.toLowerCase().includes(key) ||
      item.filePath.toLowerCase().includes(key)
    )
  })
  const direction = sortDir.value === 'asc' ? 1 : -1
  return rows.sort((a, b) => {
    const blankA = isBlank(a)
    const blankB = isBlank(b)
    if (blankA !== blankB) return blankA ? 1 : -1
    return compareTracks(a, b) * direction
  })
})

const songs = computed<Song[]>(() =>
  filtered.value.map((item) => ({
    ...item.song,
    platform: 'local',
    id: item.id,
    fileSize: item.size,
    qualityLabel: item.qualityLabel ?? item.ext.toUpperCase(),
    extra: { filePath: item.filePath, missing: item.missing ? 1 : 0 }
  }))
)

function toggleSort(key: string): void {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
    return
  }
  sortKey.value = key as SortKey
  sortDir.value = key === 'added' ? 'desc' : 'asc'
}

/* ---------------- 删除判定 ---------------- */

const norm = (path: string): string => path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

const downloadKey = computed(() => norm(dir.value))

/** 保守策略：只有下载目录里的文件才允许真删，导入目录是用户的原始文件 */
function inDownloadDir(track: LibraryTrack): boolean {
  const root = downloadKey.value
  return !!root && norm(track.filePath).startsWith(`${root}/`)
}

function trackOf(song: Song): LibraryTrack | undefined {
  return library.items.find((item) => item.id === song.id)
}

function tracksOf(list: Song[]): LibraryTrack[] {
  return list.map(trackOf).filter((item): item is LibraryTrack => !!item)
}

/* ---------------- 删除确认 ---------------- */

const confirmOpen = ref(false)
const confirmMode = ref<'delete' | 'remove'>('delete')
const pending = ref<LibraryTrack[]>([])
const busy = ref(false)
const report = ref<LibraryOpReport | null>(null)

const pendingDeletable = computed(() => pending.value.filter((item) => inDownloadDir(item)))
const pendingImported = computed(() => pending.value.filter((item) => !inDownloadDir(item)))
const pendingSize = computed(() =>
  pendingDeletable.value.reduce((sum, item) => sum + (item.missing ? 0 : item.size), 0)
)

const confirmText = computed(() => {
  if (confirmMode.value === 'remove' || !pendingDeletable.value.length) {
    return `从库移除 ${pending.value.length} 首`
  }
  if (!pendingImported.value.length) return `删除 ${pendingDeletable.value.length} 个文件`
  return `删除 ${pendingDeletable.value.length} 个 · 移除 ${pendingImported.value.length} 个`
})

function requestDelete(items: LibraryTrack[]): void {
  if (!items.length) return
  confirmMode.value = 'delete'
  pending.value = items
  confirmOpen.value = true
}

function requestRemove(items: LibraryTrack[]): void {
  if (!items.length) return
  // 单首「仅移除」不动磁盘，不必拦一道确认；批量才需要看清楚选了哪些
  if (items.length === 1) {
    void library.remove(items[0].id)
    tableRef.value?.clearSelection()
    return
  }
  confirmMode.value = 'remove'
  pending.value = items
  confirmOpen.value = true
}

async function runConfirm(): Promise<void> {
  const items = pending.value
  if (!items.length) return
  busy.value = true
  try {
    const ids = items.map((item) => item.id)
    // 正在播的文件在 Windows 上被句柄占用，先停再删
    if (player.current && ids.includes(player.current.id)) player.stop()
    const result =
      confirmMode.value === 'delete' ? await library.deleteFiles(ids) : await library.removeMany(ids)
    confirmOpen.value = false
    tableRef.value?.clearSelection()
    if (result?.failed) report.value = result
  } finally {
    busy.value = false
    pending.value = []
  }
}

/* ---------------- 行菜单 ---------------- */

const menu = ref<{ x: number; y: number; song: Song; items: LibraryTrack[] } | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const menuHeight = ref(0)

const menuStyle = computed(() => {
  const width = 210
  const x = Math.min(menu.value?.x ?? 0, window.innerWidth - width - 8)
  // 项数不定（单首多几个播放项，多选少几个），渲染出来量一次再决定往上还是往下
  const y = Math.min(menu.value?.y ?? 0, window.innerHeight - (menuHeight.value || 360) - 8)
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` }
})

function openMenu(song: Song, event: MouseEvent, selection: Song[]): void {
  const items = selection.map(trackOf).filter((item): item is LibraryTrack => !!item)
  if (!items.length) return
  // 键盘触发（Enter/空格）时 clientX/Y 恒为 0，退回到按钮自身的包围盒
  let x = event.clientX
  let y = event.clientY
  if (!x && !y) {
    const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect()
    if (rect) {
      x = rect.right - 8
      y = rect.bottom + 4
    }
  }
  menu.value = { x, y, song, items }
  void nextTick(() => {
    menuHeight.value = menuEl.value?.offsetHeight ?? 0
  })
}

function closeMenu(): void {
  menu.value = null
}

function playItem(song: Song): void {
  const index = filtered.value.findIndex((row) => row.id === song.id)
  if (index >= 0) player.setQueue(songs.value, index)
  closeMenu()
}

function playNextItem(song: Song): void {
  player.playNext(song)
  closeMenu()
}

async function copyFiles(items: LibraryTrack[]): Promise<void> {
  closeMenu()
  await library.copyFiles(items.map((item) => item.id))
}

/** 批量改标签：只动歌手/专辑，留空的字段保持不变 */
const metaOpen = ref(false)
const metaIds = ref<string[]>([])
const metaArtists = ref('')
const metaAlbum = ref('')
const metaBusy = ref(false)

/** 菜单里的危险项文案：全可删就是「删除文件」，混合来源要说清删几个、移除几个 */
const menuDeleteLabel = computed(() => {
  const items = menu.value?.items ?? []
  if (!items.length) return ''
  const deletable = items.filter((item) => inDownloadDir(item)).length
  if (!deletable) return ''
  if (deletable === items.length) return items.length > 1 ? `删除文件（${items.length} 个）` : '删除文件'
  return `删除 ${deletable} 个 · 移除 ${items.length - deletable} 个`
})

function askMeta(items: LibraryTrack[]): void {
  if (!items.length) return
  closeMenu()
  metaIds.value = items.map((item) => item.id)
  metaArtists.value = ''
  metaAlbum.value = ''
  metaOpen.value = true
}

function handleGlobalClick(): void {
  if (menu.value) closeMenu()
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeMenu()
}

onMounted(() => {
  window.addEventListener('click', handleGlobalClick)
  window.addEventListener('keydown', handleKeydown)
})
onUnmounted(() => {
  window.removeEventListener('click', handleGlobalClick)
  window.removeEventListener('keydown', handleKeydown)
})

/* ---------------- 复制 / 导出 ---------------- */

const exportOpen = ref(false)
const exportIds = ref<string[]>([])
const exportTemplate = ref('{artist} - {name}')

function askExport(items: LibraryTrack[]): void {
  if (!items.length) return
  exportIds.value = items.map((item) => item.id)
  exportOpen.value = true
}

async function runExport(): Promise<void> {
  // 展开成普通数组：ref 里的数组是 reactive proxy，直接过 IPC 会「could not be cloned」
  const ids = [...exportIds.value]
  exportOpen.value = false
  if (!ids.length) return
  const result = await library.exportTo(ids, exportTemplate.value)
  if (result?.failed) report.value = result
}

async function copyTracks(items: LibraryTrack[]): Promise<void> {
  if (!items.length) return
  const result = await library.copyTo(items.map((item) => item.id))
  if (result?.failed) report.value = result
}

/* ---------------- 重复文件 ---------------- */

const dupOpen = ref(false)
const dupLoading = ref(false)
const dupGroups = ref<DuplicateGroup[]>([])
const dupSelected = ref<Set<string>>(new Set())

const trackMap = computed(() => new Map(library.items.map((item) => [item.id, item])))

/** 默认保留「体积最大 + 添加最早」的那份，其余勾上 */
function preselect(groups: DuplicateGroup[]): Set<string> {
  const next = new Set<string>()
  for (const group of groups) {
    const items = group.ids
      .map((id) => trackMap.value.get(id))
      .filter((item): item is LibraryTrack => !!item)
    if (items.length < 2) continue
    const sorted = [...items].sort((a, b) => b.size - a.size || a.downloadedAt - b.downloadedAt)
    sorted.slice(1).forEach((item) => next.add(item.id))
  }
  return next
}

async function openDuplicates(): Promise<void> {
  dupOpen.value = true
  await scanDuplicates()
}

async function scanDuplicates(): Promise<void> {
  dupLoading.value = true
  try {
    dupGroups.value = await library.findDuplicates()
    dupSelected.value = preselect(dupGroups.value)
  } finally {
    dupLoading.value = false
  }
}

function toggleDup(id: string): void {
  const next = new Set(dupSelected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  dupSelected.value = next
}

async function cleanDuplicates(): Promise<void> {
  const ids = [...dupSelected.value]
  if (!ids.length) return
  busy.value = true
  try {
    if (player.current && ids.includes(player.current.id)) player.stop()
    const result = await library.deleteFiles(ids)
    if (result?.failed) report.value = result
    await scanDuplicates()
  } finally {
    busy.value = false
  }
}

/* ---------------- 元数据编辑 ---------------- */

const editing = ref<Song | null>(null)
const editName = ref('')
const editArtists = ref('')
const editAlbum = ref('')
const saving = ref(false)

function openEditor(song: Song): void {
  closeMenu()
  editing.value = song
  editName.value = song.name
  editArtists.value = song.artists.join('/')
  editAlbum.value = song.album ?? ''
}

function closeEditor(): void {
  if (saving.value) return
  editing.value = null
}

async function saveEditor(): Promise<void> {
  const song = editing.value
  if (!song) return
  if (!editName.value.trim()) {
    app.toast('歌名不能为空', 'error')
    return
  }
  saving.value = true
  try {
    const updated = await window.api.updateLibraryMeta(song.id, {
      name: editName.value,
      artists: editArtists.value,
      album: editAlbum.value
    })
    if (!updated) {
      app.toast('这条记录已不在库里，刷新后再试', 'error')
      return
    }
    await library.load()
    app.toast('已保存到文件标签与音乐库', 'success')
    editing.value = null
  } catch (error) {
    app.toast(error instanceof Error ? error.message : '保存失败', 'error')
  } finally {
    saving.value = false
  }
}

async function runMeta(): Promise<void> {
  const ids = [...metaIds.value]
  const artists = metaArtists.value.trim()
  const album = metaAlbum.value.trim()
  if (!ids.length) return
  if (!artists && !album) {
    app.toast('歌手和专辑都空着，没有要改的内容', 'info')
    return
  }
  metaBusy.value = true
  try {
    const result = await library.updateMetaMany(ids, {
      ...(artists ? { artists } : {}),
      ...(album ? { album } : {})
    })
    metaOpen.value = false
    tableRef.value?.clearSelection()
    if (result?.failed) report.value = result
  } finally {
    metaBusy.value = false
  }
}

/* ---------------- 进度 ---------------- */
const progress = ref<{ done: number; total: number; current: string } | null>(null)
let stopProgress: (() => void) | null = null

onMounted(async () => {
  await library.load()
  dir.value = await window.api.downloadDir()
  stopProgress = window.api.onLibraryOpProgress((payload) => {
    progress.value = payload.done >= payload.total ? null : payload
  })
})

onUnmounted(() => stopProgress?.())

function openDir(): void {
  void (async () => {
    const result = await window.api.chooseDownloadDir()
    dir.value = result
    app.toast('下载目录已更新', 'success')
  })()
}

function showInFolder(item: LibraryTrack): void {
  closeMenu()
  library.reveal(item.id)
}

function openRecycleBin(): void {
  void window.api.openTrash()
}

function openTargetDir(): void {
  if (report.value?.targetDir) void window.api.openFolder(report.value.targetDir)
}
</script>

<template>
  <div class="library">
    <header class="head">
      <div>
        <h1>本地音乐</h1>
        <p>下载完成的曲目会连同歌词与元数据一起归档，离线也能播放</p>
      </div>
      <div class="head-actions">
        <button class="btn" @click="library.importDir()">
          <Icon name="folder-plus" :size="14" /> 导入本地音乐
        </button>
        <button class="btn" @click="openDir">
          <Icon name="folder" :size="14" /> 下载目录
        </button>
        <button class="btn dup-btn" title="按内容哈希找重复，可批量清理" @click="openDuplicates">
          重复文件
          <em v-if="library.duplicateIds" class="count">{{ library.duplicateIds }}</em>
        </button>
        <button class="btn" title="删除的文件在系统回收站里，可在这里打开" @click="openRecycleBin">
          <Icon name="trash" :size="14" /> 回收站
        </button>
        <button class="btn" @click="library.refresh()">
          <Icon name="refresh" :size="14" /> 刷新
        </button>
      </div>
    </header>

    <div v-if="library.importedDirs.length" class="imported">
      <span class="imported-label">已导入</span>
      <span v-for="folder in library.importedDirs" :key="folder" class="chip">
        <Icon name="folder" :size="12" />
        <span class="truncate" :title="folder">{{ folder }}</span>
        <button class="chip-x" title="不再扫描此目录" @click="library.removeDir(folder)">
          <Icon name="close" :size="11" />
        </button>
      </span>
    </div>

    <div class="stats">
      <div class="stat card">
        <span>曲目</span>
        <strong>{{ library.items.length }}</strong>
        <small>首</small>
      </div>
      <div class="stat card">
        <span>占用空间</span>
        <strong>{{ formatBytes(library.totalSize) }}</strong>
      </div>
      <div class="stat card">
        <span>下载中</span>
        <strong>{{ download.active.length }}</strong>
        <small>个任务</small>
      </div>
      <div class="stat card path">
        <span>存放位置</span>
        <small class="truncate">{{ dir || '—' }}</small>
      </div>
    </div>

    <div v-if="library.missingCount" class="banner">
      <span>
        <strong>{{ library.missingCount }}</strong> 个文件已不在原位置（移动过文件夹，或外接盘未接入？）
      </span>
      <div class="banner-actions">
        <button class="btn" @click="library.relocate()">重新定位</button>
        <button class="btn" @click="library.purgeMissing()">清理条目</button>
      </div>
    </div>

    <div class="toolbar">
      <label class="search">
        <Icon name="search" :size="14" />
        <input v-model="keyword" placeholder="搜索歌名 / 歌手 / 专辑 / 文件名" />
        <button v-if="keyword" class="clear" title="清空" @click="keyword = ''">
          <Icon name="close" :size="11" />
        </button>
      </label>

      <div class="seg" title="按来源筛选">
        <button :class="{ on: sourceFilter === '' }" @click="sourceFilter = ''">全部</button>
        <button :class="{ on: sourceFilter === 'download' }" @click="sourceFilter = 'download'">
          下载
        </button>
        <button :class="{ on: sourceFilter === 'imported' }" @click="sourceFilter = 'imported'">
          导入
        </button>
      </div>

      <select v-model="filterArtist" class="sel" title="按歌手筛选" @change="onArtistChange">
        <option value="">全部歌手</option>
        <option v-for="name in artists" :key="name" :value="name">{{ name }}</option>
      </select>

      <select v-model="filterAlbum" class="sel" title="按专辑筛选">
        <option value="">全部专辑</option>
        <option v-for="name in albums" :key="name" :value="name">{{ name }}</option>
      </select>

      <select v-model="filterExt" class="sel" title="按格式筛选">
        <option value="">全部格式</option>
        <option v-for="ext in exts" :key="ext" :value="ext">{{ ext.toUpperCase() }}</option>
      </select>

      <select v-model="filterFolder" class="sel" title="按所在文件夹筛选">
        <option value="">全部文件夹</option>
        <option v-for="[path, label] in folders" :key="path" :value="path" :title="path">
          {{ label }}
        </option>
      </select>

      <button v-if="hasFilter" class="btn ghost" @click="clearFilters">清除</button>

      <div class="sorter">
        <select v-model="sortKey" class="sel" title="排序字段">
          <option v-for="(label, key) in SORT_LABELS" :key="key" :value="key">{{ label }}</option>
        </select>
        <button
          class="btn ghost dir"
          :title="sortDir === 'asc' ? '升序' : '降序'"
          @click="sortDir = sortDir === 'asc' ? 'desc' : 'asc'"
        >
          {{ sortDir === 'asc' ? '↑' : '↓' }}
        </button>
      </div>

      <span class="count-note">
        <template v-if="hasFilter">{{ filtered.length }} / {{ library.items.length }} 首</template>
        <template v-else>共 {{ library.items.length }} 首</template>
      </span>
    </div>

    <SongTable
      ref="tableRef"
      :songs="songs"
      :loading="library.loading"
      removable
      menuable
      editable
      selectable
      sortable
      show-size
      :sort-key="sortKey === 'added' ? '' : sortKey"
      :sort-dir="sortDir"
      remove-title="删除文件（下载目录移入回收站，导入目录仅从库移除）"
      empty-title="没有匹配的曲目"
      :empty-hint="hasFilter ? '换个关键词，或点「清除」重置筛选' : '去搜索页找首歌，点右侧的下载按钮试试'"
      @remove="(song) => { const item = trackOf(song); if (item) requestDelete([item]) }"
      @menu="openMenu"
      @edit="openEditor"
      @sort="toggleSort"
    >
      <template #bulk="{ selected, clear }">
        <button class="btn" :disabled="!selected.length" @click="copyTracks(tracksOf(selected))">
          <Icon name="copy" :size="13" /> 复制到
        </button>
        <button class="btn" :disabled="!selected.length" @click="askExport(tracksOf(selected))">
          <Icon name="export" :size="13" /> 导出
        </button>
        <button
          class="btn"
          :disabled="!selected.length"
          @click="library.copyPath(selected.map((song) => song.id))"
        >
          复制路径
        </button>
        <button
          class="btn"
          :disabled="!selected.length"
          title="把文件放进系统剪贴板，可直接粘贴到文件夹或聊天窗口"
          @click="copyFiles(tracksOf(selected))"
        >
          复制文件
        </button>
        <button class="btn" :disabled="!selected.length" @click="askMeta(tracksOf(selected))">
          改标签
        </button>
        <button class="btn" :disabled="!selected.length" @click="requestRemove(tracksOf(selected))">
          从库移除
        </button>
        <button
          class="btn danger-lite"
          :disabled="!selected.length"
          @click="requestDelete(tracksOf(selected))"
        >
          <Icon name="trash" :size="13" /> 删除文件
        </button>
        <button class="btn ghost" @click="clear">取消选择</button>
      </template>
    </SongTable>

    <!-- 行菜单：右键整行或点「更多」打开；右键已选中的行时对整批生效 -->
    <div v-if="menu" ref="menuEl" class="menu" :style="menuStyle" @click.stop>
      <template v-if="menu.items.length === 1">
        <button @click="playItem(menu.song)">播放</button>
        <button @click="playNextItem(menu.song)">下一首播放</button>
        <button @click="showInFolder(menu.items[0])">在文件夹中显示</button>
        <span class="sep" />
      </template>
      <button @click="copyTracks(menu.items); closeMenu()">
        复制到…
        <em v-if="menu.items.length > 1" class="n">{{ menu.items.length }}</em>
      </button>
      <button @click="askExport(menu.items); closeMenu()">
        导出…
        <em v-if="menu.items.length > 1" class="n">{{ menu.items.length }}</em>
      </button>
      <button @click="library.copyPath(menu.items.map((item) => item.id)); closeMenu()">
        复制路径
      </button>
      <button title="放进系统剪贴板，可直接粘贴到文件夹或聊天窗口" @click="copyFiles(menu.items)">
        复制文件
      </button>
      <span class="sep" />
      <button v-if="menu.items.length === 1" @click="openEditor(menu.song)">编辑歌曲信息</button>
      <button v-else @click="askMeta(menu.items)">批量修改标签（{{ menu.items.length }} 首）</button>
      <span class="sep" />
      <button @click="requestRemove(menu.items); closeMenu()">从库移除（保留文件）</button>
      <button v-if="menuDeleteLabel" class="danger" @click="requestDelete(menu.items); closeMenu()">
        {{ menuDeleteLabel }}
      </button>
    </div>

    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="confirmOpen"
      :title="confirmMode === 'delete' ? '确认删除' : '从音乐库移除'"
      :confirm-text="confirmText"
      cancel-text="取消"
      :danger="confirmMode === 'delete' && pendingDeletable.length > 0"
      :busy="busy"
      @cancel="confirmOpen = false"
      @confirm="runConfirm"
    >
      <p v-if="pending.length === 1" class="one-line truncate">{{ pending[0].song.name }}</p>
      <p v-else class="one-line">
        {{ pending.slice(0, 3).map((item) => item.song.name).join('、') }}
        <template v-if="pending.length > 3"> 等 {{ pending.length }} 首</template>
      </p>

      <template v-if="confirmMode === 'delete'">
        <p v-if="pendingDeletable.length">
          <strong>{{ pendingDeletable.length }}</strong> 个文件（{{ formatBytes(pendingSize) }}）连同歌词与元数据会移入
          <strong>系统回收站</strong>，需要时可在回收站还原。
        </p>
        <p v-if="pendingImported.length" class="warn">
          其中 {{ pendingImported.length }} 首来自导入目录，属于你自己的原始文件，只会从列表移除，不会删除。
        </p>
        <p class="hint">歌单里指向这些文件的条目会一并清理。</p>
      </template>
      <p v-else class="hint">只移除索引，磁盘文件保留；下次扫描不会再自动加回来。</p>
    </ConfirmDialog>

    <!-- 导出模板 -->
    <ConfirmDialog
      v-if="exportOpen"
      title="导出文件"
      confirm-text="选择目录并导出"
      @cancel="exportOpen = false"
      @confirm="runExport"
    >
      <p>按模板重命名后复制到指定文件夹（{{ exportIds.length }} 首）。</p>
      <label class="field">
        <span>命名模板</span>
        <input v-model="exportTemplate" maxlength="120" />
      </label>
      <p class="hint">可用变量：{artist} 歌手、{name} 歌名、{album} 专辑、{ext} 格式</p>
    </ConfirmDialog>

    <!-- 批量改标签 -->
    <ConfirmDialog
      v-if="metaOpen"
      title="批量修改标签"
      :confirm-text="`应用到 ${metaIds.length} 首`"
      :busy="metaBusy"
      @cancel="metaOpen = false"
      @confirm="runMeta"
    >
      <p>只改动填写的字段，留空的保持原样；同时写入文件标签与音乐库索引。</p>
      <label class="field">
        <span>歌手</span>
        <input v-model="metaArtists" maxlength="120" placeholder="多个歌手用 / 分隔" />
      </label>
      <label class="field">
        <span>专辑</span>
        <input v-model="metaAlbum" maxlength="120" placeholder="留空则不修改" />
      </label>
      <p class="hint">歌名逐首不同，不参与批量修改；要改歌名请用单首的「编辑歌曲信息」。</p>
    </ConfirmDialog>

    <!-- 重复文件 -->
    <div v-if="dupOpen" class="mask" @click.self="dupOpen = false">
      <div class="panel dup">
        <header class="panel-head">
          <h3>重复文件</h3>
          <div class="panel-actions">
            <button class="btn ghost" :disabled="dupLoading" @click="scanDuplicates">
              {{ dupLoading ? '扫描中…' : '重新扫描' }}
            </button>
            <button class="icon-btn" @click="dupOpen = false"><Icon name="close" :size="14" /></button>
          </div>
        </header>

        <div v-if="dupLoading" class="panel-empty">正在按大小分组并计算哈希，库大的话要几十秒…</div>
        <div v-else-if="!dupGroups.length" class="panel-empty">没有发现重复文件。</div>
        <div v-else class="dup-list">
          <section v-for="group in dupGroups" :key="group.label" class="dup-group">
            <h4>
              {{ group.label }}
              <em>{{ group.kind === 'identical' ? '内容完全一致' : '同曲不同音质' }}</em>
            </h4>
            <label v-for="id in group.ids" :key="id" class="dup-row">
              <input type="checkbox" :checked="dupSelected.has(id)" @change="toggleDup(id)" />
              <span class="dup-name truncate">{{ trackMap.get(id)?.song.name ?? id }}</span>
              <span class="dup-meta">{{ trackMap.get(id)?.ext.toUpperCase() }}</span>
              <span class="dup-meta">{{ formatBytes(trackMap.get(id)?.size ?? 0) }}</span>
              <span class="dup-path truncate" :title="trackMap.get(id)?.filePath">
                {{ trackMap.get(id)?.filePath }}
              </span>
            </label>
          </section>
        </div>

        <footer class="panel-foot">
          <span class="hint">默认保留体积最大的一份；导入目录的文件只会从库移除。</span>
          <button
            class="btn danger-lite"
            :disabled="dupLoading || !dupSelected.size || busy"
            @click="cleanDuplicates"
          >
            清理 {{ dupSelected.size }} 个
          </button>
        </footer>
      </div>
    </div>

    <!-- 操作结果：只在有失败时出现 -->
    <div v-if="report" class="mask" @click.self="report = null">
      <div class="panel">
        <header class="panel-head">
          <h3>操作结果</h3>
          <button class="icon-btn" @click="report = null"><Icon name="close" :size="14" /></button>
        </header>
        <p class="summary">
          成功 <strong>{{ report.ok }}</strong> 项，失败 <strong>{{ report.failed }}</strong> 项
        </p>
        <div class="report-list">
          <div v-for="item in report.items" :key="item.id" class="report-row">
            <em :class="{ bad: !item.ok }">{{ item.ok ? '成功' : '失败' }}</em>
            <span class="truncate">{{ item.name }}</span>
            <span v-if="item.note" class="note truncate">{{ item.note }}</span>
          </div>
        </div>
        <footer class="panel-foot">
          <button v-if="report.targetDir" class="btn ghost" @click="openTargetDir">
            打开目标文件夹
          </button>
          <button class="btn primary" @click="report = null">知道了</button>
        </footer>
      </div>
    </div>

    <!-- 复制/导出进度 -->
    <div v-if="progress" class="progress">
      <span class="pulse" />
      正在处理 {{ progress.done }} / {{ progress.total }}
      <em class="truncate">{{ progress.current }}</em>
    </div>

    <!-- 元数据编辑 -->
    <div v-if="editing" class="editor-mask" @click.self="closeEditor">
      <div class="editor">
        <h3>编辑歌曲信息</h3>
        <p class="tip">同时写入文件标签与音乐库索引，换个播放器、重装应用都能保留</p>
        <label>
          <span>歌名</span>
          <input v-model="editName" maxlength="120" placeholder="必填" />
        </label>
        <label>
          <span>歌手</span>
          <input v-model="editArtists" maxlength="120" placeholder="多个歌手用 / 分隔" />
        </label>
        <label>
          <span>专辑</span>
          <input v-model="editAlbum" maxlength="120" placeholder="可留空" />
        </label>
        <div class="editor-actions">
          <button class="btn" :disabled="saving" @click="closeEditor">取消</button>
          <button class="btn primary" :disabled="saving" @click="saveEditor">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin: 10px 0 20px;
  gap: 20px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 750;
}
.head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.head-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.imported {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin: -8px 0 20px;
}
.imported-label {
  font-size: 10.5px;
  color: var(--text-3);
  letter-spacing: 0.6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 320px;
  padding: 4px 6px 4px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  font-size: 11px;
  color: var(--text-2);
}
.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}
.chip-x:hover {
  background: rgba(255, 92, 124, 0.25);
  color: #ffd0d8;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.stat {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.stat span {
  font-size: 10.5px;
  color: var(--text-3);
  letter-spacing: 0.6px;
}
.stat strong {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.4px;
}
.stat small {
  font-size: 10.5px;
  color: var(--text-3);
}
.stat.path small {
  font-size: 11px;
  color: var(--text-2);
}

.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border-radius: 12px;
  border: 1px solid rgba(230, 194, 104, 0.28);
  background: rgba(230, 194, 104, 0.08);
  font-size: 11.5px;
  color: var(--text-2);
}
.banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.banner .btn {
  height: 28px;
  padding: 0 12px;
  font-size: 11.5px;
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px;
  min-width: 180px;
  flex: 1 1 200px;
  max-width: 280px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-3);
}
.search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
}
.search .clear {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-3);
}

.sel {
  height: 32px;
  max-width: 132px;
  padding: 0 8px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--panel-strong);
  color: var(--text-2);
  font-size: 11.5px;
  outline: none;
}
.sorter {
  display: flex;
  align-items: center;
  gap: 4px;
}
/* 来源筛选：三态且互斥，用分段控件比再塞一个 select 更好认 */
.seg {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 2px;
  gap: 2px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
}
.seg button {
  height: 26px;
  padding: 0 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.seg button:hover {
  color: var(--text-2);
}
.seg button.on {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}
.count-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
}
.btn.ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text-2);
  height: 32px;
  padding: 0 12px;
  font-size: 11.5px;
}
.btn.ghost:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.08);
}
.sorter .dir {
  width: 32px;
  padding: 0;
  justify-content: center;
  font-size: 13px;
}
.dup-btn {
  height: 32px;
  padding: 0 13px;
  font-size: 11.5px;
}
.dup-btn .count {
  font-style: normal;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: rgba(230, 194, 104, 0.18);
  color: #e6c268;
  font-size: 10px;
  display: inline-grid;
  place-items: center;
}
.btn.danger-lite {
  height: 28px;
  padding: 0 11px;
  font-size: 11.5px;
  color: #ff8f96;
  border-color: rgba(229, 72, 77, 0.35);
  background: rgba(229, 72, 77, 0.1);
}
.btn.danger-lite:hover {
  background: rgba(229, 72, 77, 0.2);
}

.menu {
  position: fixed;
  z-index: 60;
  min-width: 210px;
  padding: 6px;
  border-radius: 12px;
  background-color: var(--bg);
  background-image: linear-gradient(var(--panel-strong), var(--panel-strong));
  border: 1px solid var(--border);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--text-2);
}
.menu button:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}
.menu .n {
  margin-left: auto;
  font-style: normal;
  font-size: 10px;
  color: var(--text-3);
}
.menu .danger {
  color: #ff8f96;
}
.menu .sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}

.mask {
  position: fixed;
  inset: 0;
  z-index: 55;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(6px);
}
.panel {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: min(78vh, 720px);
  display: flex;
  flex-direction: column;
  padding: 18px 20px 14px;
  border-radius: 18px;
  /* 实底 + 半透明叠加：只用 rgba 面板会让背后的封面透上来，糊成一块白斑 */
  background-color: var(--bg);
  background-image: linear-gradient(var(--panel-strong), var(--panel-strong));
  border: 1px solid var(--border);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
}
.panel.dup {
  width: 720px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.panel-head h3 {
  margin: 0;
  font-size: 14.5px;
}
.panel-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.panel-empty {
  padding: 32px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
.dup-list {
  overflow: auto;
  flex: 1;
  margin: 0 -6px;
  padding: 0 6px;
}
.dup-group {
  margin-bottom: 14px;
}
.dup-group h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--text-2);
  display: flex;
  align-items: center;
  gap: 8px;
}
.dup-group h4 em {
  font-style: normal;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
}
.dup-row {
  display: grid;
  grid-template-columns: 18px 1.2fr 48px 64px 1.8fr;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 11px;
  color: var(--text-2);
}
.dup-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.dup-row input {
  accent-color: var(--accent);
}
.dup-meta {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.dup-path {
  color: var(--text-3);
  font-size: 10.5px;
}
.panel-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.hint {
  font-size: 10.5px;
  line-height: 1.7;
  color: var(--text-3);
  margin: 6px 0 0;
}
.summary {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-2);
}
.report-list {
  overflow: auto;
  max-height: 40vh;
}
.report-row {
  display: grid;
  grid-template-columns: 40px 1.4fr 1.6fr;
  gap: 8px;
  padding: 5px 0;
  font-size: 11px;
  color: var(--text-2);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.report-row em {
  font-style: normal;
  color: #3ddc97;
}
.report-row em.bad {
  color: #ff8f96;
}
.report-row .note {
  color: var(--text-3);
}

.progress {
  position: fixed;
  left: 50%;
  bottom: 96px;
  transform: translateX(-50%);
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 60vw;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--panel-strong);
  border: 1px solid var(--border);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  font-size: 11.5px;
  color: var(--text-2);
}
.progress .pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}
.progress em {
  font-style: normal;
  color: var(--text-3);
  max-width: 220px;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.one-line {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--text-1);
}
.one-line + p {
  margin: 0 0 6px;
}
.warn {
  color: #e6c268;
}
.field {
  display: block;
  margin: 10px 0 0;
}
.field span {
  display: block;
  margin-bottom: 5px;
  font-size: 10.5px;
  color: var(--text-3);
}
.field input {
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-1);
  font-size: 12px;
  outline: none;
}
.field input:focus {
  border-color: rgba(110, 231, 255, 0.45);
}

/* 元数据编辑弹层 */
.editor-mask {
  position: fixed;
  inset: 0;
  z-index: 55;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}
.editor {
  width: 380px;
  padding: 20px 22px 16px;
  border-radius: 18px;
  background-color: var(--bg);
  background-image: linear-gradient(var(--panel-strong), var(--panel-strong));
  border: 1px solid var(--border);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.55);
}
.editor h3 {
  margin: 0 0 4px;
  font-size: 14px;
  color: var(--text-1);
}
.editor .tip {
  margin: 0 0 14px;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-3);
}
.editor label {
  display: block;
  margin-bottom: 10px;
}
.editor label span {
  display: block;
  margin-bottom: 5px;
  font-size: 10.5px;
  color: var(--text-3);
}
.editor input {
  width: 100%;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-1);
  font-size: 12px;
  outline: none;
}
.editor input:focus {
  border-color: rgba(110, 231, 255, 0.45);
}
.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}

@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
