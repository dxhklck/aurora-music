<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import LyricPane from './LyricPane.vue'
import ProgressBar from './ProgressBar.vue'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import { audio } from '../core/audio'
import { wave } from '../core/wave'
import AudioWave from './AudioWave.vue'
import EqualizerPanel from './EqualizerPanel.vue'
import { formatDuration } from '@shared/lyric'

type NowPlayingStyle = 'vinyl' | 'lyrics' | 'cover'

const player = usePlayerStore()
const app = useAppStore()
const playlists = usePlaylistStore()

const song = computed(() => player.displaySong)
const seed = computed(() => (song.value ? `${song.value.platform}:${song.value.id}` : 'aurora'))
const backdrop = computed(() => song.value?.coverUrl ?? '')
const modeIcon = computed(
  () =>
    ({ loop: 'repeat', single: 'repeat-one', shuffle: 'shuffle', order: 'list' })[player.mode]
)
const style = computed<NowPlayingStyle>(() => app.settings?.nowPlayingStyle ?? 'vinyl')
const stylePanel = ref(false)
/** 均衡器面板与样式面板共用右上角的位置，同时只开一个 */
const eqPanel = ref(false)
/** 睡眠定时面板，与上面两个面板互斥 */
const sleepPanel = ref(false)

function toggleEqualizer(): void {
  eqPanel.value = !eqPanel.value
  if (eqPanel.value) {
    stylePanel.value = false
    sleepPanel.value = false
  }
}

/* ---------------- 睡眠定时 ---------------- */
const sleepOptions: { id: 'off' | '15' | '30' | '60' | 'eof'; name: string; desc: string }[] = [
  { id: '15', name: '15 分钟', desc: '听一会儿就停' },
  { id: '30', name: '30 分钟', desc: '午休 / 小憩' },
  { id: '60', name: '60 分钟', desc: '一整晚的大段' },
  { id: 'eof', name: '播完这首就停', desc: '当前曲目结束后暂停' }
]

/** 按钮角标文案：倒计时显示 mm:ss，播完停显示「播完」 */
const sleepLabel = computed(() => {
  if (player.sleepMode === 'off') return ''
  if (player.sleepMode === 'eof') return '播完'
  const m = Math.floor(player.sleepRemain / 60)
  const s = player.sleepRemain % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

function pickSleep(id: 'off' | '15' | '30' | '60' | 'eof'): void {
  player.setSleep(id)
  sleepPanel.value = false
  app.toast(
    id === 'off'
      ? '睡眠定时已关闭'
      : id === 'eof'
        ? '播完当前这首就停'
        : `将在 ${id} 分钟后暂停`,
    'info'
  )
}

async function toggleFav(): Promise<void> {
  if (!song.value) return
  await playlists.toggleFavorite(song.value)
}

const styleOptions: { id: NowPlayingStyle; name: string; desc: string }[] = [
  { id: 'vinyl', name: '黑胶经典', desc: '旋转唱片 + 唱臂 + 侧边歌词' },
  { id: 'lyrics', name: '歌词大屏', desc: '全屏大字歌词，跟唱沉浸' },
  { id: 'cover', name: '封面沉浸', desc: '大封面 + 歌曲信息，纯净无歌词' }
]

type PlayerTheme = 'aurora' | 'neon' | 'ocean' | 'sunset' | 'galaxy'
const theme = computed<PlayerTheme>(() => app.settings?.playerTheme ?? 'aurora')

const themeOptions: { id: PlayerTheme; name: string; color: string }[] = [
  { id: 'aurora', name: '极光（默认）', color: 'linear-gradient(135deg, #7c6cff, #2a1d6e)' },
  { id: 'neon', name: '流光溢彩', color: 'linear-gradient(135deg, #ff4dd8, #22d3ee)' },
  { id: 'ocean', name: '碧海潮声', color: 'linear-gradient(135deg, #0ea5e9, #10b981)' },
  { id: 'sunset', name: '落日熔金', color: 'linear-gradient(135deg, #fb923c, #e11d74)' },
  { id: 'galaxy', name: '星河流转', color: 'linear-gradient(135deg, #312e81, #c026d3)' }
]

/** 每款皮肤的招牌音波：形态 + 双色，切皮肤 = 换背景 + 换音波，肉眼可辨 */
const WAVES: Record<PlayerTheme, { mode: 'bars' | 'wave' | 'ring'; colors: [string, string] }> = {
  aurora: { mode: 'bars', colors: ['#8b7cff', '#3ec5ff'] },
  neon: { mode: 'wave', colors: ['#ff4dd8', '#22d3ee'] },
  ocean: { mode: 'ring', colors: ['#38bdf8', '#34d399'] },
  sunset: { mode: 'bars', colors: ['#fbbf24', '#f43f5e'] },
  galaxy: { mode: 'ring', colors: ['#818cf8', '#e879f9'] }
}
const waveStyle = computed(() => WAVES[theme.value])
/** ring 形态圆心对准唱片：黑胶布局的唱片在左列中心，其余布局居中 */
const waveCx = computed(() => (style.value === 'vinyl' ? 0.25 : 0.5))
const waveCy = computed(() => (style.value === 'vinyl' ? 0.46 : 0.5))

function pickStyle(id: NowPlayingStyle): void {
  if (id !== style.value) void app.patchSettings({ nowPlayingStyle: id })
}

function pickTheme(id: PlayerTheme): void {
  if (id !== theme.value) void app.patchSettings({ playerTheme: id })
}

function close(): void {
  player.showNowPlaying = false
}

function seek(ratio: number): void {
  player.seekTo(ratio * (player.duration || 0))
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (eqPanel.value) {
      eqPanel.value = false
      return
    }
    if (stylePanel.value) {
      stylePanel.value = false
      return
    }
    if (sleepPanel.value) {
      sleepPanel.value = false
      return
    }
    close()
  }
}

async function openDesktopLyric(): Promise<void> {
  // 静默开关：不弹提示
  await window.api.toggleLyricWindow()
}

let offResume: (() => void) | null = null

/** 竖屏紧凑布局：原生容器或窄视口（桌面窗口拖窄同样适用） */
const compact = ref(false)
/** 紧凑布局下封面 / 歌词二选一（点封面区切换） */
const mobilePane = ref<'cover' | 'lyric'>('lyric')
function syncCompact(): void {
  compact.value = window.innerWidth <= 640
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  syncCompact()
  window.addEventListener('resize', syncCompact)
  // 音波可视化：舞台是挂接点（幂等），AudioContext 被系统挂起时靠播放事件唤醒
  wave.attach(audio.mediaEl)
  offResume = audio.on('playing', (isPlaying) => {
    if (!isPlaying) return
    // 舞台可能在首次播放前就打开（此时还没有 src，挂接会跳过），
    // 每次真正开始播放都重试一次；attach 幂等，已挂接时只做 resume
    wave.attach(audio.mediaEl)
    wave.resume()
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', syncCompact)
  offResume?.()
  offResume = null
})
</script>

<template>
  <div class="stage" :class="[`style-${style}`, `theme-${theme}`]">
    <div class="bg" :style="backdrop ? { backgroundImage: `url(${backdrop})` } : {}" />
    <!-- 点暗色背景也能收起：按钮万一点不中时的不依赖焦点的出口 -->
    <div class="bg-mask" @click="close" />
    <!-- 炫彩皮肤层：aurora 主题不渲染（保持封面模糊背景）。
         必须在 bg-mask 之上——原先排在遮罩下面，光斑全被压暗，就是「皮肤看不出差别」的根因 -->
    <div v-if="theme !== 'aurora'" class="theme-layer" aria-hidden="true">
      <i class="blob a" /><i class="blob b" />
      <i v-if="theme === 'galaxy'" class="stars s1" /><i v-if="theme === 'galaxy'" class="stars s2" />
    </div>
    <!-- 真实音波可视化：形态与配色跟随皮肤 -->
    <AudioWave class="stage-wave" :mode="waveStyle.mode" :colors="waveStyle.colors" :cx="waveCx" :cy="waveCy" />

    <header class="stage-head" @click="stylePanel = false">
      <button class="collapse" @click.stop="close">
        <span class="chev">⌄</span>
        收起
      </button>
      <div class="stage-title">
        <span>正在播放</span>
        <em v-if="player.streamLabel">{{ player.streamLabel }}</em>
      </div>
      <div class="head-actions">
        <button
          class="icon-btn fav"
          :class="{ active: song && playlists.isFavorite(song) }"
          :disabled="!song"
          :title="song && playlists.isFavorite(song) ? '取消收藏' : '收藏到我喜欢'"
          @click.stop="toggleFav"
        >
          <Icon :name="song && playlists.isFavorite(song) ? 'heart-filled' : 'heart'" :size="18" />
        </button>
        <button class="icon-btn" title="加入歌单" :disabled="!song" @click.stop="song && playlists.openPicker(song)">
          <Icon name="playlist-add" :size="18" />
        </button>
        <button
          class="icon-btn sleep"
          :class="{ active: player.sleepMode !== 'off' }"
          title="睡眠定时"
          @click.stop="
            sleepPanel = !sleepPanel;
            stylePanel = false;
            eqPanel = false
          "
        >
          <Icon name="clock" :size="18" />
          <em v-if="sleepLabel" class="sleep-badge">{{ sleepLabel }}</em>
        </button>
        <button class="icon-btn" title="播放器样式" @click.stop="stylePanel = !stylePanel; sleepPanel = false">
          <Icon name="settings" :size="18" />
        </button>
        <button class="icon-btn" :class="{ active: eqPanel }" title="均衡器" @click.stop="toggleEqualizer">
          <Icon name="equalizer" :size="18" />
        </button>
        <button class="icon-btn" title="桌面歌词" @click="openDesktopLyric">
          <Icon name="monitor" :size="18" />
        </button>
      </div>
      <div v-if="sleepPanel" class="style-panel sleep-panel" @click.stop>
        <div class="panel-sec">睡眠定时</div>
        <button
          v-for="opt in sleepOptions"
          :key="opt.id"
          class="style-opt"
          :class="{ active: player.sleepMode === opt.id }"
          @click="pickSleep(opt.id)"
        >
          <strong>{{ opt.name }}</strong>
          <span>{{ opt.desc }}</span>
        </button>
        <button
          v-if="player.sleepMode !== 'off'"
          class="sleep-off"
          @click="pickSleep('off')"
        >
          关闭定时
        </button>
      </div>
      <div v-if="stylePanel" class="style-panel" @click.stop>
        <div class="panel-sec">播放器样式</div>
        <button
          v-for="opt in styleOptions"
          :key="opt.id"
          class="style-opt"
          :class="{ active: style === opt.id }"
          @click="pickStyle(opt.id)"
        >
          <strong>{{ opt.name }}</strong>
          <span>{{ opt.desc }}</span>
        </button>
        <div class="panel-sec">炫彩皮肤</div>
        <div class="theme-grid">
          <button
            v-for="opt in themeOptions"
            :key="opt.id"
            class="theme-opt"
            :class="{ active: theme === opt.id }"
            :title="opt.name"
            @click="pickTheme(opt.id)"
          >
            <i class="dot" :style="{ background: opt.color }" />
            <span>{{ opt.name }}</span>
          </button>
        </div>
      </div>
      <EqualizerPanel v-if="eqPanel" />
    </header>

    <div class="stage-body" :class="{ compact }" @click="stylePanel = false">
      <!-- 竖屏手机：封面 / 歌词二选一（轻点切换），信息居中，控制坞固定底部 -->
      <template v-if="compact">
        <div class="m-hero" @click="mobilePane = mobilePane === 'cover' ? 'lyric' : 'cover'">
          <transition name="m-pane" mode="out-in">
            <div v-if="mobilePane === 'cover'" key="cover" class="m-cover">
              <div
                class="m-glow"
                :style="backdrop ? { backgroundImage: `url(${backdrop})` } : {}"
                aria-hidden="true"
              />
              <CoverArt
                :src="song?.coverUrl ?? null"
                :seed="seed"
                :size="330"
                :radius="26"
                :song="song"
              />
              <span class="m-hint">轻点查看歌词</span>
            </div>
            <div v-else key="lyric" class="m-lyric">
              <LyricPane :lyric="player.lyric" :loading="player.lyricLoading" @seek="player.seekTo" />
              <span class="m-hint">轻点回到封面</span>
            </div>
          </transition>
        </div>

        <div class="m-meta">
          <h1 class="truncate">{{ song?.name ?? '未在播放' }}</h1>
          <p class="truncate">
            {{ song ? song.artists.join(' / ') : 'Aurora Music' }}
            <span v-if="song?.album" class="album">· {{ song.album }}</span>
          </p>
          <div class="chips">
            <span v-if="song" class="chip">{{ song.platform.toUpperCase() }}</span>
            <span v-if="player.streamLabel" class="chip">{{ player.streamLabel }}</span>
            <span v-if="player.notice" class="chip warn">{{ player.notice }}</span>
          </div>
        </div>
      </template>

      <!-- 歌词大屏：全屏大字歌词 -->
      <template v-else-if="style === 'lyrics'">
        <div class="track-info slim">
          <h1 class="truncate">{{ song?.name ?? '未在播放' }}</h1>
          <p class="truncate">
            {{ song ? song.artists.join(' / ') : 'Aurora Music' }}
            <span v-if="song?.album" class="album">· {{ song.album }}</span>
          </p>
        </div>
        <div class="lyric-box fullscreen">
          <LyricPane :lyric="player.lyric" :loading="player.lyricLoading" @seek="player.seekTo" />
        </div>
      </template>

      <!-- 封面沉浸：大封面 + 歌曲信息 -->
      <template v-else-if="style === 'cover'">
        <div class="cover-hero">
          <div class="disc hero" :class="{ spin: player.playing }">
            <CoverArt :src="song?.coverUrl ?? null" :seed="seed" :size="336" :radius="168" :song="song" />
          </div>
          <div class="track-info">
            <h1 class="truncate">{{ song?.name ?? '未在播放' }}</h1>
            <p class="truncate">
              {{ song ? song.artists.join(' / ') : 'Aurora Music' }}
              <span v-if="song?.album" class="album">· {{ song.album }}</span>
            </p>
            <div class="chips">
              <span v-if="song" class="chip">{{ song.platform.toUpperCase() }}</span>
              <span v-if="player.streamLabel" class="chip">{{ player.streamLabel }}</span>
              <span v-if="player.notice" class="chip warn">{{ player.notice }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- 黑胶经典：唱片（带唱臂） + 侧边歌词 -->
      <template v-else>
        <section class="left">
          <div class="disc-area" :class="{ playing: player.playing }">
            <div class="disc" :class="{ spin: player.playing }">
              <div class="groove" />
              <CoverArt :src="song?.coverUrl ?? null" :seed="seed" :size="252" :radius="126" :song="song" />
              <span class="hole" />
            </div>
            <!-- 唱臂：播放时搭上唱片，暂停时抬起收回（对齐 QQ 音乐播放器模式的观感） -->
            <div class="tonearm" aria-hidden="true">
              <i class="arm-base" /><i class="arm-rod" /><i class="arm-head" /><i class="arm-tip" />
            </div>
          </div>

          <div class="track-info">
            <h1 class="truncate">{{ song?.name ?? '未在播放' }}</h1>
            <p class="truncate">
              {{ song ? song.artists.join(' / ') : 'Aurora Music' }}
              <span v-if="song?.album" class="album">· {{ song.album }}</span>
            </p>
            <div class="chips">
              <span v-if="song" class="chip">{{ song.platform.toUpperCase() }}</span>
              <span v-if="player.streamLabel" class="chip">{{ player.streamLabel }}</span>
              <span v-if="player.notice" class="chip warn">{{ player.notice }}</span>
            </div>
          </div>
        </section>

        <section class="right">
          <div class="lyric-head">
            <Icon name="lyrics" :size="15" />
            <span>歌词</span>
            <em v-if="player.lyric?.source">{{ player.lyric.source }}</em>
          </div>
          <div class="lyric-box">
            <LyricPane :lyric="player.lyric" :loading="player.lyricLoading" @seek="player.seekTo" />
          </div>
        </section>
      </template>
    </div>

    <!-- 三套样式共享的底部控制坞 -->
    <div class="stage-dock">
      <div class="stage-progress">
        <ProgressBar
          :value="player.progress"
          :buffered="player.duration ? Math.min(player.buffered / player.duration, 1) : 0"
          :height="5"
          :disabled="!player.duration"
          @seek="seek"
        />
        <div class="times">
          <span>{{ formatDuration(player.time) }}</span>
          <span>{{ formatDuration(player.duration) }}</span>
        </div>
      </div>

      <div class="stage-controls">
        <button class="icon-btn" :title="player.mode" @click="player.cycleMode()">
          <Icon :name="modeIcon" :size="19" />
        </button>
        <button class="round" @click="player.prev()"><Icon name="prev" :size="22" /></button>
        <button
          class="round primary"
          :class="{ loading: player.loading || player.waiting }"
          @click="player.toggle()"
        >
          <span v-if="player.loading || player.waiting" class="ring" />
          <Icon v-else :name="player.playing ? 'pause' : 'play'" :size="24" />
        </button>
        <button class="round" @click="player.next()"><Icon name="next" :size="22" /></button>
        <button class="icon-btn" @click="player.showQueue = !player.showQueue">
          <Icon name="list" :size="20" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  background: #08080c;
  overflow: hidden;
  animation: stage-in 0.4s var(--ease);
  /* 双保险：舞台自身不参与拖拽区计算，避免顶部 48px 吞掉按钮点击 */
  -webkit-app-region: no-drag;
  /* 舞台是恒定深色的沉浸场景，与应用主题无关：在这里把中性 token 钉回深色值，
     否则浅色主题下 --text/--border 翻成深色，出现深底配深字（歌词舞台全盲）。
     强调色 --accent 与主题无关（由音源渐变色提供），不用动。 */
  --panel: rgba(255, 255, 255, 0.045);
  --panel-strong: rgba(255, 255, 255, 0.08);
  --border: rgba(255, 255, 255, 0.08);
  --border-strong: rgba(255, 255, 255, 0.14);
  --text: #f4f5f9;
  --text-2: rgba(244, 245, 249, 0.66);
  --text-3: rgba(244, 245, 249, 0.4);
}

@keyframes stage-in {
  from {
    opacity: 0;
    transform: scale(1.02);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.bg {
  position: absolute;
  top: -12%;
  right: -12%;
  bottom: -12%;
  left: -12%;
  background-size: cover;
  background-position: center;
  filter: blur(90px) saturate(1.3);
  opacity: 0.55;
  transform: scale(1.2);
}

.bg-mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background:
    radial-gradient(70% 60% at 25% 40%, rgba(8, 8, 12, 0.2), rgba(8, 8, 12, 0.86) 70%),
    linear-gradient(180deg, rgba(8, 8, 12, 0.55), rgba(8, 8, 12, 0.92));
}

/* 音波可视化层：在遮罩之上、内容之下；pointer-events none 不挡「点背景收起」 */
.stage-wave {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  pointer-events: none;
  opacity: 0.85;
}

/* ===== 炫彩皮肤层（纯 transform/opacity 合成器动画，不引图形库） ===== */
.theme-layer {
  position: absolute;
  top: -25%;
  right: -25%;
  bottom: -25%;
  left: -25%;
  pointer-events: none;
  overflow: hidden;
}
/* 炫彩主题下压低封面模糊层，让皮肤当主角 */
.stage.theme-neon .bg,
.stage.theme-ocean .bg,
.stage.theme-sunset .bg,
.stage.theme-galaxy .bg {
  opacity: 0.22;
}

.theme-layer .blob {
  position: absolute;
  width: 72vmax;
  height: 72vmax;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.55;
  will-change: transform;
}
.theme-layer .blob.a {
  top: -18%;
  left: -12%;
  animation: blob-a 19s ease-in-out infinite alternate;
}
.theme-layer .blob.b {
  bottom: -22%;
  right: -14%;
  animation: blob-b 23s ease-in-out infinite alternate;
}
@keyframes blob-a {
  0% { transform: translate3d(0, 0, 0) scale(1) rotate(0deg); }
  50% { transform: translate3d(9vw, 6vh, 0) scale(1.18) rotate(24deg); }
  100% { transform: translate3d(3vw, 14vh, 0) scale(0.92) rotate(-16deg); }
}
@keyframes blob-b {
  0% { transform: translate3d(0, 0, 0) scale(1.08) rotate(0deg); }
  50% { transform: translate3d(-8vw, -7vh, 0) scale(0.9) rotate(-20deg); }
  100% { transform: translate3d(-4vw, -12vh, 0) scale(1.2) rotate(18deg); }
}

/* neon 流光溢彩：品红 × 青 */
.stage.theme-neon .blob.a {
  background: radial-gradient(circle at 35% 40%, #ff4dd8, transparent 62%);
}
.stage.theme-neon .blob.b {
  background: radial-gradient(circle at 60% 55%, #22d3ee, transparent 60%);
}

/* ocean 碧海潮声：深海蓝 × 翡翠 */
.stage.theme-ocean .blob.a {
  background: radial-gradient(circle at 40% 35%, #0ea5e9, transparent 60%);
  opacity: 0.6;
}
.stage.theme-ocean .blob.b {
  background: radial-gradient(circle at 55% 60%, #10b981, transparent 58%);
  opacity: 0.5;
}
.stage.theme-ocean .blob.a { animation-duration: 26s; }
.stage.theme-ocean .blob.b { animation-duration: 31s; }

/* sunset 落日熔金：熔金橙 × 玫红 */
.stage.theme-sunset .blob.a {
  background: radial-gradient(circle at 45% 42%, #fb923c, transparent 58%);
  opacity: 0.62;
}
.stage.theme-sunset .blob.b {
  background: radial-gradient(circle at 55% 58%, #e11d74, transparent 58%);
  opacity: 0.52;
}

/* galaxy 星河流转：深空底 + 星星闪烁 */
.stage.theme-galaxy .blob.a {
  background: radial-gradient(circle at 40% 40%, #4338ca, transparent 58%);
  opacity: 0.5;
}
.stage.theme-galaxy .blob.b {
  background: radial-gradient(circle at 58% 58%, #a21caf, transparent 58%);
  opacity: 0.45;
}
.stage.theme-galaxy .theme-layer {
  background: radial-gradient(120% 90% at 50% 10%, #12102b, #05040c 75%);
}
.stars {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  will-change: opacity, transform;
}
.stars.s1 {
  background-image:
    radial-gradient(1.6px 1.6px at 12% 22%, rgba(255, 255, 255, 0.9), transparent 100%),
    radial-gradient(1.2px 1.2px at 32% 68%, rgba(255, 255, 255, 0.7), transparent 100%),
    radial-gradient(1.8px 1.8px at 55% 15%, rgba(214, 213, 255, 0.85), transparent 100%),
    radial-gradient(1.2px 1.2px at 71% 44%, rgba(255, 255, 255, 0.65), transparent 100%),
    radial-gradient(1.5px 1.5px at 86% 76%, rgba(200, 220, 255, 0.8), transparent 100%),
    radial-gradient(1.2px 1.2px at 44% 88%, rgba(255, 255, 255, 0.6), transparent 100%);
  animation: twinkle 3.6s ease-in-out infinite alternate;
}
.stars.s2 {
  background-image:
    radial-gradient(1.4px 1.4px at 22% 54%, rgba(255, 255, 255, 0.75), transparent 100%),
    radial-gradient(1.8px 1.8px at 48% 34%, rgba(226, 213, 255, 0.85), transparent 100%),
    radial-gradient(1.2px 1.2px at 64% 82%, rgba(255, 255, 255, 0.6), transparent 100%),
    radial-gradient(1.5px 1.5px at 78% 24%, rgba(255, 255, 255, 0.8), transparent 100%),
    radial-gradient(1.2px 1.2px at 92% 48%, rgba(214, 213, 255, 0.65), transparent 100%),
    radial-gradient(1.6px 1.6px at 8% 78%, rgba(255, 255, 255, 0.7), transparent 100%);
  animation: twinkle 4.7s ease-in-out infinite alternate-reverse;
}
@keyframes twinkle {
  from { opacity: 0.35; transform: translate3d(0, 0, 0); }
  to { opacity: 1; transform: translate3d(-1.2vw, 0.8vh, 0); }
}

/* 用户偏好减弱动态效果时，全部停住 */
@media (prefers-reduced-motion: reduce) {
  .theme-layer .blob,
  .theme-layer .stars {
    animation: none;
  }
}

.stage-head {
  position: relative;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 26px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 睡眠定时：按钮上挂剩余时间角标，激活时跟随强调色 */
.head-actions .icon-btn {
  position: relative;
}
.sleep-badge {
  position: absolute;
  bottom: -3px;
  left: 50%;
  transform: translateX(-50%);
  font-style: normal;
  font-size: 8.5px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 5px;
  background: var(--accent);
  color: #fff;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.sleep-panel {
  padding-bottom: 6px;
}
.sleep-off {
  margin: 4px 4px 2px;
  height: 32px;
  border-radius: 10px;
  font-size: 12px;
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.06);
}
.sleep-off:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
}

.style-panel {
  position: absolute;
  top: 54px;
  right: 26px;
  z-index: 6;
  width: 244px;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-radius: 16px;
  background: var(--panel-strong);
  border: 1px solid var(--border);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.style-opt {
  text-align: left;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: 12px;
  transition: background 0.15s;
}
.style-opt:hover {
  background: rgba(255, 255, 255, 0.06);
}
.style-opt.active {
  background: rgba(124, 108, 255, 0.16);
}
.style-opt strong {
  font-size: 13px;
  font-weight: 600;
}
.style-opt.active strong {
  color: #b9aeff;
}
.style-opt span {
  font-size: 11px;
  color: var(--text-3);
}

.panel-sec {
  font-size: 10.5px;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 8px 12px 4px;
}
.theme-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 0 4px 4px;
}
.theme-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  transition: background 0.15s;
}
.theme-opt:hover {
  background: rgba(255, 255, 255, 0.06);
}
.theme-opt.active {
  background: rgba(124, 108, 255, 0.16);
}
.theme-opt .dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.25);
}
.theme-opt span {
  font-size: 11.5px;
  color: var(--text-2);
  white-space: nowrap;
}
.theme-opt.active span {
  color: var(--text);
}

.collapse {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-2);
  font-size: 12.5px;
  padding: 6px 10px;
  border-radius: 999px;
  transition: all 0.2s;
}
.collapse:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}
.chev {
  font-size: 14px;
  transform: translateY(-1px);
}

.stage-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  letter-spacing: 2px;
  color: var(--text-3);
  text-transform: uppercase;
}
.stage-title em {
  font-style: normal;
  letter-spacing: 0.4px;
  text-transform: none;
  color: var(--text-2);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
}

.stage-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(360px, 0.9fr) minmax(320px, 1.1fr);
  gap: 50px;
  padding: 6px 56px 12px;
  align-items: center;
}

.left {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
  min-width: 0;
}

.disc-area {
  position: relative;
}

/* ===== 唱臂（tonearm）：轴心在右上，播放时顺时针摆上唱片，暂停时收回 ===== */
.tonearm {
  position: absolute;
  top: -18px;
  right: -64px;
  width: 150px;
  height: 300px;
  z-index: 3;
  pointer-events: none;
  transform: rotate(0deg);
  transform-origin: 110px 24px;
  transition: transform 1s cubic-bezier(0.34, 1.25, 0.5, 1);
  filter: drop-shadow(0 12px 18px rgba(0, 0, 0, 0.55));
}
.disc-area.playing .tonearm {
  transform: rotate(30deg);
}
/* 轴心底座 */
.arm-base {
  position: absolute;
  left: 92px;
  top: 6px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #4a4a52, #17171c 70%);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14), 0 4px 10px rgba(0, 0, 0, 0.5);
}
.arm-base::after {
  content: '';
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 12px;
  left: 12px;
  border-radius: 50%;
  background: #0c0c10;
  box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.18);
}
/* 臂杆：银色金属渐变 */
.arm-rod {
  position: absolute;
  left: 107px;
  top: 24px;
  width: 6px;
  height: 196px;
  border-radius: 3px;
  background: linear-gradient(90deg, #f4f4f6, #b9b9c2 55%, #7e7e88);
}
/* 唱头：微倾搭向唱片 */
.arm-head {
  position: absolute;
  left: 100px;
  top: 212px;
  width: 20px;
  height: 36px;
  border-radius: 5px;
  background: linear-gradient(180deg, #dcdce2, #8b8b95);
  transform: rotate(14deg);
  transform-origin: 50% 0;
}
/* 针尖 */
.arm-tip {
  position: absolute;
  left: 98px;
  top: 246px;
  width: 9px;
  height: 13px;
  border-radius: 2px;
  background: #e8e8ee;
  transform: rotate(14deg);
}

.disc {
  position: relative;
  width: 300px;
  height: 300px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 45%, #1b1b24, #0a0a0f 72%);
  box-shadow:
    0 40px 90px rgba(0, 0, 0, 0.6),
    inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  animation: turn 22s linear infinite;
  animation-play-state: paused;
}
.disc.spin {
  animation-play-state: running;
}
.disc.hero {
  width: 340px;
  height: 340px;
  box-shadow:
    0 50px 110px rgba(0, 0, 0, 0.65),
    inset 0 0 0 1px rgba(255, 255, 255, 0.1);
}

.groove {
  position: absolute;
  top: 14px;
  right: 14px;
  bottom: 14px;
  left: 14px;
  border-radius: 50%;
  background: repeating-radial-gradient(
    circle at 50% 50%,
    rgba(255, 255, 255, 0.045) 0 1px,
    transparent 1px 4px
  );
  opacity: 0.75;
}

.hole {
  position: absolute;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #08080c;
  box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.14);
}

@keyframes turn {
  to {
    transform: rotate(360deg);
  }
}

.track-info {
  text-align: center;
  max-width: 460px;
}
.track-info h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.3px;
}
.track-info.slim h1 {
  font-size: 19px;
}
.track-info p {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-2);
}
.album {
  color: var(--text-3);
}

.chips {
  display: flex;
  gap: 6px;
  justify-content: center;
  margin-top: 12px;
  flex-wrap: wrap;
}
.chip {
  font-size: 10px;
  letter-spacing: 0.6px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.04);
}
.chip.warn {
  color: #ffd479;
  border-color: rgba(255, 212, 121, 0.3);
}

.stage-dock {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 6px 56px 30px;
}

.stage-progress {
  width: min(560px, 82%);
}
.times {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.stage-controls {
  display: flex;
  align-items: center;
  gap: 14px;
}

.round {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border);
  color: var(--text);
  transition: all 0.2s var(--ease);
}
.round:hover {
  background: rgba(255, 255, 255, 0.16);
  transform: translateY(-1px);
}
.round.primary {
  width: 58px;
  height: 58px;
  background: linear-gradient(140deg, #fff, #d6d7e4);
  color: #101018;
  border: none;
  box-shadow: 0 12px 30px rgba(255, 255, 255, 0.18);
}
.round.primary:hover {
  filter: brightness(1.05);
}
.round.primary.loading {
  background: var(--panel-strong);
  color: var(--text-2);
  box-shadow: none;
}
.round.primary .ring {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}

.right {
  height: min(62vh, 560px);
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 18px 22px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid var(--border);
  backdrop-filter: blur(20px);
}

.lyric-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 0 6px 12px;
}
.lyric-head em {
  font-style: normal;
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-3);
  font-size: 10.5px;
  margin-left: auto;
}

.lyric-box {
  flex: 1;
  min-height: 0;
}

/* ===== 歌词大屏 ===== */
.stage.style-lyrics .stage-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 4px 56px 8px;
}
.lyric-box.fullscreen {
  width: min(880px, 94%);
}
.stage.style-lyrics .lyric-box :deep(.line) {
  font-size: 24px;
  padding: 9px 0;
}
.stage.style-lyrics .lyric-box :deep(.line.active) {
  font-size: 30px;
}
.stage.style-lyrics .lyric-box :deep(.line .trans) {
  font-size: 15px;
}

/* ===== 封面沉浸 ===== */
.stage.style-cover .stage-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.cover-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 26px;
}

@media (max-width: 1080px) {
  .stage-body {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 6px 30px 8px;
    overflow-y: auto;
  }
  .disc {
    width: 220px;
    height: 220px;
  }
  .disc.hero {
    width: 260px;
    height: 260px;
  }
  .right {
    height: 42vh;
  }
  /* 唱臂按大唱片坐标定位，小屏直接收起避免错位 */
  .tonearm {
    display: none;
  }
  .stage-dock {
    padding: 4px 30px 24px;
  }
}

/* ---------------- 竖屏手机布局（原生容器 / 窄视口） ----------------
   手机上横排双栏（唱片 + 侧边歌词）没法看：改成「封面/歌词二选一」
   的大画面 + 居中信息 + 底部控制坞，触摸目标放大到 50/66px。 */
.stage-body.compact {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  padding: 2px 20px 4px;
  overflow: hidden;
}

.m-hero {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 0;
}

.m-cover,
.m-lyric {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.m-glow {
  position: absolute;
  width: min(76vw, 320px);
  height: min(76vw, 320px);
  border-radius: 50%;
  background-size: cover;
  background-position: center;
  filter: blur(40px) saturate(1.5);
  opacity: 0.38;
  animation: m-breathe 6s ease-in-out infinite;
}

@keyframes m-breathe {
  0%,
  100% {
    transform: scale(1.04);
    opacity: 0.3;
  }
  50% {
    transform: scale(1.14);
    opacity: 0.48;
  }
}

.m-hint {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--text-3);
  opacity: 0.75;
}

.m-lyric {
  padding: 2px 0 20px;
}
.m-lyric :deep(.lyric) {
  height: 100%;
}

.m-meta {
  display: flex;
  flex-direction: column;
  gap: 5px;
  text-align: center;
  padding: 0 8px;
}
.m-meta h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: 0.01em;
}
.m-meta p {
  margin: 0;
  font-size: 13px;
  color: var(--text-2);
}
.m-meta .chips {
  margin-top: 4px;
}

.m-pane-enter-active,
.m-pane-leave-active {
  transition:
    opacity 0.18s var(--ease),
    transform 0.18s var(--ease);
}
.m-pane-enter-from {
  opacity: 0;
  transform: scale(0.97);
}
.m-pane-leave-to {
  opacity: 0;
  transform: scale(1.02);
}

@media (max-width: 640px) {
  .stage-head {
    height: 52px;
    padding: 0 16px;
  }
  .stage-dock {
    padding: 2px 20px calc(14px + env(safe-area-inset-bottom, 0px));
    gap: 12px;
  }
  .stage-progress {
    width: 100%;
  }
  .times {
    font-size: 11px;
  }
  .stage-controls {
    gap: 16px;
  }
  .stage-controls .round {
    width: 50px;
    height: 50px;
  }
  .stage-controls .round.primary {
    width: 66px;
    height: 66px;
  }
  .stage-wave {
    opacity: 0.45;
  }
}
</style>
