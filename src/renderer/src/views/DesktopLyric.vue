<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { LyricLine } from '@shared/types'
import Icon from '../components/Icon.vue'
import { findLyricIndex } from '@shared/lyric'

/**
 * 桌面歌词是独立窗口（绕开 App.vue 单独 mount），主题不会自动跟随。
 * 主进程的 broadcastSettings 会广播到所有窗口，这里订阅并同步 data-theme。
 */
function applyTheme(settings: { themeMode?: string } | null | undefined): void {
  document.documentElement.dataset.theme = settings?.themeMode === 'light' ? 'light' : 'dark'
}

const lines = ref<LyricLine[]>([])
const offset = ref(0)
const playing = ref(false)
const title = ref('')
const artist = ref('')
const locked = ref(false)
const index = ref(-1)
const closed = ref(false)
const fontScale = ref(1)
const karaoke = ref(false)
/** mini = 单行迷你条（播放按钮 + 一行歌词）；full = 大字三行 */
const mode = ref<'mini' | 'full'>('mini')
const lineEl = ref<HTMLElement | null>(null)

let baseTime = 0
let baseSentAt = 0
let raf = 0

const current = computed<LyricLine | null>(() => lines.value[index.value] ?? null)
const prev = computed<LyricLine | null>(() =>
  index.value > 0 ? lines.value[index.value - 1] ?? null : null
)
const next = computed<LyricLine | null>(() => lines.value[index.value + 1] ?? null)

/** 迷你条没有歌词时显示什么：有歌就报歌名，否则等待播放 */
const idleText = computed(() => {
  if (title.value) return `${title.value}${artist.value ? ' · ' + artist.value : ''}`
  return '等待播放…'
})

function onState(payload: any): void {
  if (!payload || typeof payload !== 'object') return
  if (payload.closed) {
    closed.value = true
    return
  }
  // 形态由主进程广播（窗口尺寸也由它改，布局必须跟它保持一致）
  if (payload.mode === 'mini' || payload.mode === 'full') {
    mode.value = payload.mode
    if (payload.lines === undefined) return
  }
  if (typeof payload.locked === 'boolean' && payload.lines === undefined) {
    locked.value = payload.locked
    return
  }
  if (payload.lines) {
    lines.value = payload.lines as LyricLine[]
    offset.value = Number(payload.offset ?? 0)
    playing.value = Boolean(payload.playing)
    title.value = String(payload.title ?? '')
    artist.value = String(payload.artist ?? '')
    baseTime = Number(payload.time ?? 0)
    baseSentAt = Number(payload.sentAt ?? Date.now())
    if (typeof payload.locked === 'boolean') locked.value = payload.locked
    karaoke.value = lines.value.some((line) => Boolean(line.words?.length))
    tick()
  }
}

function tick(): void {
  const elapsed = playing.value ? Math.max(0, Date.now() - baseSentAt) : 0
  const time = baseTime + elapsed
  const found = findLyricIndex(lines.value, time + offset.value)
  if (found !== index.value) index.value = found
  // 逐字进度：子窗口独立按 sentAt 插值，不依赖 IPC 推送频率。
  if (lineEl.value && current.value?.words?.length) {
    lineEl.value.style.setProperty(
      '--e',
      String(Math.max(0, time + offset.value - current.value.time))
    )
  }
  raf = requestAnimationFrame(tick)
}

function toggleLock(): void {
  locked.value = !locked.value
  window.api.setLyricWindowLock(locked.value)
}

async function toggleMode(): Promise<void> {
  mode.value = await window.api.setLyricMode(mode.value === 'mini' ? 'full' : 'mini')
}

function togglePlay(): void {
  window.api.sendLyricCommand('toggle')
}

function prevTrack(): void {
  window.api.sendLyricCommand('prev')
}

function nextTrack(): void {
  window.api.sendLyricCommand('next')
}

function close(): void {
  window.api.closeLyricWindow()
}

function bigger(): void {
  fontScale.value = Math.min(1.6, fontScale.value + 0.1)
}

function smaller(): void {
  fontScale.value = Math.max(0.7, fontScale.value - 0.1)
}

onMounted(async () => {
  const off = window.api.onLyricWindowState(onState)
  onBeforeUnmount(off)
  // 设置变更（含主题切换）实时同步；启动时先取一次当前设置，避免开窗瞬间闪深色
  const offSettings = window.api.onSettingsChanged((next) => applyTheme(next))
  onBeforeUnmount(offSettings)
  applyTheme(await window.api.getSettings())
  mode.value = await window.api.getLyricMode()
  raf = requestAnimationFrame(tick)
  document.body.classList.add('lyric-body')
})

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <!-- 迷你条：一行搞定「播放状态 + 歌词」，鼠标移上去才露出控制按钮 -->
  <div v-if="mode === 'mini'" class="mini">
    <div class="pill" :class="{ locked }">
      <button
        v-if="!locked"
        class="play"
        :title="playing ? '暂停' : '播放'"
        @click="togglePlay"
      >
        <Icon :name="playing ? 'pause' : 'play'" :size="14" />
      </button>
      <span v-else class="play static" :title="locked ? '已锁定（鼠标穿透）' : ''">
        <Icon :name="playing ? 'pause' : 'play'" :size="14" />
      </span>

      <p
        ref="lineEl"
        class="mini-line"
        :class="{ kara: karaoke && !!current?.words }"
        :title="title ? `${title}${artist ? ' · ' + artist : ''}` : ''"
      >
        <template v-if="!current">{{ idleText }}</template>
        <template v-else-if="karaoke && current.words">
          <span
            v-for="(w, wi) in current.words"
            :key="wi"
            class="w"
            :style="{ '--s': w.time - current.time, '--d': Math.max(60, w.duration) }"
          >
            <span class="w-fill">{{ w.text }}</span>
            <span class="w-base">{{ w.text }}</span>
          </span>
        </template>
        <template v-else>{{ current.text || '♪' }}</template>
      </p>

      <div v-if="!locked" class="mini-tools">
        <button title="上一首" @click="prevTrack">
          <Icon name="prev" :size="12" />
        </button>
        <button title="下一首" @click="nextTrack">
          <Icon name="next" :size="12" />
        </button>
        <button title="大字模式" @click="toggleMode">
          <Icon name="maximize" :size="12" />
        </button>
        <button
          class="lock-btn"
          :class="{ on: locked }"
          :title="locked ? '解锁（可拖动/点击）' : '锁定（鼠标穿透）'"
          @click="toggleLock"
        >
          <Icon :name="locked ? 'lock' : 'unlock'" :size="12" />
        </button>
        <button title="关闭桌面歌词" @click="close">
          <Icon name="close" :size="12" />
        </button>
      </div>

      <!-- 锁定时鼠标穿透，按钮点不到：只留一个锁标记说明原因，解锁走托盘菜单 -->
      <span v-else class="mini-lock" title="已锁定（鼠标穿透）· 右键托盘图标可解锁">
        <Icon name="lock" :size="11" />
      </span>
    </div>
  </div>

  <!-- 大字模式：上一行 / 当前行 / 下一行 + 译文 -->
  <div v-else class="lyric-window" :class="{ locked }" :style="{ '--scale': fontScale }">
    <div class="toolbar">
      <span class="grip">⋮⋮</span>
      <div class="tools">
        <button title="缩小" @click="smaller">A−</button>
        <button title="放大" @click="bigger">A+</button>
        <button title="迷你模式" @click="toggleMode">
          <Icon name="minimize" :size="12" />
        </button>
        <button
          class="lock-btn"
          :class="{ on: locked }"
          :title="locked ? '解锁（可拖动）' : '锁定（鼠标穿透）'"
          @click="toggleLock"
        >
          <Icon :name="locked ? 'lock' : 'unlock'" :size="13" />
        </button>
        <button title="关闭桌面歌词" @click="close">✕</button>
      </div>
    </div>

    <div class="content">
      <p v-if="!current" class="placeholder">
        {{ title ? '暂无歌词' : '等待播放…' }}
      </p>
      <template v-else>
        <p class="ghost prev">{{ prev?.text ?? '' }}</p>
        <p ref="lineEl" class="line" :class="{ kara: karaoke && !!current.words }">
          <template v-if="karaoke && current.words">
            <span
              v-for="(w, wi) in current.words"
              :key="wi"
              class="w"
              :style="{ '--s': w.time - current.time, '--d': Math.max(60, w.duration) }"
            >
              <span class="w-fill">{{ w.text }}</span>
              <span class="w-base">{{ w.text }}</span>
            </span>
          </template>
          <template v-else>{{ current.text || '♪' }}</template>
        </p>
        <p v-if="current.translation" class="trans">{{ current.translation }}</p>
        <p class="ghost next">{{ next?.text ?? '' }}</p>
      </template>
    </div>

    <div class="footer">
      <span>{{ title }}</span>
      <em v-if="artist">· {{ artist }}</em>
    </div>
  </div>
</template>

<style scoped>
/* ---------------- 配色 ----------------
   桌面歌词窗口独立挂载，深浅两套调色板定义在全局 main.css
   （:root 为深色默认，html[data-theme='light'] 覆盖），
   此处只消费 --ly-* 变量，避免 scoped :global 组合选择器被编译丢失 */

/* ---------------- 迷你条 ---------------- */
.mini {
  height: 100vh;
  display: flex;
  align-items: center;
  padding: 5px 6px;
  box-sizing: border-box;
  -webkit-app-region: drag;
}

.pill {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--ly-panel);
  border: 1px solid var(--ly-panel-border);
  box-shadow: var(--ly-panel-shadow);
  backdrop-filter: blur(14px);
  overflow: hidden;
}

.play {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: var(--ly-fg);
  background: var(--ly-ctrl-bg);
  border: 1px solid var(--ly-ctrl-border);
  transition: background 0.15s, transform 0.15s;
  -webkit-app-region: no-drag;
}
.play:hover {
  background: var(--accent, #7c8cff);
  color: #fff;
  transform: scale(1.04);
}
.play.static {
  color: var(--ly-fg-3);
  background: var(--ly-ctrl-bg);
}

.mini-line {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 0.4px;
  line-height: 1.2;
  color: var(--ly-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-shadow: 0 1px 8px var(--ly-glow);
}

.mini-tools {
  flex: none;
  display: flex;
  align-items: center;
  gap: 3px;
  opacity: 0;
  transition: opacity 0.2s;
  -webkit-app-region: no-drag;
}
.mini:hover .mini-tools {
  opacity: 1;
}
.mini-tools button {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--ly-ctrl-fg);
  background: var(--ly-ctrl-bg);
  border: 1px solid transparent;
  transition: all 0.15s;
}
.mini-tools button:hover {
  color: var(--ly-ctrl-hover-fg);
  background: var(--ly-ctrl-hover-bg);
}
.mini-tools button.on {
  color: var(--ly-on);
  border-color: color-mix(in srgb, var(--ly-on) 35%, transparent);
}

.mini-lock {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding-right: 2px;
  color: color-mix(in srgb, var(--ly-on) 55%, transparent);
}

/* ---------------- 大字模式 ---------------- */
.lyric-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  padding: 10px 26px;
  color: var(--ly-fg);
  background: transparent;
  border-radius: 18px;
  position: relative;
  -webkit-app-region: drag;
  overflow: hidden;
}

.toolbar {
  position: absolute;
  top: 6px;
  left: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  opacity: 0;
  transition: opacity 0.25s;
  -webkit-app-region: no-drag;
}
.lyric-window:hover .toolbar {
  opacity: 1;
}

.grip {
  color: var(--ly-fg-3);
  font-size: 12px;
  letter-spacing: 2px;
}

.tools {
  display: flex;
  gap: 4px;
}
.lock-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tools button {
  height: 24px;
  min-width: 26px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  font-size: 11px;
  color: var(--ly-ctrl-fg);
  background: var(--ly-tool-bg);
  border: 1px solid var(--ly-tool-border);
  backdrop-filter: blur(8px);
  transition: all 0.15s;
}
.tools button:hover {
  background: var(--ly-tool-hover-bg);
  color: var(--ly-ctrl-hover-fg);
}
.tools button.on {
  color: var(--ly-on);
  border-color: color-mix(in srgb, var(--ly-on) 40%, transparent);
}

.content {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 100%;
}

.line {
  margin: 0;
  font-size: calc(46px * var(--scale));
  font-weight: 800;
  letter-spacing: 1px;
  line-height: 1.25;
  background: linear-gradient(180deg, var(--ly-line-1) 30%, var(--ly-line-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0 4px 24px var(--ly-glow);
  filter: drop-shadow(0 2px 6px var(--ly-glow-soft));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 逐字：关掉整行渐变，改由字层 clip-path 驱动 */
.line.kara,
.mini-line.kara {
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
  color: transparent;
  -webkit-text-fill-color: transparent;
  text-shadow: none;
}

.w {
  position: relative;
  display: inline-block;
  white-space: pre;
}
.w-base,
.w-fill {
  display: inline-block;
  white-space: pre;
  font: inherit;
  letter-spacing: inherit;
  line-height: inherit;
  filter: drop-shadow(0 2px 6px var(--ly-glow-soft));
}
.w-base {
  color: var(--ly-wbase);
  -webkit-text-fill-color: var(--ly-wbase);
}
.w-fill {
  position: absolute;
  inset: 0;
  color: var(--ly-line-1);
  -webkit-text-fill-color: var(--ly-line-1);
  text-shadow: 0 2px 10px var(--ly-glow-soft);
  clip-path: inset(0 100% 0 0);
}
.line.kara .w-fill,
.mini-line.kara .w-fill {
  clip-path: inset(
    0
    calc((1 - clamp(0, (var(--e, 0) - var(--s)) / var(--d), 1)) * 100%)
    0
    0
  );
}

.trans {
  margin: 2px 0 0;
  font-size: calc(16px * var(--scale));
  color: var(--ly-fg-2);
  text-shadow: 0 2px 10px var(--ly-glow);
}

.ghost {
  margin: 0;
  font-size: calc(15px * var(--scale));
  color: var(--ly-fg-3);
  text-shadow: 0 2px 8px var(--ly-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 92%;
  height: 20px;
}
.ghost.prev {
  margin-bottom: 2px;
}
.ghost.next {
  margin-top: 2px;
}

.placeholder {
  margin: 0;
  font-size: 20px;
  color: var(--ly-fg-3);
  text-shadow: 0 2px 10px var(--ly-glow);
}

.footer {
  position: absolute;
  bottom: 6px;
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: var(--ly-fg-3);
  opacity: 0;
  transition: opacity 0.25s;
}
.lyric-window:hover .footer {
  opacity: 1;
}
.footer em {
  font-style: normal;
}

.locked {
  cursor: default;
}
</style>
