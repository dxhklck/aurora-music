<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Lyric, LyricLine } from '@shared/types'
import { findLyricIndex } from '@shared/lyric'
import { audio } from '../core/audio'

const props = withDefaults(
  defineProps<{
    lyric: Lyric | null
    loading?: boolean
    /** 用于外部同步（桌面歌词窗口） */
    externalIndex?: number
  }>(),
  { loading: false, externalIndex: -1 }
)

const emit = defineEmits<{ seek: [ms: number] }>()

const viewport = ref<HTMLElement | null>(null)
const inner = ref<HTMLElement | null>(null)
const lineEls = ref<HTMLElement[]>([])
const active = ref(-1)
const offsetY = ref(0)
const hasLines = ref(false)
const karaoke = ref(false)
let raf = 0

const lines = () => props.lyric?.lines ?? []

function center(): void {
  if (!viewport.value || !inner.value) return
  const el = lineEls.value[active.value]
  if (!el) {
    offsetY.value = viewport.value.clientHeight / 2 - 40
    return
  }
  const box = viewport.value.clientHeight
  offsetY.value = box / 2 - (el.offsetTop + el.offsetHeight / 2)
}

/**
 * 逐字进度靠 CSS `calc` + `clamp` 实时算出：行容器写入 `--e`（行内已过的毫秒数），
 * 每个字自带 `--s`（相对行起始的偏移）和 `--d`（时长）。clip-path 的右侧裁剪
 * 跟随 `clamp(0, (e - s) / d, 1)` 从 100% 缩到 0%，纯 CSS、零布局抖动。
 *
 * 这里每帧只往「当前行」这一个元素写一个属性，几十字歌词也只写一次。
 */
function writeElapsed(): void {
  const list = lines()
  const line = list[active.value]
  const el = lineEls.value[active.value]
  if (!line || !el || !line.words?.length) return
  const time = audio.currentTime + (props.lyric?.offset ?? 0)
  el.style.setProperty('--e', String(Math.max(0, time - line.time)))
}

function tick(): void {
  const list = lines()
  if (list.length) {
    const time = audio.currentTime + (props.lyric?.offset ?? 0)
    const index = findLyricIndex(list, time)
    if (index !== active.value) {
      active.value = index
      center()
    }
    writeElapsed()
  }
  raf = requestAnimationFrame(tick)
}

function seekTo(ms: number): void {
  emit('seek', ms)
}

function onResize(): void {
  center()
}

watch(
  () => props.lyric,
  async () => {
    await nextTick()
    hasLines.value = Boolean(props.lyric?.lines.length)
    karaoke.value = Boolean(props.lyric?.wordByWord)
    active.value = -1
    center()
  },
  { immediate: true }
)

watch(
  () => props.externalIndex,
  (index) => {
    if (index >= 0 && index !== active.value) {
      active.value = index
      center()
    }
  }
)

onMounted(async () => {
  await nextTick()
  center()
  raf = requestAnimationFrame(tick)
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div ref="viewport" class="lyric">
    <div v-if="loading" class="hint">
      <span class="spinner" />
      正在加载歌词
    </div>

    <template v-else-if="lyric && lyric.lines.length">
      <div ref="inner" class="inner" :style="{ transform: `translate3d(0, ${offsetY}px, 0)` }">
        <div
          v-for="(line, index) in lyric.lines"
          :key="line.time + '-' + index"
          ref="lineEls"
          class="line"
          :class="{ active: index === active, passed: index < active, kara: karaoke && !!line.words }"
          @click="seekTo(line.time)"
        >
          <span class="text" :class="{ kara: karaoke && !!line.words }">
            <template v-if="karaoke && line.words">
              <span v-for="(w, wi) in line.words" :key="wi" class="w" :style="{ '--s': w.time - line.time, '--d': Math.max(60, w.duration) }">
                <span class="w-fill">{{ w.text }}</span>
                <span class="w-base">{{ w.text }}</span>
              </span>
            </template>
            <template v-else>{{ line.text || '♪' }}</template>
          </span>
          <span v-if="line.translation" class="trans">{{ line.translation }}</span>
        </div>
      </div>
      <div class="mask top" />
      <div class="mask bottom" />
    </template>

    <div v-else-if="lyric && lyric.plain" class="plain">
      <p v-for="(line, index) in lyric.plain.split('\n')" :key="index">{{ line }}</p>
    </div>

    <div v-else class="hint">
      <span class="disc">♪</span>
      <strong>暂无歌词</strong>
      <small>该曲目没有可用的时间轴歌词</small>
    </div>
  </div>
</template>

<style scoped>
.lyric {
  position: relative;
  height: 100%;
  overflow: hidden;
  mask-image: linear-gradient(180deg, transparent 0, #000 14%, #000 86%, transparent 100%);
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 14%, #000 86%, transparent 100%);
}

.inner {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  padding: 0 8px;
  transition: transform 0.52s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.line {
  padding: 9px 4px;
  border-radius: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.32s var(--ease);
  opacity: 0.42;
  transform-origin: left center;
}

.line .text {
  display: block;
  font-size: 16px;
  line-height: 1.5;
  font-weight: 500;
  color: var(--text);
  transition: all 0.32s var(--ease);
}

.line .trans {
  display: block;
  margin-top: 3px;
  font-size: 12.5px;
  color: var(--text-2);
  opacity: 0;
  transition: opacity 0.32s var(--ease);
}

.line.passed {
  opacity: 0.3;
}

.line.active {
  opacity: 1;
  transform: translateX(6px);
}
.line.active .text {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.2px;
  background: linear-gradient(100deg, #fff, color-mix(in srgb, var(--accent) 70%, #fff));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  text-shadow: 0 6px 26px color-mix(in srgb, var(--accent) 45%, transparent);
}
.line.active .trans {
  opacity: 0.8;
  font-size: 13px;
}

.line:hover {
  opacity: 0.85;
}

/* ===== 逐字 karaoke =====
 * 字分为两层叠放：base 是暗色整字（占位、撑开宽度），fill 是亮色裁剪副本。
 * fill 用 clip-path 的右侧裁剪跟随行进度 `--e` 收缩：
 *   progress = clamp(0, (e - s) / d, 1)  —— 该字唱到的比例
 *   右裁剪   = (1 - progress) * 100%
 * `--e` 由 tick() 每帧写入「当前行」这一个元素。
 */
.text.kara {
  background: none;
  -webkit-background-clip: initial;
  background-clip: initial;
  color: transparent;
  text-shadow: none;
  -webkit-text-fill-color: transparent;
}
.line.active .text.kara {
  background: none;
  text-shadow: none;
  color: transparent;
  -webkit-text-fill-color: transparent;
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
}
.w-base {
  color: rgba(255, 255, 255, 0.34);
  -webkit-text-fill-color: rgba(255, 255, 255, 0.34);
}
.w-fill {
  position: absolute;
  inset: 0;
  color: #fff;
  -webkit-text-fill-color: #fff;
  text-shadow: 0 0 18px color-mix(in srgb, var(--accent) 60%, transparent),
    0 4px 22px color-mix(in srgb, var(--accent) 38%, transparent);
  /* 未激活（无 --e）的字保持完全裁掉，避免静态下与 base 叠加闪动 */
  clip-path: inset(0 100% 0 0);
}
.line.active .w-fill {
  clip-path: inset(
    0
    calc((1 - clamp(0, (var(--e) - var(--s)) / var(--d), 1)) * 100%)
    0
    0
  );
}
/* 行未激活但已唱过：让 fill 完全显示（与 active 视觉一致），保持进度可见 */
.line.passed .w-fill {
  clip-path: inset(0 0 0 0);
}

.mask {
  position: absolute;
  left: 0;
  right: 0;
  height: 42px;
  pointer-events: none;
}
.mask.top {
  top: 0;
  background: linear-gradient(180deg, rgba(8, 8, 12, 0.55), transparent);
}
.mask.bottom {
  bottom: 0;
  background: linear-gradient(0deg, rgba(8, 8, 12, 0.55), transparent);
}

.hint {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--text-3);
  font-size: 12.5px;
  text-align: center;
}
.hint strong {
  color: var(--text-2);
  font-size: 16px;
  font-weight: 600;
}
.hint small {
  font-size: 12px;
  color: var(--text-3);
}

.disc {
  width: 54px;
  height: 54px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  display: grid;
  place-items: center;
  font-size: 20px;
  color: var(--text-2);
  background: var(--panel);
  margin-bottom: 6px;
}

.spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.15);
  border-top-color: var(--accent);
  animation: spin 0.9s linear infinite;
}

.plain {
  height: 100%;
  overflow-y: auto;
  padding: 12px 8px;
  color: var(--text-2);
  font-size: 14px;
  line-height: 2;
  text-align: center;
}
.plain p {
  margin: 0;
}
</style>
