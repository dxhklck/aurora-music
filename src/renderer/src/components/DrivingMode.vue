<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import AudioWave from './AudioWave.vue'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import { speakNowPlaying, cancelTts } from '../core/tts'
import { audio } from '../core/audio'
import { wave } from '../core/wave'
import { formatDuration } from '@shared/lyric'

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
const coverSeed = computed(() => (song.value ? `${song.value.platform}:${song.value.id}` : 'aurora'))
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

/** 音源强调色注入：极光背景跟随当前音源渐变（app store 的 accent 是 [c1, c2]） */
const accentVars = computed(() => {
  const [c1, c2] = app.accent
  return { '--drive-c1': c1, '--drive-c2': c2 }
})
/** canvas 里 mix() 只认六位 hex；音源强调色都是 hex，留个兜底防脏数据 */
const waveColors = computed<[string, string]>(() => {
  const hex = (value: string, fallback: string): string =>
    /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
  return [hex(app.accent[0], '#8b7cff'), hex(app.accent[1], '#3ec5ff')]
})

/* ---------------- 音乐驱动的光影 ----------------
   不按固定秒数扫光：每帧从 analyser 取低/中/高频能量，低频负责呼吸与鼓点，
   中高频负责光弧与封面光圈。暂停或拿不到真实频谱时收回到静息态，不再假装跟歌。 */
const light = ref({ bass: 0, mid: 0, treble: 0, beat: 0 })
const lightVars = computed(() => ({
  '--drive-bass': light.value.bass.toFixed(3),
  '--drive-mid': light.value.mid.toFixed(3),
  '--drive-treble': light.value.treble.toFixed(3),
  '--drive-beat': light.value.beat.toFixed(3)
}))
let lightRaf = 0
let pulseAvg = 0
let beatAt = 0
let offPlaying: (() => void) | null = null

function attachWave(): void {
  wave.attach(audio.mediaEl, audio.secondaryEl)
  audio.syncGraph()
  wave.resume()
}

/** 按实际采样率分箱；低频取 40~250Hz，中频 250Hz~2kHz，高频 2k~8kHz */
function bandEnergy(freq: Uint8Array, fromHz: number, toHz: number): number {
  const binHz = wave.binHz
  const start = Math.max(1, Math.floor(fromHz / binHz))
  const end = Math.min(freq.length, Math.ceil(toHz / binHz))
  let sum = 0
  for (let i = start; i < end; i++) sum += freq[i]
  return end > start ? sum / (end - start) / 255 : 0
}

function timeRms(time: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < time.length; i++) {
    const v = (time[i] - 128) / 128
    sum += v * v
  }
  return time.length ? Math.sqrt(sum / time.length) : 0
}

function lightFrame(): void {
  lightRaf = requestAnimationFrame(lightFrame)
  const playing = player.playing
  const freq = wave.freq()
  const simulated = wave.checkSimulated(playing)
  if (simulated || !playing) {
    light.value = { bass: 0, mid: 0, treble: 0, beat: 0 }
    pulseAvg = 0
    return
  }
  const low = bandEnergy(freq, 40, 250)
  const mid = Math.min(1, bandEnergy(freq, 250, 2000) * 2)
  const treble = Math.min(1, bandEnergy(freq, 2000, 8000) * 2.6)
  // 鼓点用「低频 + 时域 RMS」合成：真鼓有低频瞬态，电子/人声节拍靠 RMS 起伏
  const rms = timeRms(wave.time())
  const pulse = Math.max(low * 2.2, Math.min(1, rms * 9))
  const bass = Math.min(1, Math.max(mid * 0.72, pulse))
  const now = performance.now()
  // 瞬时脉冲越过滑动均值即一个节拍；衰减 220ms，连续鼓点会重新点火
  const hit = pulse > pulseAvg * 1.22 && pulse > 0.12 && now - beatAt > 160
  if (hit) beatAt = now
  pulseAvg = pulseAvg * 0.94 + pulse * 0.06
  const beat = Math.max(0, 1 - (now - beatAt) / 220)
  const prev = light.value
  const ease = (to: number, from: number, rise = 0.42): number =>
    from + (to - from) * (to > from ? rise : 0.12)
  light.value = {
    bass: ease(bass, prev.bass),
    mid: ease(mid, prev.mid),
    treble: ease(treble, prev.treble),
    beat: hit ? 1 : beat
  }
}

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
  cancelAnimationFrame(lightRaf)
  offPlaying?.()
  offPlaying = null
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
  // 驾驶模式自身也要挂接频谱（此前只有「正在播放」舞台会挂），真实数据才能驱动光影
  attachWave()
  offPlaying = audio.on('playing', (isPlaying) => {
    if (!isPlaying) return
    attachWave()
  })
  lightRaf = requestAnimationFrame(lightFrame)
})
</script>

<template>
  <div
    class="driving"
    :class="{ playing: player.playing }"
    :style="[accentVars, lightVars]"
    @contextmenu.prevent
  >
    <!-- 极光背景：五团彩色光斑漂移，动的是 transform/opacity，不触发重排 -->
    <div class="glow">
      <i class="blob one" /><i class="blob two" /><i class="blob three" /><i class="blob four" />
      <i class="blob five" />
      <i class="veil" />
      <i class="beat-ray left" /><i class="beat-ray right" />
    </div>

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
    <p class="esc-tip">或按 <kbd>Esc</kbd> 退出</p>

    <div class="status">
      <span class="dot" :class="{ on: player.playing }" />
      <span>{{ player.playing ? '正在播放' : '已暂停' }}</span>
      <em v-if="modeLabel">· {{ modeLabel }}</em>
    </div>

    <div v-if="song" class="stage">
      <div class="cover-stage">
        <i class="cover-reflection" />
        <i class="cover-halo" />
        <i class="cover-orbit" />
        <div class="cover-wave">
          <AudioWave mode="ring" :colors="waveColors" :cx="0.5" :cy="0.5" />
        </div>
        <CoverArt
          class="cover-art"
          :src="song.coverUrl ?? null"
          :seed="coverSeed"
          :size="220"
          :radius="110"
          :spinning="player.playing"
          :song="song"
        />
        <i class="cover-glow" />
      </div>
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
        <span class="time">{{ formatDuration(player.time) }}</span>
        <div class="track">
          <div class="fill" :style="{ width: `${player.progress * 100}%` }">
            <i v-if="player.progress > 0.001" class="head" />
          </div>
        </div>
        <span class="time">{{ formatDuration(player.duration) }}</span>
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
  /* 深空底 + 音源强调色打底：高对比、夜间不刺眼 */
  background:
    radial-gradient(130% 76% at 50% -8%, #191331 0%, #0a0714 52%, #050507 100%);
  color: #fff;
  overflow: hidden;
  user-select: none;
  touch-action: none;
}

.glow {
  position: absolute;
  inset: -20%;
  pointer-events: none;
}
.blob {
  position: absolute;
  display: block;
  width: min(62vw, 760px);
  height: min(62vw, 760px);
  border-radius: 50%;
  filter: blur(72px);
  mix-blend-mode: screen;
  will-change: transform;
}
.blob.one {
  top: -16%;
  left: -14%;
  opacity: 0.9;
  background: radial-gradient(
    circle at 36% 36%,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 86%, #ffffff),
    transparent 66%
  );
  animation: drive-drift-a 11s ease-in-out infinite alternate;
}
.blob.two {
  right: -16%;
  top: 12%;
  opacity: 0.8;
  background: radial-gradient(
    circle at 58% 44%,
    color-mix(in srgb, var(--drive-c2, #2f2a6b) 48%, #7c6cff),
    transparent 68%
  );
  animation: drive-drift-b 13s ease-in-out infinite alternate;
}
.blob.three {
  left: -8%;
  bottom: -26%;
  opacity: 0.78;
  background: radial-gradient(
    circle at 50% 50%,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 66%, #3ec5ff),
    transparent 70%
  );
  animation: drive-drift-c 15s ease-in-out infinite alternate;
}
.blob.four {
  right: -6%;
  top: -12%;
  width: min(40vw, 460px);
  height: min(40vw, 460px);
  opacity: 0.6;
  background: radial-gradient(circle at 50% 50%, #3ec5ff, transparent 68%);
  animation: drive-drift-b 9s ease-in-out infinite alternate-reverse;
}
.blob.five {
  left: -14%;
  top: 38%;
  width: min(44vw, 500px);
  height: min(44vw, 500px);
  opacity: 0.55;
  background: radial-gradient(
    circle at 50% 50%,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 52%, #ff5fa2),
    transparent 70%
  );
  animation: drive-drift-a 14s ease-in-out infinite alternate-reverse;
}
/* 鼓点光翼：亮度/伸展只由 --drive-beat 决定，没有定时扫光 */
.beat-ray {
  position: absolute;
  top: 18%;
  width: 38%;
  height: 64%;
  background: radial-gradient(
    ellipse at 50% 50%,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 72%, transparent),
    transparent 70%
  );
  filter: blur(30px);
  mix-blend-mode: screen;
  opacity: calc(var(--drive-beat, 0) * 0.7);
  transform: scaleX(calc(0.55 + var(--drive-beat, 0) * 0.75));
  will-change: opacity, transform;
}
.beat-ray.left {
  left: -8%;
  transform-origin: 100% 50%;
}
.beat-ray.right {
  right: -8%;
  transform-origin: 0 50%;
  background: radial-gradient(
    ellipse at 50% 50%,
    color-mix(in srgb, var(--drive-c2, #3ec5ff) 70%, transparent),
    transparent 70%
  );
}
/* 只压暗顶部/底部与中间一小块：光斑要看得见，白字也要读得清 */
.veil {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      180deg,
      rgba(5, 5, 7, 0.66) 0%,
      rgba(5, 5, 7, 0) 20%,
      rgba(5, 5, 7, 0) 74%,
      rgba(5, 5, 7, 0.78) 100%
    ),
    radial-gradient(84% 52% at 50% 42%, rgba(5, 5, 7, 0.24), transparent 72%);
}
@keyframes drive-drift-a {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(14%, 10%, 0) scale(1.16); }
}
@keyframes drive-drift-b {
  from { transform: translate3d(0, 0, 0) scale(1.08); }
  to { transform: translate3d(-16%, -8%, 0) scale(0.94); }
}
@keyframes drive-drift-c {
  from { transform: translate3d(0, 0, 0) scale(0.96); }
  to { transform: translate3d(10%, -12%, 0) scale(1.12); }
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

.exit,
.esc-tip,
.status,
.stage,
.controls,
.bottom {
  position: relative;
  z-index: 1;
}

.esc-tip {
  margin: 10px 0 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}
.esc-tip kbd {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  font: inherit;
  font-size: 11px;
}

.status {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
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
  background: var(--drive-c1, #7c6cff);
  box-shadow: 0 0 12px var(--drive-c1, #7c6cff);
  animation: drive-dot-pulse 2.2s ease-in-out infinite;
}
@keyframes drive-dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.55; transform: scale(0.72); }
}

.stage {
  position: relative;
  z-index: 1;
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 8px;
  min-height: 0;
  width: 100%;
  text-align: center;
}
.stage > * {
  flex: none;
}

.cover-stage {
  position: relative;
  width: 260px;
  height: 260px;
  display: grid;
  place-items: center;
  margin-bottom: 4px;
}
/* 舞台地灯：亮度与横向铺展跟低频走，鼓点再叠一层亮度 */
.cover-reflection {
  position: absolute;
  z-index: 0;
  left: 50%;
  bottom: -4%;
  width: 76%;
  height: 24%;
  border-radius: 50%;
  background: radial-gradient(
    ellipse at 50% 30%,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 62%, #ffffff),
    color-mix(in srgb, var(--drive-c2, #2f2a6b) 42%, #3ec5ff) 44%,
    transparent 72%
  );
  filter: blur(18px);
  opacity: calc(0.16 + var(--drive-bass, 0) * 0.58 + var(--drive-beat, 0) * 0.24);
  transform: translateX(-50%) scaleX(calc(0.82 + var(--drive-bass, 0) * 0.42));
  will-change: opacity, transform;
}
/* 呼吸光晕：低频负责大小与亮度，暂停时保留一层很弱的底光 */
.cover-halo {
  position: absolute;
  width: 84%;
  height: 84%;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 38%, transparent),
    transparent 66%
  );
  filter: blur(18px);
  opacity: calc(0.34 + var(--drive-bass, 0) * 0.6);
  transform: scale(calc(0.9 + var(--drive-bass, 0) * 0.24 + var(--drive-beat, 0) * 0.08));
  will-change: opacity, transform;
}
.cover-orbit {
  position: absolute;
  inset: -11%;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg 40deg,
    color-mix(in srgb, var(--drive-c1, #7c6cff) 70%, transparent) 74deg,
    transparent 122deg 206deg,
    color-mix(in srgb, var(--drive-c2, #2f2a6b) 60%, #3ec5ff) 246deg,
    transparent 300deg 360deg
  );
  filter: blur(calc(3px + var(--drive-mid, 0) * 5px));
  opacity: calc(0.4 + var(--drive-mid, 0) * 0.5 + var(--drive-beat, 0) * 0.18);
  transform: scale(calc(0.97 + var(--drive-mid, 0) * 0.06));
  animation: drive-orbit 18s linear infinite;
  mask: radial-gradient(circle, transparent 57%, #000 61%);
  -webkit-mask: radial-gradient(circle, transparent 57%, #000 61%);
  will-change: opacity, transform, filter;
}
@keyframes drive-orbit {
  from { rotate: 0deg; }
  to { rotate: 360deg; }
}
/* canvas 比封面大：ring 模式的光条从半径 0.3*边长 往外画 */
.cover-wave {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 460px;
  height: 460px;
  transform: translate(-50%, -50%);
  opacity: 0.92;
  pointer-events: none;
}
.cover-art {
  position: relative;
  z-index: 1;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.62),
    0 0 calc(28px + var(--drive-bass, 0) * 76px)
      color-mix(in srgb, var(--drive-c1, #7c6cff) 32%, transparent);
  will-change: box-shadow;
}
/* 封面边缘的高频亮度：旋律/镲片越亮，光圈越明显，不做定时掠光 */
.cover-glow {
  position: absolute;
  z-index: 2;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, calc(0.12 + var(--drive-treble, 0) * 0.45));
  box-shadow:
    inset 0 0 calc(10px + var(--drive-treble, 0) * 36px)
      rgba(255, 255, 255, calc(var(--drive-treble, 0) * 0.3)),
    0 0 calc(8px + var(--drive-mid, 0) * 42px)
      color-mix(in srgb, var(--drive-c2, #3ec5ff) 60%, transparent);
  opacity: calc(0.24 + var(--drive-treble, 0) * 0.7 + var(--drive-beat, 0) * 0.2);
  pointer-events: none;
  will-change: opacity, box-shadow, border-color;
}
/* 驾驶模式里的封面必须持续旋转：系统「减弱动态效果」不该把它变成静止唱片 */
.playing .cover-art.spinning {
  animation: drive-turn 18s linear infinite;
}
@keyframes drive-turn {
  to { transform: rotate(360deg); }
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
  margin: 6px 0 0;
  font-size: clamp(16px, 2vw, 26px);
  font-weight: 700;
  color: #fff;
  text-shadow: 0 0 28px color-mix(in srgb, var(--drive-c1, #7c6cff) 32%, transparent);
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
  position: relative;
  width: 132px;
  height: 132px;
  border: 0;
  color: #0b0716;
  background:
    radial-gradient(120% 120% at 26% 14%, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0) 46%),
    linear-gradient(
      142deg,
      color-mix(in srgb, var(--drive-c1, #7c6cff) 66%, #ffffff),
      color-mix(in srgb, var(--drive-c2, #2f2a6b) 42%, #7c6cff)
    );
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.34) inset,
    0 16px 44px color-mix(in srgb, var(--drive-c1, #7c6cff) 32%, transparent),
    0 0 84px color-mix(in srgb, var(--drive-c1, #7c6cff) 42%, transparent);
}
/* 播放中：外圈呼吸光环，暂停即停（移动版同款） */
.playing .big.main::after {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--drive-c1, #7c6cff) 70%, transparent);
  animation: drive-ring-pulse 2.6s ease-out infinite;
}
@keyframes drive-ring-pulse {
  0% { opacity: 0.8; transform: scale(1); }
  70%, 100% { opacity: 0; transform: scale(1.22); }
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
  width: 52px;
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
}
.fill {
  position: relative;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--drive-c1, #7c6cff), var(--drive-c2, #b9aeff));
  box-shadow: 0 0 16px color-mix(in srgb, var(--drive-c1, #7c6cff) 32%, transparent);
  transition: width 0.4s linear;
}
.fill .head {
  position: absolute;
  top: 50%;
  right: -4px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 14px var(--drive-c1, #7c6cff), 0 0 4px rgba(255, 255, 255, 0.9);
  transform: translateY(-50%);
}
.hint {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}
</style>
