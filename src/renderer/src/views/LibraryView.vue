<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Song } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import Icon from '../components/Icon.vue'
import { useLibraryStore } from '../stores/library'
import { useDownloadStore } from '../stores/download'
import { useAppStore } from '../stores/app'
import { formatBytes } from '@shared/lyric'

const library = useLibraryStore()
const download = useDownloadStore()
const app = useAppStore()
const dir = ref('')

const songs = computed<Song[]>(() =>
  library.items.map((item) => ({
    ...item.song,
    platform: 'local',
    id: item.id,
    fileSize: item.size,
    qualityLabel: item.qualityLabel ?? item.ext.toUpperCase(),
    extra: { filePath: item.filePath }
  }))
)

async function remove(song: Song): Promise<void> {
  await library.remove(song.id)
}

/* ---------- 元数据编辑 ---------- */
const editing = ref<Song | null>(null)
const editName = ref('')
const editArtists = ref('')
const editAlbum = ref('')
const saving = ref(false)

function openEditor(song: Song): void {
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

async function openDir(): Promise<void> {
  if (!dir.value) return
  const result = await window.api.chooseDownloadDir()
  dir.value = result
  app.toast('下载目录已更新', 'success')
}

onMounted(async () => {
  await library.load()
  dir.value = await window.api.downloadDir()
})
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
        <button class="btn" @click="library.refresh()">
          <Icon name="refresh" :size="14" /> 刷新
        </button>
      </div>
    </header>

    <div v-if="library.importedDirs.length" class="imported">
      <span class="imported-label">已导入</span>
      <span v-for="dir in library.importedDirs" :key="dir" class="chip">
        <Icon name="folder" :size="12" />
        <span class="truncate" :title="dir">{{ dir }}</span>
        <button class="chip-x" title="不再扫描此目录" @click="library.removeDir(dir)">
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

    <SongTable
      :songs="songs"
      :loading="library.loading"
      removable
      editable
      show-size
      empty-title="音乐库还是空的"
      empty-hint="去搜索页找首歌，点右侧的下载按钮试试"
      @remove="remove"
      @edit="openEditor"
    />

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

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 24px;
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
.stat.path {
  grid-column: span 1;
}
.stat.path small {
  font-size: 11px;
  color: var(--text-2);
}

@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* 元数据编辑弹层 */
.editor-mask {
  position: fixed;
  inset: 0;
  z-index: 40;
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
  background: var(--panel-strong);
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
</style>
