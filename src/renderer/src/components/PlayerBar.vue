<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import ProgressBar from './ProgressBar.vue'
import { usePlayerStore } from '../stores/player'
import { useDownloadStore } from '../stores/download'
import { usePlaylistStore } from '../stores/playlists'
import { formatDuration } from '@shared/lyric'
import { isNativeMobile } from '../core/platform'

const player = usePlayerStore()

/** Capacitor 原生环境（Android/iOS）：音量走系统实体键，不显示软件音量控件 */
const isNative = isNativeMobile()
const download = useDownloadStore()
const playlists = usePlaylistStore()

const song = computed(() => player.displaySong)
const modeIcon = computed(() => {
  switch (player.mode) {
    case 'single':
      return 'repeat-one'
    case 'shuffle':
      return 'shuffle'
    case 'order':
      return 'list'
    default:
      return 'repeat'
  }
})
const modeLabel = computed(
  () =>
    ({ loop: '列表循环', single: '单曲循环', shuffle: '随机播放', order: '顺序播放' })[player.mode]
)
const bufferedRatio = computed(() =>
  player.duration ? Math.min(player.buffered / player.duration, 1) : 0
)

function seek(ratio: number): void {
  player.seekTo(ratio * (player.duration || 0))
}

function downloadCurrent(): void {
  if (song.value) void download.enqueue(song.value)
}

function toggleFavorite(): void {
  if (song.value) void playlists.toggleFavorite(song.value)
}

function addToPlaylist(): void {
  if (song.value) playlists.openPicker(song.value)
}

function setVolume(event: Event): void {
  player.setVolume(Number((event.target as HTMLInputElement).value) / 100)
}
</script>

<template>
  <footer class="playerbar">
    <div class="pb glass">
      <div class="now" @dblclick="player.showNowPlaying = true">
        <button class="cover-btn" @click="player.showNowPlaying = !player.showNowPlaying">
          <CoverArt
            :src="song?.coverUrl ?? null"
            :seed="song ? `${song.platform}:${song.id}` : 'aurora'"
            :size="56"
            :radius="12"
            :spinning="false"
            :song="song"
          />
          <span class="expand"><Icon name="lyrics" :size="16" /></span>
        </button>
        <div class="meta">
          <strong class="truncate">{{ song?.name ?? '未在播放' }}</strong>
          <p class="truncate">
            {{ song ? song.artists.join(' / ') || '未知歌手' : '选择一首歌开始沉浸式聆听' }}
          </p>
        </div>
        <button
          class="icon-btn"
          :class="{ active: playlists.isFavorite(song) }"
          :title="playlists.isFavorite(song) ? '取消收藏' : '收藏到我喜欢'"
          :disabled="!song"
          @click="toggleFavorite"
        >
          <Icon :name="playlists.isFavorite(song) ? 'heart-filled' : 'heart'" :size="18" />
        </button>
        <button class="icon-btn" title="加入歌单" :disabled="!song" @click="addToPlaylist">
          <Icon name="playlist-add" :size="18" />
        </button>
        <button class="icon-btn" title="下载" :disabled="!song" @click="downloadCurrent">
          <Icon name="download" :size="18" />
        </button>
      </div>

      <div class="center">
        <div class="controls">
          <button class="icon-btn" :title="modeLabel" @click="player.cycleMode()">
            <Icon :name="modeIcon" :size="17" />
          </button>
          <button class="icon-btn" title="上一首" :disabled="!player.queue.length" @click="player.prev()">
            <Icon name="prev" :size="19" />
          </button>
          <button
            class="play-btn"
            :class="{ loading: player.loading || player.waiting }"
            title="播放 / 暂停"
            @click="player.toggle()"
          >
            <span v-if="player.loading || player.waiting" class="ring" />
            <Icon v-else :name="player.playing ? 'pause' : 'play'" :size="19" />
          </button>
          <button class="icon-btn" title="下一首" :disabled="!player.queue.length" @click="player.next()">
            <Icon name="next" :size="19" />
          </button>
          <button
            class="icon-btn"
            :class="{ active: player.showQueue }"
            title="播放队列"
            @click="player.showQueue = !player.showQueue"
          >
            <Icon name="list" :size="18" />
          </button>
        </div>

        <div class="timeline">
          <span class="time">{{ formatDuration(player.time) }}</span>
          <ProgressBar
            :value="player.progress"
            :buffered="bufferedRatio"
            :disabled="!player.duration"
            @seek="seek"
          />
          <span class="time">{{ formatDuration(player.duration) }}</span>
        </div>
      </div>

      <div class="right">
        <span v-if="player.streamLabel" class="quality">{{ player.streamLabel }}</span>
        <!-- 移动端（Capacitor 原生环境）音量交给系统实体键，控件只占底部栏空间 -->
        <template v-if="!isNative">
          <button class="icon-btn" :title="player.muted ? '取消静音' : '静音'" @click="player.toggleMute()">
            <Icon :name="player.muted || player.volume === 0 ? 'volume-mute' : 'volume-high'" :size="18" />
          </button>
          <input
            class="volume"
            type="range"
            min="0"
            max="100"
            :value="Math.round(player.volume * 100)"
            :style="{ '--vol': Math.round(player.volume * 100) + '%' }"
            @input="setVolume"
          />
        </template>
        <button
          class="icon-btn"
          :class="{ active: player.showNowPlaying }"
          title="歌词舞台"
          @click="player.showNowPlaying = !player.showNowPlaying"
        >
          <Icon name="lyrics" :size="18" />
        </button>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.playerbar {
  padding: 0 14px 12px;
}

.pb {
  height: calc(var(--player) - 14px);
  border-radius: 18px;
  display: grid;
  grid-template-columns: minmax(200px, 1fr) minmax(320px, 1.35fr) minmax(200px, 1fr);
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  box-shadow: 0 -8px 40px rgba(0, 0, 0, 0.35);
  background: var(--bar-bg);
}

.now {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.cover-btn {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  line-height: 0;
}
.cover-btn .expand {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  opacity: 0;
  transition: opacity 0.2s;
}
.cover-btn:hover .expand {
  opacity: 1;
}

.meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.meta strong {
  font-size: 13.5px;
  font-weight: 600;
}
.meta p {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}

.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 6px;
}

.play-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  /* 强调色渐变（与 MiniPlayer 播放键一致）：色板切换时这是最直观的变化点 */
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  color: #fff;
  display: grid;
  place-items: center;
  margin: 0 4px;
  transition: transform 0.15s var(--ease), box-shadow 0.2s;
  box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 45%, transparent);
}
.play-btn:hover {
  transform: scale(1.06);
}
.play-btn:active {
  transform: scale(0.96);
}
.play-btn.loading {
  background: rgba(255, 255, 255, 0.14);
  box-shadow: none;
}

.ring {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}

.timeline {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.time {
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  width: 34px;
  text-align: center;
}

.right {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.quality {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent);
  color: color-mix(in srgb, var(--accent) 82%, #fff);
  margin-right: 2px;
  white-space: nowrap;
}

.volume {
  -webkit-appearance: none;
  appearance: none;
  width: 78px;
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    90deg,
    var(--accent) var(--vol),
    rgba(255, 255, 255, 0.14) var(--vol)
  );
  outline: none;
  cursor: pointer;
}
.volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
  opacity: 0;
  transition: opacity 0.15s;
}
.volume:hover::-webkit-slider-thumb {
  opacity: 1;
}

/* 移动端：单行紧凑条——封面 + 歌名 + 上一首/播放/下一首 + 队列。
   完整控制（进度/音质/音量/收藏等）都在点击封面展开的歌词舞台里 */
@media (max-width: 640px) {
  .playerbar {
    padding: 0 8px 6px;
  }
  .pb {
    height: calc(var(--player) - 8px);
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    padding: 0 10px;
    border-radius: 14px;
  }
  /* 点整行任意处展开歌词舞台（封面按钮原本就带这个行为） */
  .now .icon-btn {
    display: none;
  }
  .now {
    gap: 10px;
    cursor: pointer;
  }
  .center {
    flex-direction: row;
    gap: 0;
  }
  .timeline {
    display: none;
  }
  .controls {
    gap: 2px;
  }
  /* 播放模式按钮退场（模式切换在歌词舞台里） */
  .controls .icon-btn:first-child {
    display: none;
  }
  .controls .icon-btn {
    width: 38px;
    height: 38px;
  }
  .play-btn {
    width: 42px;
    height: 42px;
  }
  .meta strong {
    font-size: 13px;
  }
  .meta p {
    font-size: 11px;
  }
}
</style>
