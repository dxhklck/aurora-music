<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import Icon from './Icon.vue'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import { speakNowPlaying, cancelTts } from '../core/tts'

/**
 * 驾驶模式：全屏大按钮覆盖层（移植自移动版 DrivingMode）。
 *
 * 行车场景三原则：
 *  1. 目标要大——三键控制在 96/128px 级别，进度条只读（误触不跳歌）；
 *  2. 退出要难——长按 800ms 才退出，轻碰只提示（防止颠簸中误退）；
 *  3. 全局键让路——App.vue 在驾驶态屏蔽空格/方向键，媒体键走主进程快捷键不受影响。
 *
 * TTS 播报（桌面版新增，移动版没有）：切歌时系统语音念「歌名，歌手」，
 * 走 Web Speech API 本地语音（离线可用），设置项 driveModeTts 控制。
 */

const player = usePlayerStore()
const app = useAppStore()
const playlists = usePlaylistStore()

const song = computed(() => player.displaySong)
const favorite = computed(() => (song.value ? playlists.isFavorite(song.value) : false))
/** 当前行歌词（驾驶模式下用大字号当「报站」，不逐字扫光——省视觉注意力） */
const lyricLine = computed(() => player.lyric?.lines[player.activeLyricIndex]?.text ?? '')
const modeLabel = computed(() => {
  switch (player.mode) {
    case 'order':
      return '顺序'
    case 'loop':
      return '列表循环'
    case 'single':
      return '单曲循环'
    default:
      return '随机'
  }
})

/** 时间显示（秒 → m:ss） */
function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 音源强调色注入：极光背景跟随当前音源渐变（app store 的 accent 是 [c1, c2]） */
const accentVars = computed(() => {
  const [c1, c2] = app.accent
  return { '--drive-c1': c1, '--drive-c2': c2 }
})

/* ---------------- 长按退出 ----------------
   pointerdown 起 800ms 计时；提前松手 toast 提示（移动版同款交互）。
   touch-action:none + contextmenu.prevent：触屏长按不能让系统手势/右键菜单抢走。 */
const EXIT_PRESS_MS = 800
let exitTimer: number | null = null

function startExitPress(): void {
  if (exitTimer !== null) window.clearTimeout(exitTimer)
  exitTimer = window.setTimeout(() => {
    exitTimer = null
    player.closeDriving()
  }, EXIT_PRESS_MS)
}

function cancelExitPress(early: boolean): void {
  if (exitTimer === null) return
  window.clearTimeout(exitTimer)
  exitTimer = null
  if (early) app.toast('长按 0.8 秒退出驾驶模式', 'info')
}

onBeforeUnmount(() => {
  if (exitTimer !== null) window.clearTimeout(exitTimer)
  cancelTts()
})

/* ---------------- TTS 播报 ----------------
   watch displaySong 的曲目键：playAt/crossfade/自动连播最终都收敛到
   resolvedSong 更新，displaySong 是「实际听到哪首」的单一事实源。
   放组件内挂 watch——离开驾驶模式 watcher 自动销毁，不留全局副作用。 */
watch(
  () => {
    const s = player.displaySong
    return s ? `${s.platform}:${s.id}` : ''
  },
  (key, oldKey) => {
    if (!key || key === oldKey) return
    if (!player.showDriving || !player.playing) return
    speakNowPlaying(player.displaySong, app.settings?.driveModeTts !== false)
  }
)

onMounted(() => {
  // 进入驾驶模式时正在播：先报一次当前曲目
  if (player.playing) speakNowPlaying(player.displaySong, app.settings?.driveModeTts !== false)
})
</script>

<template>
  <div class="driving" :style="accentVars" @contextmenu.prevent>
    <!-- 极光背景：两个大光斑跟随音源强调色，恒深色底保证白字对比 -->
    <div class="blob one" />
    <div class="blob two" />

    <!-- 退出：长按 800ms。提前松手在 pointerup 里提示 -->
    <button
      class="exit"
      @pointerdown.prevent="startExitPress"
      @pointerup="cancelExitPress(true)"
      @pointerleave="cancelExitPress(true)"
      @pointercancel="cancelExitPress(true)"
    >
      <Icon name="close" :size="16" />
      <span>长按退出驾驶模式</span>
    </button>

    <div class="status">
      <span class="dot" :class="{ on: player.playing }" />
      <span>{{ player.playing ? '正在播放' : '已暂停' }}</span>
      <em v-if="modeLabel">· {{ modeLabel }}</em>
    </div>

    <div v-if="song" class="stage">
      <h1 class="name">{{ song.name }}</h1>
      <p class="artist">{{ song.artists.join(' / ') || '未知歌手' }}</p>
      <p class="line" :class="{ dim: !lyricLine }">{{ lyricLine || '♪' }}</p>
    </div>
    <div v-else class="stage empty">
      <Icon name="car" :size="56" />
      <strong>队列为空</strong>
      <p>退出驾驶模式，去挑几首歌再回来</p>
    </div>

    <div class="controls">
      <button class="big side" title="上一首" :disabled="!player.queue.length" @click="player.prev()">
        <Icon name="prev" :size="44" />
      </button>
      <button
        class="big main"
        title="播放 / 暂停"
        :disabled="!player.queue.length && !player.displaySong"
        @click="player.toggle()"
      >
        <Icon :name="player.playing ? 'pause' : 'play'" :size="60" />
      </button>
      <button class="big side" title="下一首" :disabled="!player.queue.length" @click="player.next()">
        <Icon name="next" :size="44" />
      </button>
    </div>

    <div class="bottom">
      <div class="meta">
        <button
          class="pill"
          :class="{ on: favorite }"
          title="收藏"
          :disabled="!song"
          @click="song && playlists.toggleFavorite(song)"
        >
          <Icon :name="favorite ? 'heart-filled' : 'heart'" :size="16" />
        </button>
        <button class="pill" title="切换播放模式" @click="player.cycleMode()">
          <Icon name="repeat" :size="16" />
          <span>{{ modeLabel }}</span>
        </button>
      </div>
      <div class="progress">
        <span class="time">{{ fmt(player.time) }}</span>
        <div class="track">
          <div class="fill" :style="{ width: `${player.progress * 100}%` }" />
        </div>
        <span class="time">{{ fmt(player.duration) }}</span>
      </div>
      <p class="hint">进度条只读 · 误触不会跳歌</p>
    </div>
  </div>
</template>

<style scoped>
.driving {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 28px 32px 22px;
  /* 深色底 + 音源强调色光斑：高对比、夜间不刺眼 */
  background: #05060a;
  color: #fff;
  overflow: hidden;
  user-select: none;
  touch-action: none;
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(110px);
  opacity: 0.4;
  pointer-events: none;
}
.blob.one {
  width: 56vw;
  height: 56vw;
  left: -12vw;
  top: -18vw;
  background: var(--drive-c1, #7c6cff);
}
.blob.two {
  width: 48vw;
  height: 48vw;
  right: -10vw;
  bottom: -16vw;
  background: var(--drive-c2, #4facfe);
}

.exit {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}
.exit:hover {
  background: rgba(255, 255, 255, 0.14);
}
.exit:active {
  background: rgba(255, 255, 255, 0.22);
}

.status {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.65);
}
.status em {
  font-style: normal;
  opacity: 0.8;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
}
.dot.on {
  background: #6ee7a0;
  box-shadow: 0 0 10px rgba(110, 231, 160, 0.6);
}

.stage {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 10px;
  min-height: 0;
  width: 100%;
  text-align: center;
}
.name {
  margin: 0;
  font-size: clamp(28px, 4.4vw, 52px);
  font-weight: 800;
  letter-spacing: -0.5px;
  line-height: 1.2;
  max-width: 88%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.artist {
  margin: 0;
  font-size: clamp(15px, 1.8vw, 22px);
  color: rgba(255, 255, 255, 0.72);
}
.line {
  margin: 14px 0 0;
  font-size: clamp(14px, 1.6vw, 20px);
  color: rgba(255, 255, 255, 0.55);
  max-width: 80%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.line.dim {
  opacity: 0.4;
}

.stage.empty {
  gap: 12px;
  color: rgba(255, 255, 255, 0.6);
}
.stage.empty strong {
  font-size: 22px;
  color: #fff;
}
.stage.empty p {
  margin: 0;
  font-size: 13px;
}

.controls {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: clamp(28px, 6vw, 72px);
  margin: 8px 0 14px;
}
.big {
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.09);
  border: 1px solid rgba(255, 255, 255, 0.16);
  color: #fff;
  cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
.big:active {
  transform: scale(0.94);
  background: rgba(255, 255, 255, 0.18);
}
.big:disabled {
  opacity: 0.35;
  cursor: default;
  transform: none;
}
.big.side {
  width: 96px;
  height: 96px;
}
.big.main {
  width: 132px;
  height: 132px;
  background: linear-gradient(135deg, var(--drive-c1, #7c6cff), var(--drive-c2, #4facfe));
  border: none;
  box-shadow: 0 14px 44px color-mix(in srgb, var(--drive-c1, #7c6cff) 45%, transparent);
}

.bottom {
  position: relative;
  z-index: 1;
  width: min(680px, 86%);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.meta {
  display: flex;
  justify-content: center;
  gap: 10px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: rgba(255, 255, 255, 0.85);
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s;
}
.pill:hover {
  background: rgba(255, 255, 255, 0.14);
}
.pill:disabled {
  opacity: 0.4;
}
.pill.on {
  color: #ff8aa8;
  border-color: rgba(255, 138, 168, 0.4);
}
.progress {
  display: flex;
  align-items: center;
  gap: 12px;
}
.time {
  flex: none;
  width: 44px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.6);
  font-variant-numeric: tabular-nums;
}
.time:last-child {
  text-align: right;
}
.track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--drive-c1, #7c6cff), var(--drive-c2, #4facfe));
  transition: width 0.4s linear;
}
.hint {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}
</style>
