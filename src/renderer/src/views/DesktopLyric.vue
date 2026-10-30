<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { LyricLine } from '@shared/types'
import Icon from '../components/Icon.vue'
import { findLyricIndex } from '@shared/lyric'

/**
 * 桌面歌词是独立窗口（绕开 App.vue 单独 mount）。
 * 配色恒定深色（--ly-* 深色调色板），不跟应用主题：它是浮在桌面壁纸上的
 * 组件，且半透明面板给拖拽区提供绘制像素（透明窗口的 drag 区只认有像素的位置）。
 * 强调色仍随音源实时联动（主窗口 250ms 状态推送）。
 */

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
const lineEl = ref<HTMLElement | null>(null)

let baseTime = 0
let baseSentAt = 0
let raf = 0

const current = computed<LyricLine | null>(() => lines.value[index.value] ?? null)
const prev = computed<LyricLine | null>(() =>
  index.value > 0 ? lines.value[index.value - 1] ?? null : null
)
const next = computed<LyricLine | null>(() => lines.value[index.value + 1] ?? null)

function onState(payload: any): void {
  if (!payload || typeof payload !== 'object') return
  // 强调色随 250ms 推送实时联动（独立窗口拿不到主窗口的 shellStyle）
  if (payload.accent) {
    const root = document.documentElement.style
    root.setProperty('--accent', payload.accent)
    if (payload.accent2) root.setProperty('--accent-2', payload.accent2)
  }
  if (payload.closed) {
    closed.value = true
    return
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
  hoverActive = false
  window.api.setLyricWindowLock(locked.value)
}

function close(): void {
  window.api.closeLyricWindow()
}

/* ---------------- 手动拖拽 ----------------
   透明无边框窗口上 -webkit-app-region: drag 在 Windows 不可靠，
   改为上报光标位移、主进程移动窗口（见 windows.ts lyricDragStart）。 */
let dragging = false
let dragStartX = 0
let dragStartY = 0

function onDragStart(e: MouseEvent): void {
  if (e.button !== 0) return
  if (locked.value) return
  // 按钮、右键菜单、拉伸把手上按下不触发拖拽
  if ((e.target as HTMLElement | null)?.closest('button, .ctx-menu, .resize-grip')) return
  dragging = true
  dragStartX = e.screenX
  dragStartY = e.screenY
  window.api.dragLyricWindow()
}

/* ---------------- 右下角拉伸 ----------------
   窗口在拖动期间是 resizable:false（否则按下会被系统判成边缘缩放），
   尺寸只能从这个显式把手改，避免误触。 */
let resizing = false
let resizeStartX = 0
let resizeStartY = 0

function onResizeStart(e: MouseEvent): void {
  if (e.button !== 0) return
  if (locked.value) return
  e.preventDefault()
  resizing = true
  resizeStartX = e.screenX
  resizeStartY = e.screenY
  window.api.startLyricResize()
}

function onDragMove(e: MouseEvent): void {
  if (resizing) {
    window.api.resizeLyricWindow(e.screenX - resizeStartX, e.screenY - resizeStartY)
    return
  }
  if (!dragging) return
  window.api.moveLyricWindow(e.screenX - dragStartX, e.screenY - dragStartY)
}

function onDragEnd(): void {
  if (resizing) {
    resizing = false
    window.api.endLyricResize()
    return
  }
  if (!dragging) return
  dragging = false
  window.api.endLyricWindowDrag()
}

/* ---------------- 锁定态悬停 ----------------
   锁定 = 鼠标穿透（不挡桌面操作），穿透窗口收不到 enter/leave，只收主进程
   forward 转发的 mousemove。收到 mousemove = 鼠标在歌词上 → 通知主进程临时
   恢复交互（可点解锁/关闭）；mouseleave → 恢复穿透。 */
let hoverActive = false

function onWinMouseMove(): void {
  if (!locked.value || hoverActive) return
  hoverActive = true
  window.api.setLyricWindowHover(true)
}

function onWinMouseLeave(): void {
  if (!locked.value || !hoverActive) return
  hoverActive = false
  window.api.setLyricWindowHover(false)
}

/* ---------------- 右键菜单：锁定 / 关闭 ---------------- */
const ctx = ref<{ x: number; y: number } | null>(null)

function openCtx(x: number, y: number): void {
  // 简单收进视口：菜单约 150×90
  ctx.value = {
    x: Math.max(4, Math.min(x, window.innerWidth - 154)),
    y: Math.max(4, Math.min(y, window.innerHeight - 100))
  }
}

function closeCtx(): void {
  ctx.value = null
}

function onDomContextMenu(e: MouseEvent): void {
  e.preventDefault()
  openCtx(e.clientX, e.clientY)
}

function ctxToggleLock(): void {
  closeCtx()
  toggleLock()
}

function ctxCloseLyric(): void {
  closeCtx()
  close()
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
  // 右键菜单：主进程 context-menu 转发（拖拽区上 DOM 右键可能收不到）
  const offCtx = window.api.onLyricContextMenu((pos) => openCtx(pos.x, pos.y))
  onBeforeUnmount(offCtx)
  const onWinClick = (): void => closeCtx()
  window.addEventListener('click', onWinClick)
  onBeforeUnmount(() => window.removeEventListener('click', onWinClick))
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
  // mouseup 丢在窗口外时不会再派发，失焦作为兜底结束拖动（主进程另有超时保护）
  window.addEventListener('blur', onDragEnd)
  onBeforeUnmount(() => {
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
    window.removeEventListener('blur', onDragEnd)
  })
  raf = requestAnimationFrame(tick)
  document.body.classList.add('lyric-body')
})

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <!-- 大字歌词：上一行 / 当前行 / 下一行 + 译文 -->
  <div
    class="lyric-window"
    :class="{ locked }"
    :style="{ '--scale': fontScale }"
    @contextmenu="onDomContextMenu"
    @mousedown="onDragStart"
    @mousemove="onWinMouseMove"
    @mouseleave="onWinMouseLeave"
  >
    <div class="toolbar">
      <span class="grip">⋮⋮</span>
      <div class="tools">
        <button title="缩小" @click="smaller">A−</button>
        <button title="放大" @click="bigger">A+</button>
        <button
          class="lock-btn"
          :class="{ on: locked }"
          :title="locked ? '解锁（点击后可拖动）' : '锁定（不挡桌面操作，鼠标悬停歌词即可解锁）'"
          @click="toggleLock"
        >
          <Icon :name="locked ? 'lock' : 'unlock'" :size="13" />
        </button>
      </div>
    </div>

    <!-- 常驻关闭按钮：不随工具栏悬停显隐，随时可退 -->
    <button class="close-float" title="关闭桌面歌词" @click="close">
      <Icon name="close" :size="13" />
    </button>

    <!-- 右下角拉伸把手：窗口本身不可缩放，尺寸只能从这里改（悬停才出现） -->
    <div
      class="resize-grip"
      title="拖动调整歌词窗大小"
      @mousedown.stop="onResizeStart"
      @click.stop
    />

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

  <!-- 右键菜单：锁定/解锁、关闭（点击任意处收起） -->
  <div v-if="ctx" class="ctx-menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }">
    <button @click.stop="ctxToggleLock">
      <Icon :name="locked ? 'unlock' : 'lock'" :size="12" />
      {{ locked ? '解锁桌面歌词' : '锁定桌面歌词' }}
    </button>
    <button class="danger" @click.stop="ctxCloseLyric">
      <Icon name="close" :size="12" />
      关闭桌面歌词
    </button>
  </div>
</template>

<style scoped>
/* ---------------- 配色 ----------------
   桌面歌词窗口独立挂载，深浅两套调色板定义在全局 main.css
   （:root 为深色默认，html[data-theme='light'] 覆盖），
   此处只消费 --ly-* 变量，避免 scoped :global 组合选择器被编译丢失 */

/* ---------------- 大字歌词 ---------------- */
.lyric-window {
  height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  /* 紧凑：内边距收窄，框体贴合歌词 */
  padding: 6px 18px;
  color: var(--ly-fg);
  /* 闲置时完全裸字：面板只在悬停时浮出（见下方 ::before）。
     拖拽走手动 IPC（透明窗口上 -webkit-app-region 不可靠），故不再声明 drag 区。
     边框保留透明占位，避免悬停时因 border 出现导致内容位移 1px。 */
  background: transparent;
  border: 1px solid transparent;
  border-radius: 14px;
  position: relative;
  cursor: move;
  user-select: none;
  overflow: hidden;
  /* 投影留在元素自身上：父级 overflow:hidden 会裁掉伪元素的投影，自己的不会 */
  box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);
  transition: box-shadow 0.18s ease;
}
.lyric-window:hover {
  box-shadow: var(--ly-panel-shadow);
}

/**
 * 面板本体：独立一层做透明度过渡。
 * 直接过渡 `background` 不可行（linear-gradient 无法插值），所以把面板画在伪元素上，
 * 只动 opacity —— 60fps 的合成层动画，不会触发布局或重绘文字。
 * 层级注意：不能用 z-index: -1。透明窗口里负层级会被合成器裁掉（实测完全不可见），
 * 这里用 0：伪元素是第一个子盒，文字层的 filter/normal flow 都在它之后绘制，不会盖住字。
 */
.lyric-window::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--ly-panel);
  border: 1px solid var(--ly-panel-border);
  opacity: 0;
  z-index: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.lyric-window:hover::before {
  opacity: 1;
}

.toolbar {
  position: absolute;
  top: 6px;
  left: 8px;
  display: flex;
  align-items: center;
  opacity: 0;
  transition: opacity 0.25s;
}
.lyric-window:hover .toolbar {
  opacity: 1;
}

.grip {
  color: var(--ly-fg-3);
  font-size: 12px;
  letter-spacing: 2px;
  margin-right: 6px;
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
  cursor: pointer;
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
  /* 锁定激活态：主题强调色，随音源/主题联动 */
  color: color-mix(in srgb, var(--accent, #7c6cff) 78%, white);
  border-color: color-mix(in srgb, var(--accent, #7c6cff) 42%, transparent);
}

/* 常驻关闭：右上角小按钮，半透明不抢戏 */
.close-float {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  color: var(--ly-fg-2);
  background: var(--ly-tool-bg);
  border: 1px solid var(--ly-tool-border);
  backdrop-filter: blur(8px);
  cursor: pointer;
  /* 与面板同一节奏：闲置时不显示任何「窗口感」的控件，悬停连面板一起浮出 */
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease, background 0.15s, color 0.15s;
}
.lyric-window:hover .close-float {
  opacity: 0.75;
  pointer-events: auto;
}
.close-float:hover {
  opacity: 1;
  background: var(--ly-tool-hover-bg);
  color: var(--ly-ctrl-hover-fg);
}

/* 右下角拉伸把手：平时隐形（也不吃点击），悬停时浮出两道斜线示意可拉伸。
   窗口本身不可缩放，尺寸只能从这里改，避免「按住窗口就被系统拉大」。 */
.resize-grip {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  color: var(--ly-fg-3);
  cursor: nwse-resize;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
}
.resize-grip::before {
  content: '';
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 9px;
  height: 9px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  border-radius: 0 0 3px 0;
}
.lyric-window:hover .resize-grip {
  opacity: 0.55;
  pointer-events: auto;
}
.resize-grip:hover {
  opacity: 1;
}

.content {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
}

.line {
  margin: 0;
  font-size: calc(32px * var(--scale));
  font-weight: 800;
  letter-spacing: 1px;
  line-height: 1.25;
  /* 行尾渐入主题强调色：白字为主保证可读，尾部颜色与主题呼应 */
  background: linear-gradient(
    180deg,
    var(--ly-line-1) 30%,
    color-mix(in srgb, var(--accent, #7c6cff) 52%, var(--ly-line-2))
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0 4px 24px var(--ly-glow);
  /* 描边只能用 -webkit-text-stroke：
     这行是 background-clip:text 的渐变字，填充色其实是「背景」，
     text-shadow 会画在背景之上——四个 1px 偏移的阴影副本等于把整个字形盖成实心块
     （实测字直接变黑板）；连环 drop-shadow 又会把光晕反复叠加，同样糊死。
     stroke 只画 1px 边缘、且可继承到逐字的 w-base / w-fill 子层，字心仍然是渐变。 */
  -webkit-text-stroke: 0.8px var(--ly-outline);
  paint-order: stroke fill;
  filter: drop-shadow(0 2px 6px var(--ly-glow-soft));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

/* 逐字：关掉整行渐变，改由字层 clip-path 驱动 */
.line.kara {
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
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  /* 已唱部分带主题强调色：跟随音源/主题实时变化 */
  color: color-mix(in srgb, var(--accent, #7c6cff) 42%, var(--ly-line-1));
  -webkit-text-fill-color: color-mix(in srgb, var(--accent, #7c6cff) 42%, var(--ly-line-1));
  text-shadow: 0 2px 10px var(--ly-glow-soft);
  clip-path: inset(0 100% 0 0);
}
.line.kara .w-fill {
  clip-path: inset(
    0
    calc((1 - clamp(0, (var(--e, 0) - var(--s)) / var(--d), 1)) * 100%)
    0
    0
  );
}

.trans {
  margin: 2px 0 0;
  font-size: calc(13px * var(--scale));
  color: var(--ly-fg-2);
  text-shadow:
    0.8px 0 0 var(--ly-outline-soft),
    -0.8px 0 0 var(--ly-outline-soft),
    0 0.8px 0 var(--ly-outline-soft),
    0 -0.8px 0 var(--ly-outline-soft),
    0 2px 10px var(--ly-glow);
}

.ghost {
  margin: 0;
  font-size: calc(12px * var(--scale));
  color: var(--ly-fg-3);
  text-shadow:
    0.8px 0 0 var(--ly-outline-soft),
    -0.8px 0 0 var(--ly-outline-soft),
    0 0.8px 0 var(--ly-outline-soft),
    0 -0.8px 0 var(--ly-outline-soft),
    0 2px 8px var(--ly-glow);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 92%;
  height: 15px;
}
.ghost.prev {
  margin-bottom: 2px;
}
.ghost.next {
  margin-top: 2px;
}

.placeholder {
  margin: 0;
  font-size: 15px;
  color: var(--ly-fg-3);
  text-shadow: 0 2px 10px var(--ly-glow);
}

.footer {
  position: absolute;
  bottom: 4px;
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

/* ---------------- 右键菜单 ---------------- */
.ctx-menu {
  position: fixed;
  z-index: 99;
  min-width: 146px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background: var(--ly-panel);
  border: 1px solid color-mix(in srgb, var(--accent, #7c6cff) 32%, var(--ly-panel-border));
  box-shadow: var(--ly-panel-shadow);
  backdrop-filter: blur(14px);
}
.ctx-menu button {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border-radius: 7px;
  font-size: 12px;
  text-align: left;
  color: var(--ly-fg-2);
  transition: background 0.15s, color 0.15s;
}
.ctx-menu button:hover {
  background: var(--ly-ctrl-hover-bg);
  color: var(--ly-ctrl-hover-fg);
}
.ctx-menu button.danger:hover {
  color: var(--danger, #ff5c7c);
}
</style>
