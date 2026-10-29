<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { MiniVolumeState } from '@shared/types'

/**
 * 迷你窗口的音量气泡：独立透明窗口（主窗口不透明，浮层画在窗口内会露出深色底）。
 *
 * 布局按参考图：横向滑块 + 下方小三角指向迷你条上的音量按钮。
 * 配色跟随应用深色主题，不照搬参考图的白色。
 */
const volume = ref(0.75)
/** 气泡在迷你条上方还是下方（主进程按屏幕空间决定） */
const placement = ref<'above' | 'below'>('above')
const track = ref<HTMLElement | null>(null)
let dragging = false
let offState: (() => void) | null = null

/**
 * 独立窗口不会继承主窗口 `.shell` 上的 --accent，也没有 data-theme，
 * 必须显式写入，否则气泡永远是默认紫 + 深色，和迷你条对不上。
 */
function applyTheme(state: MiniVolumeState): void {
  placement.value = state.placement === 'below' ? 'below' : 'above'
  const root = document.documentElement
  root.dataset.theme = state.theme === 'light' ? 'light' : 'dark'
  if (state.accent) root.style.setProperty('--accent', state.accent)
  if (state.accent2) root.style.setProperty('--accent-2', state.accent2)
}

const percent = computed(() => Math.max(0, Math.min(1, volume.value)) * 100)

function ratioFromEvent(event: PointerEvent): number {
  const el = track.value
  if (!el) return volume.value
  const rect = el.getBoundingClientRect()
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
}

function apply(value: number): void {
  volume.value = value
  window.api.setMiniVolume(value)
}

function onPointerDown(event: PointerEvent): void {
  dragging = true
  try {
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  } catch {
    /* 合成事件或指针已释放 */
  }
  // 窗口级兜底：指针捕获在某些情况下会丢（例如按下瞬间窗口失焦），
  // 只靠元素上的 pointermove 会让滑块中途「粘住」不动
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  apply(ratioFromEvent(event))
}

function onPointerMove(event: PointerEvent): void {
  if (dragging) apply(ratioFromEvent(event))
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging) return
  dragging = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  try {
    // 事件来自窗口兜底时 currentTarget 是 window，没有指针捕获可释放
    ;(event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId)
  } catch {
    /* 指针已被系统释放 */
  }
}

/** 滚轮 ±5%：气泡开着时不用精确拖也能微调 */
function onWheel(event: WheelEvent): void {
  const delta = event.deltaY < 0 ? 0.05 : -0.05
  apply(Math.max(0, Math.min(1, volume.value + delta)))
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') window.api.closeMiniVolume()
}

onMounted(async () => {
  try {
    const state = (await window.api.getMiniVolume()) as MiniVolumeState
    applyTheme(state)
    volume.value = state.volume
  } catch {
    /* 读不到就用默认 75% */
  }
  offState = window.api.onMiniVolumeState((state) => {
    // 主题/强调色可能随音源切换变化，推送时一并刷新
    applyTheme(state)
    // 拖动中忽略回推，避免滑块被拉回上一帧
    if (!dragging) volume.value = state.volume
  })
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  offState?.()
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="bubble" :class="{ below: placement === 'below' }">
    <div class="card">
      <div
        ref="track"
        class="track"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @wheel.prevent="onWheel"
      >
        <div class="fill" :style="{ width: percent + '%' }" />
        <span class="thumb" :style="{ left: percent + '%' }" />
      </div>
    </div>
    <span class="arrow" />
  </div>
</template>

<style scoped>
:global(html),
:global(body) {
  margin: 0;
  padding: 0;
  background: transparent;
  overflow: hidden;
  user-select: none;
}

.bubble {
  position: relative;
  width: 100vw;
  height: 100vh;
  padding: 8px 10px 0;
  box-sizing: border-box;
}

.card {
  height: 40px;
  display: flex;
  align-items: center;
  padding: 0 18px;
  border-radius: 20px;
  /* 与迷你条同一套底：--bg/--bg-soft 渐变 + 左上角 accent 光晕 */
  background:
    radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 24%, transparent), transparent 58%),
    linear-gradient(160deg, var(--bg-soft), var(--bg));
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border-strong));
  box-shadow:
    0 10px 26px color-mix(in srgb, #000 34%, transparent),
    0 2px 6px color-mix(in srgb, #000 22%, transparent);
}

.track {
  position: relative;
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 16%, transparent);
  cursor: pointer;
  touch-action: none;
}
/* 6px 轨道太细，扩大命中区 */
.track::after {
  content: '';
  position: absolute;
  top: -12px;
  right: 0;
  bottom: -12px;
  left: 0;
}

.fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid color-mix(in srgb, var(--text) 18%, transparent);
  box-shadow: 0 1px 5px color-mix(in srgb, #000 32%, transparent);
  transform: translate(-50%, -50%);
}

/* 三角：尖端朝下，指向迷你条的音量按钮。翻到迷你条下方时整体旋转 180°，
   否则会指向远离迷你条的一侧（看起来像「箭头指错了」）。 */
.arrow {
  position: absolute;
  top: 47px;
  right: 105px;
  width: 0;
  height: 0;
  border-left: 7px solid transparent;
  border-right: 7px solid transparent;
  /* 渐变末端是 --bg，三角在卡片底部，用它才能和卡片连成一片 */
  border-top: 8px solid var(--bg);
}

/* 气泡在迷你条下方：三角挪到顶部、朝上，颜色取卡片顶边的 --bg-soft */
.bubble.below .arrow {
  top: 0;
  transform: rotate(180deg);
  border-top-color: var(--bg-soft);
}
</style>
