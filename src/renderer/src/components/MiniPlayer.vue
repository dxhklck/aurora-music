<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { formatDuration } from '@shared/lyric'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import type { LyricLine } from '@shared/types'

/**
 * 迷你播放条。三种状态：
 *
 *   1. 闲置（idle）：只显示封面 + 当前歌词，所有操作隐藏；
 *   2. 悬停（hover）：歌词淡出，露出上一首/播放/下一首与右侧动作组；
 *   3. 面板展开（panel）：窗口向下长出 320px，显示完整歌词或播放队列。
 *
 * 悬停与展开是两个独立维度：展开后把鼠标移出窗口，动作组仍然隐藏，
 * 但面板（歌词内容）保留——符合「移出只留歌词」的约定。
 */
const player = usePlayerStore()
const app = useAppStore()
const playlists = usePlaylistStore()

const song = computed(() => player.displaySong)

/* ---------------- 悬停状态 ---------------- */

const hovered = ref(false)
let leaveTimer = 0

function onEnter(): void {
  window.clearTimeout(leaveTimer)
  hovered.value = true
}

/**
 * 移出延迟 260ms 再收起。
 * 不延迟的话，鼠标贴着窗口边缘移动会反复触发 enter/leave，控制组闪烁；
 * 延迟期间若又移回来，定时器被取消，视觉上不会出现半透明中间态。
 */
function onLeave(): void {
  window.clearTimeout(leaveTimer)
  leaveTimer = window.setTimeout(() => {
    hovered.value = false
  }, 260)
}

/* ---------------- 展开面板 ---------------- */

type PanelMode = 'none' | 'lyric' | 'queue'
const panel = ref<PanelMode>('none')

/**
 * 附加区高度与生长方向：歌词/队列向下长出 320，迷你条保持在原位置（顶部）。
 * 空间不足时主进程会自动翻到另一侧。
 */
const PANEL_EXTRA: Record<Exclude<PanelMode, 'none'>, { height: number; direction: 'up' | 'down' }> = {
  lyric: { height: 320, direction: 'down' },
  queue: { height: 320, direction: 'down' }
}

const panelOpen = computed(() => panel.value !== 'none')

function togglePanel(mode: Exclude<PanelMode, 'none'>): void {
  panel.value = panel.value === mode ? 'none' : mode
}

function closePanel(): void {
  panel.value = 'none'
}

// 面板切换 → 主进程同步窗口高度与方向。窗口尺寸变化没有动画，
// 面板内容自己淡入，用 200ms 的透明度过渡掩盖高度跳变。
watch(
  panel,
  (value) => {
    if (value === 'none') {
      window.api.setMiniExtra(0, 'down')
      return
    }
    const spec = PANEL_EXTRA[value]
    window.api.setMiniExtra(spec.height, spec.direction)
  },
  { immediate: true }
)

/* ---------------- 歌词 ---------------- */

const lyricLines = computed<LyricLine[]>(() => player.lyric?.lines ?? [])
const activeLyric = computed(() => {
  const index = player.activeLyricIndex
  return index >= 0 ? (lyricLines.value[index]?.text ?? '') : ''
})

/** 主行：有歌词显示歌词；没有歌词退回歌名 */
const primaryText = computed(() => activeLyric.value || song.value?.name || '未在播放')
const secondaryText = computed(() => {
  if (!song.value) return 'Aurora Music'
  const artists = song.value.artists.join(' / ') || '未知歌手'
  // 主行已经是歌词时，副行补「歌名 · 歌手」，避免用户认不出这首歌
  return activeLyric.value ? `${song.value.name} · ${artists}` : artists
})

/** 滚轮调音量时临时顶掉副行，1.2s 后恢复 */
const hint = ref('')
let hintTimer = 0

function flashHint(text: string): void {
  hint.value = text
  window.clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    hint.value = ''
  }, 1200)
}

const secondaryDisplay = computed(() => hint.value || secondaryText.value)

/* ---------------- 闲置态歌词跑马灯 ---------------- */

const marquee = ref(false)
const marqueeStyle = ref<Record<string, string>>({})
const marqueeEl = ref<HTMLElement | null>(null)
const marqueeBox = ref<HTMLElement | null>(null)

/**
 * 文本超出容器才滚动。
 * 用 CSS transform 而不是 scrollLeft：滚动过程不产生滚动条、不会触发父级滚动，
 * 且切行时重建节点即可自然回到起点。
 */
async function measureMarquee(): Promise<void> {
  await nextTick()
  const el = marqueeEl.value
  const box = marqueeBox.value
  if (!el || !box) return
  const overflow = el.scrollWidth - box.clientWidth
  if (overflow > 6) {
    marquee.value = true
    marqueeStyle.value = {
      '--marquee-shift': `-${overflow + 8}px`,
      // 22px/s 左右，长句不会滚得太快
      '--marquee-duration': `${Math.max(6, (overflow + 8) / 22)}s`
    }
  } else {
    marquee.value = false
    marqueeStyle.value = {}
  }
}

watch(primaryText, () => void measureMarquee())
watch(marqueeBox, () => void measureMarquee())

/* ---------------- 歌词面板：自动滚动 ---------------- */

const lyricList = ref<HTMLElement | null>(null)
/** 用户手动浏览时暂停自动跟随，避免「刚滚下去就被拉回当前行」 */
let autoScrollPausedUntil = 0

function scrollToActive(smooth = true): void {
  if (panel.value !== 'lyric') return
  if (Date.now() < autoScrollPausedUntil) return
  const box = lyricList.value
  const row = box?.querySelector<HTMLElement>('.lyric-row.active')
  if (!box || !row) return
  const top = row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2
  box.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
}

function pauseAutoScroll(): void {
  autoScrollPausedUntil = Date.now() + 4500
}

watch(
  () => player.activeLyricIndex,
  () => scrollToActive()
)

watch(panel, (value) => {
  if (value === 'lyric') nextTick(() => scrollToActive(false))
  if (value === 'queue') nextTick(() => scrollQueueToActive())
})

function seekLine(line: LyricLine): void {
  // 歌词时间轴与播放时间的换算：播放时间 = 行时间 - 全局偏移
  const offset = player.lyric?.offset ?? 0
  player.seekTo(Math.max(0, line.time - offset))
}

/* ---------------- 队列面板 ---------------- */

const queueList = ref<HTMLElement | null>(null)

function scrollQueueToActive(): void {
  const box = queueList.value
  const row = box?.querySelector<HTMLElement>('.queue-row.active')
  if (!box || !row) return
  box.scrollTo({ top: Math.max(0, row.offsetTop - box.clientHeight / 2 + row.clientHeight / 2) })
}

function playQueueItem(index: number): void {
  if (index === player.index) {
    void player.toggle()
    return
  }
  void player.playAt(index)
}

/* ---------------- 动作 ---------------- */

const favorite = computed(() => playlists.isFavorite(song.value))

function toggleFavorite(): void {
  if (song.value) void playlists.toggleFavorite(song.value)
}

/**
 * 音量气泡：独立透明窗口，横向滑块 + 指向音量按钮的三角。
 * 主窗口不透明，浮层画在窗口内会露出深色底，所以只能开子窗口。
 */
function toggleVolume(): void {
  void window.api.toggleMiniVolume({
    volume: player.volume,
    muted: player.muted,
    // 独立窗口拿不到主窗口运行时设置的 CSS 变量，强调色与主题必须一起传过去
    accent: app.accent[0],
    accent2: app.accent[1],
    theme: app.settings?.themeMode === 'light' ? 'light' : 'dark'
  })
}

/** 气泡拖动滑块 → 主窗口执行 setVolume（气泡里的拖动只有这里能落地） */
let offVolumeChanged: (() => void) | null = null

// 主窗口自己的音量入口（滚轮/快捷键）与主题变化都要同步给气泡，
// 否则滑块会停在旧位置，或气泡还挂着上一个音源的强调色
watch(
  () => [player.volume, player.muted, app.accent[0], app.accent[1], app.settings?.themeMode] as const,
  ([volume, muted, accent, accent2, theme]) =>
    window.api.pushMiniVolume({
      volume,
      muted,
      accent,
      accent2,
      theme: theme === 'light' ? 'light' : 'dark'
    })
)

/** 滚轮调音量：只在迷你条上生效，面板内的滚动留给列表 */
function onVolumeWheel(event: WheelEvent): void {
  const delta = event.deltaY < 0 ? 0.05 : -0.05
  const next = Math.min(1, Math.max(0, player.volume + delta))
  player.setVolume(next)
  flashHint(`音量 ${Math.round(next * 100)}%`)
}

function expand(): void {
  void app.patchSettings({ miniMode: false })
}

function closeWindow(): void {
  window.api.winClose()
}

function onDoubleClick(event: MouseEvent): void {
  // 按钮/面板上的双击不触发展开
  if ((event.target as HTMLElement | null)?.closest('button, .panel')) return
  expand()
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && panelOpen.value) {
    event.stopPropagation()
    closePanel()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  void measureMarquee()
  offVolumeChanged = window.api.onMiniVolumeChanged((state) => {
    player.setVolume(state.volume)
  })
})

onBeforeUnmount(() => {
  window.clearTimeout(leaveTimer)
  window.clearTimeout(hintTimer)
  offVolumeChanged?.()
  window.removeEventListener('keydown', onKey)
  // 组件卸载时窗口会回到完整形态，确保主进程的展开标记同步复位
  if (panelOpen.value) window.api.setMiniExtra(0, 'down')
})
</script>

<template>
  <div
    class="mini-player"
    :class="{ 'panel-open': panelOpen, hovered }"
    @mouseenter="onEnter"
    @mouseleave="onLeave"
    @dblclick="onDoubleClick"
  >
    <div class="bar" @wheel.prevent="onVolumeWheel">
      <CoverArt
        class="cover"
        :src="song?.coverUrl ?? null"
        :seed="song ? `${song.platform}:${song.id}` : 'aurora'"
        :size="56"
        :radius="0"
        :song="song"
      />

      <div class="stage">
        <!-- 闲置态：只留歌词 -->
        <div class="idle" :class="{ hidden: hovered }">
          <div ref="marqueeBox" class="lyric-box">
            <span
              ref="marqueeEl"
              class="lyric-text"
              :class="{ marquee }"
              :style="marqueeStyle"
            >{{ primaryText }}</span>
          </div>
          <small class="sub truncate">{{ secondaryDisplay }}</small>
        </div>

        <!-- 悬停态：播放控制 -->
        <div class="transport" :class="{ visible: hovered }">
          <button class="tbtn" title="上一首" :disabled="!player.queue.length" @click="player.prev()">
            <Icon name="prev" :size="14" />
          </button>
          <button
            class="tbtn main"
            :class="{ loading: player.loading || player.waiting }"
            :title="player.playing ? '暂停' : '播放'"
            @click="player.toggle()"
          >
            <span v-if="player.loading || player.waiting" class="ring" />
            <Icon v-else :name="player.playing ? 'pause' : 'play'" :size="13" />
          </button>
          <button class="tbtn" title="下一首" :disabled="!player.queue.length" @click="player.next()">
            <Icon name="next" :size="14" />
          </button>
        </div>
      </div>

      <!-- 动作组：闲置时整体淡出，不占布局（绝对定位覆盖在右侧） -->
      <div class="actions" :class="{ visible: hovered }">
        <button
          class="abtn"
          :class="{ active: favorite }"
          :title="favorite ? '取消收藏' : '收藏'"
          :disabled="!song"
          @click="toggleFavorite"
        >
          <Icon :name="favorite ? 'heart-filled' : 'heart'" :size="14" />
        </button>
        <button
          class="abtn"
          :title="player.muted ? '取消静音' : '音量'"
          @click="toggleVolume"
        >
          <Icon :name="player.muted || player.volume === 0 ? 'volume-mute' : 'volume-high'" :size="14" />
        </button>
        <button
          class="abtn"
          :class="{ active: panel === 'lyric' }"
          title="展开歌词"
          @click="togglePanel('lyric')"
        >
          <Icon name="lyrics" :size="14" />
        </button>
        <button
          class="abtn"
          :class="{ active: panel === 'queue' }"
          title="播放队列"
          @click="togglePanel('queue')"
        >
          <Icon name="list" :size="14" />
        </button>
        <button class="abtn" title="隐藏到托盘" @click="closeWindow">
          <Icon name="close" :size="13" />
        </button>
        <button class="abtn expand" title="展开完整窗口" @click="expand">
          <Icon name="expand" :size="12" />
        </button>
      </div>
    </div>

    <!-- 下方面板：歌词 / 队列，高度与主进程的 MINI_PANEL_HEIGHT 保持一致 -->
    <transition name="panel">
      <div v-if="panel === 'lyric' || panel === 'queue'" class="panel">
        <div class="panel-head">
          <span>{{ panel === 'lyric' ? '歌词' : '播放队列' }}</span>
          <small v-if="panel === 'queue'">{{ player.queue.length }} 首</small>
          <button class="collapse" title="收起（Esc）" @click="closePanel">
            <Icon name="minimize" :size="12" />
          </button>
        </div>

        <div
          v-if="panel === 'lyric'"
          ref="lyricList"
          class="lyric-list"
          @wheel="pauseAutoScroll"
          @pointerdown="pauseAutoScroll"
        >
          <button
            v-for="(line, index) in lyricLines"
            :key="`${line.time}-${index}`"
            class="lyric-row"
            :class="{ active: index === player.activeLyricIndex }"
            @click="seekLine(line)"
          >
            <span>{{ line.text || '♪' }}</span>
            <em v-if="line.translation">{{ line.translation }}</em>
          </button>
          <p v-if="!lyricLines.length" class="empty">暂无歌词</p>
        </div>

        <div v-else ref="queueList" class="queue-list">
          <button
            v-for="(item, index) in player.queue"
            :key="`${item.platform}-${item.id}-${index}`"
            class="queue-row"
            :class="{ active: index === player.index }"
            @click="playQueueItem(index)"
          >
            <span class="q-index">
              <Icon v-if="index === player.index" name="play" :size="9" />
              <template v-else>{{ index + 1 }}</template>
            </span>
            <span class="q-name">{{ item.name }}</span>
            <span class="q-artist">{{ item.artists.join(' / ') }}</span>
            <span class="q-time">{{ formatDuration(item.duration) }}</span>
          </button>
          <p v-if="!player.queue.length" class="empty">队列是空的</p>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.mini-player {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 58%),
    linear-gradient(160deg, var(--bg-soft), var(--bg));
}

/* ---------------- 迷你条 ---------------- */
.bar {
  position: relative;
  flex: none;
  height: 56px;
  display: flex;
  align-items: center;
  /* 整条可拖动；按钮和面板单独 no-drag */
  -webkit-app-region: drag;
}

.cover {
  flex: none;
  filter: drop-shadow(0 6px 18px rgba(0, 0, 0, 0.5));
}

.stage {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 8px;
}

/* ---------------- 闲置态：歌词 ---------------- */
.idle {
  position: absolute;
  inset: 0;
  padding: 0 10px 0 2px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  transition: opacity 0.16s var(--ease), transform 0.16s var(--ease);
}
.idle.hidden {
  opacity: 0;
  transform: translateY(-3px);
  pointer-events: none;
}

.lyric-box {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.lyric-text {
  display: inline-block;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  will-change: transform;
}
.lyric-text.marquee {
  animation: marquee var(--marquee-duration, 10s) linear infinite alternate;
}
@keyframes marquee {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(var(--marquee-shift, 0));
  }
}

.sub {
  font-size: 9px;
  color: var(--text-3);
  line-height: 1.2;
}

/* ---------------- 悬停态：播放控制 ----------------
   右侧留出动作组的宽度（6 个 23px 按钮 + 间隙 + 内边距 ≈ 158px），
   否则绝对定位的控制组会和动作组叠在一起（下一首被播放键压住）。 */
.transport {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  right: 158px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  opacity: 0;
  transform: translateY(3px);
  pointer-events: none;
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
  -webkit-app-region: no-drag;
}
.transport.visible {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.tbtn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--text-2);
  transition: color 0.15s, background 0.15s, transform 0.15s;
}
.tbtn:hover:not(:disabled) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.09);
}
.tbtn:disabled {
  opacity: 0.3;
}
.tbtn.main {
  width: 34px;
  height: 34px;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 45%, transparent);
}
.tbtn.main:hover {
  transform: scale(1.06);
}

.ring {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  animation: spin 0.85s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ---------------- 动作组 ---------------- */
.actions {
  position: absolute;
  right: 5px;
  top: 50%;
  transform: translateY(-50%) translateX(4px);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 4px;
  border-radius: 10px;
  /* 深色玻璃底：图标压在封面色块上时也能看清 */
  background: rgba(8, 8, 12, 0.46);
  border: 1px solid rgba(255, 255, 255, 0.07);
  backdrop-filter: blur(10px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
  -webkit-app-region: no-drag;
}
.actions.visible {
  opacity: 1;
  transform: translateY(-50%);
  pointer-events: auto;
}

.abtn {
  width: 23px;
  height: 23px;
  border-radius: 6px;
  display: grid;
  place-items: center;
  color: var(--text-2);
  transition: color 0.15s, background 0.15s;
}
.abtn:hover:not(:disabled) {
  color: var(--text);
  background: rgba(255, 255, 255, 0.1);
}
.abtn:disabled {
  opacity: 0.3;
}
.abtn.active {
  color: var(--accent);
}
.abtn.expand {
  color: color-mix(in srgb, var(--accent) 80%, #fff);
}

/* ---------------- 下方面板 ---------------- */
.panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent);
  background: rgba(10, 10, 16, 0.72);
  backdrop-filter: blur(18px);
  -webkit-app-region: no-drag;
}

.panel-head {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px 0 12px;
  color: var(--text-3);
  font-size: 10px;
  letter-spacing: 0.04em;
}
.panel-head small {
  font-size: 9px;
  opacity: 0.7;
}
.panel-head .collapse {
  margin-left: auto;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.panel-head .collapse:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.1);
}

.lyric-list,
.queue-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 2px 8px 10px;
  /* 顶部/底部渐隐，滚动时不会硬切 */
  mask-image: linear-gradient(180deg, transparent 0, #000 10px, #000 calc(100% - 12px), transparent 100%);
}
.lyric-list::-webkit-scrollbar,
.queue-list::-webkit-scrollbar {
  width: 4px;
}
.lyric-list::-webkit-scrollbar-thumb,
.queue-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.14);
  border-radius: 999px;
}

.lyric-row {
  width: 100%;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-radius: 7px;
  text-align: left;
  color: var(--text-3);
  transition: color 0.16s, background 0.16s, transform 0.16s;
}
.lyric-row span {
  font-size: 11.5px;
  line-height: 1.35;
}
.lyric-row em {
  font-style: normal;
  font-size: 10px;
  opacity: 0.72;
  line-height: 1.3;
}
.lyric-row:hover {
  color: var(--text-2);
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.lyric-row.active {
  color: color-mix(in srgb, var(--accent) 78%, #fff);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}
.lyric-row.active span {
  font-size: 12.5px;
  font-weight: 600;
}
.lyric-row.active em {
  opacity: 0.85;
}

/* ---------------- 队列 ---------------- */
.queue-row {
  position: relative;
  width: 100%;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  border-radius: 6px;
  text-align: left;
  color: var(--text-2);
  transition: background 0.14s, color 0.14s;
}
/* 左侧强调条：只靠背景提亮在深色底上不够，竖条提供明确的「指向哪一行」 */
.queue-row::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 999px;
  background: var(--accent);
  opacity: 0;
  transition: opacity 0.14s;
}
/* color-mix 用 --text：深色主题下是白光，浅色主题下自动变成黑，不会两边都看不见 */
.queue-row:hover {
  background: color-mix(in srgb, var(--text) 10%, transparent);
  color: var(--text);
}
.queue-row:hover::before {
  opacity: 0.5;
}
.queue-row:hover .q-index {
  color: color-mix(in srgb, var(--accent) 70%, var(--text-2));
}
.queue-row.active {
  color: color-mix(in srgb, var(--accent) 82%, #fff);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.queue-row.active::before {
  width: 3px;
  opacity: 1;
}
.q-index {
  flex: none;
  width: 16px;
  display: grid;
  place-items: center;
  font-size: 9px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.queue-row.active .q-index {
  color: var(--accent);
}
.q-name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-artist {
  flex: none;
  max-width: 84px;
  font-size: 9.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.q-time {
  flex: none;
  width: 30px;
  text-align: right;
  font-size: 9px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.empty {
  margin: 0;
  padding: 26px 0;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
}

/* ---------------- 过渡 ---------------- */
.panel-enter-active,
.panel-leave-active {
  transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
