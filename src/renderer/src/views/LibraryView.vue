<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Song } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import Icon from '../components/Icon.vue'
import { useLibraryStore } from '../stores/library'
import { useDownloadStore } from '../stores/download'
import { useAppStore } from '../stores/app'
import { formatBytes } from '@shared/lyric'
import { isNativeMobile } from '../core/platform'

/** 原生容器：目录选择/导入依赖桌面文件管理器，隐藏对应按钮 */
const isNative = isNativeMobile()

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
        <!-- 移动端：MediaStore 目录导入为后续里程碑，先隐藏死入口 -->
        <button v-if="!isNative" class="btn" @click="library.importDir()">
          <Icon name="folder-plus" :size="14" /> 导入本地音乐
        </button>
        <!-- 移动端目录固定，无需选择 -->
        <button v-if="!isNative" class="btn" @click="openDir">
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
      show-size
      empty-title="音乐库还是空的"
      empty-hint="去搜索页找首歌，点右侧的下载按钮试试"
      @remove="remove"
    />
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
</style>
