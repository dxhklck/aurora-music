<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import CoverArt from '../components/CoverArt.vue'
import ProgressBar from '../components/ProgressBar.vue'
import { useDownloadStore } from '../stores/download'
import { useAppStore } from '../stores/app'
import { usePlayerStore } from '../stores/player'
import { formatBytes } from '@shared/lyric'
import { isNativeMobile } from '../core/platform'

/** 原生容器：目录固定/无系统文件管理器联动，隐藏对应按钮 */
const isNative = isNativeMobile()
import type { DownloadTask, Song } from '@shared/types'

const store = useDownloadStore()
const app = useAppStore()
const player = usePlayerStore()
const dir = ref('')

const counts = computed(() => ({
  active: store.active.length,
  done: store.finished.length,
  failed: store.failed.length
}))

const engineCount = computed(
  () => store.tasks.filter((task) => task.song.platform.startsWith('mdl-')).length
)

function statusText(task: DownloadTask): string {
  switch (task.status) {
    case 'queued':
      return '排队中'
    case 'downloading':
      return task.total
        ? `${formatBytes(task.received)} / ${formatBytes(task.total)}`
        : `已下载 ${formatBytes(task.received)}`
    case 'done':
      return `已完成 · ${formatBytes(task.total)}`
    case 'error':
      return task.error ?? '下载失败'
    case 'canceled':
      return '已取消'
    default:
      return ''
  }
}

function percent(task: DownloadTask): number {
  if (task.status === 'done') return 1
  return Math.max(0, Math.min(1, task.progress))
}

function speed(task: DownloadTask): string {
  return task.speed > 0 ? `${formatBytes(task.speed)}/s` : ''
}

function transportLabel(task: DownloadTask): string {
  if (task.transport === 'hls') return 'HLS · 引擎合并'
  if (task.transport === 'local') return '本地复制'
  return '直连流式'
}

function openTask(id: string): void {
  void window.api.openDownload(id)
}

function revealTask(id: string): void {
  void window.api.revealDownload(id)
}

/** 在应用内播放已下载文件：切成 local 音源，走本地库索引解析，离线可用 */
function playTask(task: DownloadTask): void {
  const song: Song = {
    ...task.song,
    platform: 'local',
    id: task.id,
    qualityLabel: task.song.qualityLabel ?? '本地文件',
    extra: { ...(task.song.extra ?? {}), filePath: task.filePath ?? '' }
  }
  player.setQueue([song], 0)
}

async function chooseDir(): Promise<void> {
  dir.value = await window.api.chooseDownloadDir()
  app.toast(`下载目录：${dir.value}`, 'info')
}

onMounted(async () => {
  await store.init()
  dir.value = await window.api.downloadDir()
})
</script>

<template>
  <div class="downloads">
    <header class="head">
      <div>
        <h1>下载管理</h1>
        <p>
          并发 {{ app.settings?.downloadConcurrency ?? 2 }} · 失败重试
          {{ app.settings?.downloadRetries ?? 3 }} 次 · 断点续传 · 完成后写歌词与标签
        </p>
      </div>
      <div class="head-actions">
        <button v-if="counts.failed" class="btn" @click="store.retryFailed()">
          <Icon name="refresh" :size="14" /> 全部重试
        </button>
        <!-- 移动端目录固定写入应用专属空间，不可更改 -->
        <button v-if="!isNative" class="btn" @click="chooseDir">
          <Icon name="folder" :size="14" /> 更改目录
        </button>
        <button class="btn" @click="store.clearFinished()">
          <Icon name="trash" :size="14" /> 清空已结束
        </button>
      </div>
    </header>

    <div class="dir card">
      <Icon name="download" :size="15" />
      <span class="truncate">{{ dir || '未设置下载目录' }}</span>
      <em v-if="counts.active">{{ counts.active }} 个任务进行中</em>
    </div>

    <div class="summary">
      <div class="sum"><strong>{{ counts.active }}</strong><span>进行中</span></div>
      <div class="sum"><strong>{{ counts.done }}</strong><span>已完成</span></div>
      <div class="sum"><strong>{{ counts.failed }}</strong><span>失败</span></div>
      <div v-if="engineCount" class="sum"><strong>{{ engineCount }}</strong><span>引擎音源</span></div>
    </div>

    <div v-if="store.tasks.length" class="list">
      <article v-for="task in store.tasks" :key="task.id" class="task card" :class="task.status">
        <CoverArt
          :src="task.song.coverUrl"
          :seed="`${task.song.platform}:${task.song.id}`"
          :size="52"
          :radius="12"
          :song="task.song"
        />

        <div class="main">
          <div class="line">
            <strong class="truncate">{{ task.song.name }}</strong>
            <span class="artists truncate">{{ task.song.artists.join(' / ') }}</span>
            <span class="status" :class="task.status">{{ statusText(task) }}</span>
          </div>

          <ProgressBar :value="percent(task)" :height="4" disabled class="progress" />

          <div class="meta">
            <span>{{ task.song.platform.toUpperCase() }}</span>
            <span v-if="task.transport">{{ transportLabel(task) }}</span>
            <span v-if="speed(task)">{{ speed(task) }}</span>
            <span v-if="task.attempt > 1">第 {{ task.attempt }} 次尝试</span>
            <span v-if="percent(task) > 0 && task.status === 'downloading'">
              {{ Math.round(percent(task) * 100) }}%
            </span>
            <span v-if="task.status === 'done' && task.tagged" class="tagged">已写标签</span>
          </div>
        </div>

        <div class="actions">
          <button
            v-if="task.status === 'downloading' || task.status === 'queued'"
            class="icon-btn"
            title="取消"
            @click="store.cancel(task.id)"
          >
            <Icon name="close" :size="16" />
          </button>
          <button
            v-if="task.status === 'error' || task.status === 'canceled'"
            class="icon-btn"
            title="重试"
            @click="store.retry(task.id)"
          >
            <Icon name="refresh" :size="16" />
          </button>
          <button
            v-if="task.status === 'done'"
            class="icon-btn"
            title="在应用内播放"
            @click="playTask(task)"
          >
            <Icon name="play" :size="16" />
          </button>
          <button
            v-if="task.status === 'done' && !isNative"
            class="icon-btn"
            title="用系统播放器打开"
            @click="openTask(task.id)"
          >
            <Icon name="play_circle" :size="16" />
          </button>
          <button
            v-if="task.status === 'done' && !isNative"
            class="icon-btn"
            title="在文件夹中显示"
            @click="revealTask(task.id)"
          >
            <Icon name="folder" :size="16" />
          </button>
          <button
            v-if="task.status !== 'downloading' && task.status !== 'queued'"
            class="icon-btn"
            title="移除记录"
            @click="store.remove(task.id)"
          >
            <Icon name="trash" :size="16" />
          </button>
        </div>
      </article>
    </div>

    <div v-else class="empty">
      <strong>还没有下载任务</strong>
      <span>在搜索结果或榜单里点下载图标，也可以勾选多首批量下载</span>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin: 10px 0 18px;
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
}

.dir {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  font-size: 11.5px;
  color: var(--text-2);
  margin-bottom: 14px;
}
.dir span {
  flex: 1;
  min-width: 0;
}
.dir em {
  font-style: normal;
  font-size: 10.5px;
  color: var(--accent);
}

.summary {
  display: flex;
  gap: 26px;
  padding: 4px 4px 18px;
}
.sum {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.sum strong {
  font-size: 20px;
  font-weight: 700;
}
.sum span {
  font-size: 11px;
  color: var(--text-3);
}

.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
}
.task:hover {
  transform: none;
}
.task.error {
  border-color: rgba(255, 92, 124, 0.28);
}
.task.done {
  opacity: 0.92;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.line strong {
  font-size: 13px;
  font-weight: 550;
  max-width: 40%;
}
.artists {
  font-size: 11px;
  color: var(--text-3);
  flex: 1;
  min-width: 0;
}
.status {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status.error {
  color: var(--danger);
}
.status.done {
  color: #3ddc97;
}
.status.downloading {
  color: var(--text-2);
}

.meta {
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.meta .tagged {
  color: #3ddc97;
}

.actions {
  display: flex;
  gap: 2px;
}
</style>
