<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import ProgressBar from './ProgressBar.vue'
import { formatDuration } from '@shared/lyric'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'

/**
 * 迷你播放器：主窗口收缩成置顶小浮窗后的全部内容。
 * 整体可拖动窗口（-webkit-app-region: drag），按钮单独 no-drag。
 */
const player = usePlayerStore()
const app = useAppStore()

const song = computed(() => player.displaySong ?? player.current)

function seek(ratio: number): void {
  player.seekTo(player.duration * ratio)
}

/** 展开回完整形态（窗口变形由主进程在 settingsSet 里联动执行） */
function expand(): void {
  void app.patchSettings({ miniMode: false })
}
</script>

<template>
  <div class="mini-player">
    <div class="cover">
      <CoverArt
        :src="song?.coverUrl ?? null"
        :seed="song ? `${song.platform}:${song.id}` : 'aurora'"
        :size="64"
        :radius="14"
        :song="song"
      />
    </div>

    <div class="body">
      <div class="meta">
        <strong class="truncate">{{ song?.name ?? '未在播放' }}</strong>
        <small class="truncate">{{ song ? song.artists.join(' / ') || '未知歌手' : 'Aurora Music' }}</small>
      </div>
      <div class="progress">
        <ProgressBar
          :value="player.progress"
          :buffered="0"
          :disabled="!player.duration"
          @seek="seek"
        />
        <span class="time">{{ formatDuration(player.time) }}</span>
      </div>
    </div>

    <div class="controls no-drag">
      <button title="上一首" :disabled="!player.queue.length" @click="player.prev()">
        <Icon name="prev" :size="17" />
      </button>
      <button class="play" :class="{ loading: player.loading || player.waiting }" @click="player.toggle()">
        <span v-if="player.loading || player.waiting" class="ring" />
        <Icon v-else :name="player.playing ? 'pause' : 'play'" :size="17" />
      </button>
      <button title="下一首" :disabled="!player.queue.length" @click="player.next()">
        <Icon name="next" :size="17" />
      </button>
      <button class="expand" title="展开完整窗口" @click="expand">
        <Icon name="expand" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.mini-player {
  height: 100vh;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 14px 0 12px;
  /* 整个浮窗可拖动；按钮单独 no-drag */
  -webkit-app-region: drag;
  background:
    radial-gradient(120% 140% at 0% 50%, color-mix(in srgb, var(--accent) 26%, transparent), transparent 55%),
    linear-gradient(160deg, #12121a, #0a0a10);
}

.cover {
  flex: none;
  filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.55));
}

.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.meta strong {
  font-size: 13px;
  font-weight: 600;
}
.meta small {
  font-size: 11px;
  color: var(--text-3);
}

.progress {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 进度条要能点击跳转，同样从拖拽区豁免 */
  -webkit-app-region: no-drag;
}
.progress :deep(.bar) {
  height: 4px;
}
.time {
  flex: none;
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.controls {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  /* 全局 .no-drag 只作用于 .titlebar，这里必须自己声明，否则拖拽区吞掉所有点击 */
  -webkit-app-region: no-drag;
}
.controls button {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: var(--text-2);
  transition: all 0.15s;
}
.controls button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}
.controls button:disabled {
  opacity: 0.35;
}
.controls .play {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
  position: relative;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 45%, transparent);
}
.controls .expand {
  color: var(--accent);
}
.controls .ring {
  position: absolute;
  inset: 8px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
