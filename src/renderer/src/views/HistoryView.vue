<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Song } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import Icon from '../components/Icon.vue'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'

/**
 * 播放历史。
 *
 * 数据一直在 localStorage（`aurora.recent`），以前只在首页露 6 条。
 * 这里给完整列表：搜索、播放全部、批量下载、清空。
 */
const player = usePlayerStore()
const app = useAppStore()
const download = useDownloadStore()

const keyword = ref('')
const confirming = ref(false)

const songs = computed<Song[]>(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return player.recent
  return player.recent.filter((song) =>
    [song.name, ...song.artists, song.album ?? ''].join(' ').toLowerCase().includes(k)
  )
})

function playAll(): void {
  if (songs.value.length) player.setQueue(songs.value, 0)
}

function downloadAll(): void {
  if (songs.value.length) void download.enqueueMany(songs.value)
}

function clearAll(): void {
  confirming.value = false
  player.clearRecent()
  app.toast('播放记录已清空', 'info')
}
</script>

<template>
  <div class="history">
    <header class="head">
      <div>
        <h1>播放历史</h1>
        <p>最近播放过的曲目，按时间倒序；只存在本机，不上传</p>
      </div>
      <div class="head-actions">
        <button class="btn" :disabled="!songs.length" @click="downloadAll">
          <Icon name="download" :size="14" /> 全部下载
        </button>
        <button class="btn" :disabled="!player.recent.length" @click="confirming = true">
          <Icon name="trash" :size="14" /> 清空记录
        </button>
      </div>
    </header>

    <div class="toolbar">
      <label class="search">
        <Icon name="search" :size="14" />
        <input v-model="keyword" placeholder="在历史里搜索歌名 / 歌手 / 专辑" />
        <button v-if="keyword" class="clear" title="清空" @click="keyword = ''">
          <Icon name="close" :size="11" />
        </button>
      </label>
      <button class="btn primary" :disabled="!songs.length" @click="playAll">
        <Icon name="play" :size="14" /> 播放全部
      </button>
      <span class="count-note">
        <template v-if="keyword.trim()">{{ songs.length }} / {{ player.recent.length }} 首</template>
        <template v-else>共 {{ player.recent.length }} 首</template>
      </span>
    </div>

    <SongTable
      :songs="songs"
      :selectable="true"
      :empty-title="keyword.trim() ? '没有匹配的记录' : '还没有播放记录'"
      :empty-hint="keyword.trim() ? '换个关键词试试' : '双击任意歌曲开始播放，这里就会留下记录'"
    >
      <template #bulk="{ selected, clear }">
        <button class="btn primary" :disabled="!selected.length" @click="player.setQueue(selected, 0); clear()">
          <Icon name="play" :size="13" /> 播放选中
        </button>
        <button class="btn" :disabled="!selected.length" @click="download.enqueueMany(selected); clear()">
          <Icon name="download" :size="13" /> 下载
        </button>
        <button class="btn ghost" @click="clear">取消选择</button>
      </template>
    </SongTable>

    <ConfirmDialog
      v-if="confirming"
      title="清空播放历史？"
      confirm-text="清空"
      danger
      @confirm="clearAll"
      @cancel="confirming = false"
    >
      只会删掉本机的播放记录，不影响歌单、收藏与已下载的文件。
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin-top: 14px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 26px;
  letter-spacing: -0.4px;
}
.head p {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
.head-actions {
  display: flex;
  gap: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 34px;
  padding: 0 11px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-3);
  min-width: 300px;
}
.search input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
}
.clear {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  color: var(--text-3);
}
.clear:hover {
  background: var(--panel-strong);
  color: var(--text);
}
.count-note {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--text-3);
}
</style>
