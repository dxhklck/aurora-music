<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Song } from '@shared/types'
import Icon from '../components/Icon.vue'
import CoverArt from '../components/CoverArt.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { usePlayerStore, type HistoryEntry } from '../stores/player'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'

/**
 * 播放历史（按天分组）。
 *
 * 数据来自 player store 的 aurora.history（带时间戳，300 条）；
 * 旧版只有 aurora.recent（无时间）：迁移过来的记录 at=0，归进「更早的播放」。
 */
const player = usePlayerStore()
const app = useAppStore()
const download = useDownloadStore()

const keyword = ref('')
const confirming = ref(false)

interface DayGroup {
  key: string
  label: string
  items: HistoryEntry[]
}

function startOfDay(time: number): number {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayKey(at: number): string {
  if (at <= 0) return 'earlier'
  const d = new Date(at)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * 用本地日期算「今天/昨天」，不能拿 toISOString 的 UTC 日期切：
 * 凌晨 0~8 点（东八区）会被算成前一天，和用户看到的日期对不上。
 */
function dayLabel(at: number): string {
  if (at <= 0) return '更早的播放'
  const today = startOfDay(Date.now())
  const day = startOfDay(at)
  const diff = Math.round((today - day) / 86_400_000)
  if (diff <= 0) return '今天'
  if (diff === 1) return '昨天'
  const d = new Date(at)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}年${md}`
}

function timeLabel(at: number): string {
  // at=0：从旧版 recent 迁移来的记录没有时间，留空而不是编一个时间
  if (at <= 0) return ''
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const filtered = computed<HistoryEntry[]>(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return player.history
  return player.history.filter((entry) =>
    [entry.song.name, ...entry.song.artists, entry.song.album ?? ''].join(' ').toLowerCase().includes(k)
  )
})

const groups = computed<DayGroup[]>(() => {
  const out: DayGroup[] = []
  for (const entry of filtered.value) {
    const key = dayKey(entry.at)
    const last = out[out.length - 1]
    if (last && last.key === key) last.items.push(entry)
    else out.push({ key, label: dayLabel(entry.at), items: [entry] })
  }
  return out
})

/** 从历史建队列时按歌去重：同一首听过十遍不该在队列里排十遍 */
const playable = computed<Song[]>(() => {
  const seen = new Set<string>()
  const songs: Song[] = []
  for (const entry of player.history) {
    const key = `${entry.song.platform}:${entry.song.id}`
    if (seen.has(key)) continue
    seen.add(key)
    songs.push(entry.song)
  }
  return songs
})

function playEntry(song: Song): void {
  const current = player.resolvedSong ?? player.displaySong
  // 点的是正在放的这首：切播放/暂停，而不是把队列重建一遍
  if (current && current.id === song.id && current.platform === song.platform) {
    void player.toggle()
    return
  }
  const list = playable.value
  const index = list.findIndex((item) => item.id === song.id && item.platform === song.platform)
  player.setQueue(list, Math.max(0, index))
}

function playAll(): void {
  if (playable.value.length) player.setQueue(playable.value, 0)
}

function downloadAll(): void {
  if (playable.value.length) void download.enqueueMany(playable.value)
}

function clearAll(): void {
  confirming.value = false
  player.clearHistory()
  app.toast('播放记录已清空', 'info')
}

// 「播放全部」按去重后的列表播；「全部下载」同理（历史里同一首只下载一次）
</script>

<template>
  <div class="history">
    <header class="head">
      <div>
        <h1>播放历史</h1>
        <p>
          <template v-if="player.history.length">
            最近 {{ player.history.length }} 次播放 · 按时间分组 · 只存在本机，不上传
          </template>
          <template v-else>听过的歌会按时间出现在这里</template>
        </p>
      </div>
      <div class="head-actions">
        <button class="btn" :disabled="!playable.length" @click="downloadAll">
          <Icon name="download" :size="14" /> 全部下载
        </button>
        <button class="btn" :disabled="!player.history.length" @click="confirming = true">
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
      <button class="btn primary" :disabled="!playable.length" @click="playAll">
        <Icon name="play" :size="14" /> 播放全部
      </button>
      <span class="count-note">
        <template v-if="keyword.trim()">{{ filtered.length }} / {{ player.history.length }} 条</template>
        <template v-else>共 {{ player.history.length }} 条</template>
      </span>
    </div>

    <template v-if="groups.length">
      <section v-for="group in groups" :key="group.key" class="day">
        <h2 class="day-label">
          {{ group.label }}<span>{{ group.items.length }} 首</span>
        </h2>
        <div class="rows">
          <button
            v-for="(entry, i) in group.items"
            :key="`${entry.song.platform}:${entry.song.id}:${entry.at}:${i}`"
            class="row"
            :class="{
              active:
                (player.resolvedSong ?? player.displaySong)?.id === entry.song.id &&
                (player.resolvedSong ?? player.displaySong)?.platform === entry.song.platform
            }"
            @click="playEntry(entry.song)"
          >
            <span class="time">{{ timeLabel(entry.at) }}</span>
            <CoverArt
              :src="entry.song.coverUrl"
              :seed="`${entry.song.platform}:${entry.song.id}`"
              :size="42"
              :radius="10"
              :song="entry.song"
            />
            <span class="meta">
              <strong class="truncate">{{ entry.song.name }}</strong>
              <small class="truncate">{{ entry.song.artists.join(' / ') || '未知歌手' }}</small>
            </span>
            <span v-if="entry.song.album" class="album truncate">{{ entry.song.album }}</span>
            <button
              class="dl"
              title="下载"
              @click.stop="download.enqueueMany([entry.song])"
            >
              <Icon name="download" :size="13" />
            </button>
          </button>
        </div>
      </section>
    </template>

    <div v-else class="empty">
      <Icon name="history" :size="32" />
      <strong>{{ keyword.trim() ? '没有匹配的记录' : '还没有播放记录' }}</strong>
      <p>{{ keyword.trim() ? '换个关键词试试' : '去发现页或搜索里播一首，回来就能看到' }}</p>
    </div>

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

.day {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.day-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 8px 4px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.day-label span {
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3);
}

.rows {
  display: flex;
  flex-direction: column;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 6px;
  border: 0;
  border-radius: 12px;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  transition: background 0.15s var(--ease);
}
.row:hover {
  background: var(--row-hover);
}
.row.active {
  background: var(--row-active);
}

.time {
  flex: none;
  width: 38px;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.meta strong {
  font-size: 13.5px;
  font-weight: 600;
}
.meta small {
  font-size: 11.5px;
  color: var(--text-3);
}
.album {
  max-width: 30%;
  font-size: 11.5px;
  color: var(--text-3);
}
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl {
  flex: none;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}
.row:hover .dl {
  opacity: 1;
}
.dl:hover {
  background: var(--panel-strong);
  color: var(--text);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 56px 20px;
  text-align: center;
  color: var(--text-2);
}
.empty strong {
  font-size: 15px;
  color: var(--text);
}
.empty p {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}
</style>
