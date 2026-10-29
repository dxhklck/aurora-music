<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Song } from '@shared/types'
import { gradientFromSeed } from '../core/cover'
import { plain } from '../core/plain'

const props = withDefaults(
  defineProps<{
    src?: string | null
    seed: string
    size?: number
    radius?: number
    spinning?: boolean
    /** 传入歌曲对象时，若 src 为空会跨平台补全封面 */
    song?: Song | null
  }>(),
  { src: null, size: 48, radius: 10, spinning: false, song: null }
)

const background = computed(() => gradientFromSeed(props.seed))
const resolved = ref<string | null>(null)
let token = 0

async function tryResolve(): Promise<void> {
  // 已有直接封面，或没有歌曲对象可补，都用原始 src
  if (props.src) {
    resolved.value = props.src
    return
  }
  if (!props.song) {
    resolved.value = null
    return
  }
  const current = ++token
  try {
    const url = await window.api.coverResolve(plain(props.song))
    if (current === token) resolved.value = url
  } catch {
    // 补全失败就保持占位，不报错打断用户
  }
}

watch(
  () => [props.src, props.song?.id, props.song?.platform],
  () => {
    void tryResolve()
  },
  { immediate: true }
)

const showSrc = computed(() => resolved.value)
</script>

<template>
  <div
    class="cover"
    :class="{ spinning }"
    :style="{
      width: size + 'px',
      height: size + 'px',
      borderRadius: radius + 'px',
      background
    }"
  >
    <img v-if="showSrc" :src="showSrc" :alt="seed" loading="lazy" draggable="false" />
    <span
      v-else
      class="initial"
      :style="{ fontSize: Math.max(12, Math.round(size * 0.36)) + 'px' }"
    >
      {{ seed.slice(0, 1).toUpperCase() }}
    </span>
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.35);
  transition: border-radius 0.3s var(--ease);
}

.cover::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.18), transparent 45%);
  pointer-events: none;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.initial {
  font-size: 14px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.82);
  letter-spacing: 0.5px;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}

.cover.spinning {
  animation: turn 18s linear infinite;
}

@keyframes turn {
  to {
    transform: rotate(360deg);
  }
}
</style>
