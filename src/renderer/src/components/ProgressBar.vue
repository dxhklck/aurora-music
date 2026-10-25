<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    value: number
    buffered?: number
    height?: number
    disabled?: boolean
  }>(),
  { buffered: 0, height: 4, disabled: false }
)

const emit = defineEmits<{ seek: [ratio: number] }>()

const track = ref<HTMLElement | null>(null)
const dragging = ref(false)
const hoverRatio = ref<number | null>(null)

const percent = computed(() => Math.max(0, Math.min(1, props.value)) * 100)
const bufferPercent = computed(() => Math.max(0, Math.min(1, props.buffered)) * 100)
const bubbleLeft = computed(() => `${(hoverRatio.value ?? 0) * 100}%`)

function ratioFromEvent(event: PointerEvent): number {
  if (!track.value) return 0
  const rect = track.value.getBoundingClientRect()
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  dragging.value = true
  ;(event.target as HTMLElement).setPointerCapture?.(event.pointerId)
  emit('seek', ratioFromEvent(event))
}

function onPointerMove(event: PointerEvent): void {
  if (props.disabled) return
  hoverRatio.value = ratioFromEvent(event)
  if (dragging.value) emit('seek', hoverRatio.value)
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  ;(event.target as HTMLElement).releasePointerCapture?.(event.pointerId)
}

function onLeave(): void {
  hoverRatio.value = null
}
</script>

<template>
  <div
    ref="track"
    class="bar"
    :class="{ dragging, disabled }"
    :style="{ height: height + 'px' }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @pointerleave="onLeave"
  >
    <div class="buffer" :style="{ width: bufferPercent + '%' }" />
    <div class="fill" :style="{ width: percent + '%' }">
      <span class="thumb" />
    </div>
    <span v-if="hoverRatio !== null && !disabled" class="bubble" :style="{ left: bubbleLeft }" />
  </div>
</template>

<style scoped>
.bar {
  position: relative;
  width: 100%;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
  display: flex;
  align-items: center;
  touch-action: none;
}
.bar.disabled {
  cursor: default;
  opacity: 0.5;
}

.buffer {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
}

.fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  display: flex;
  align-items: center;
  justify-content: flex-end;
  transition: width 0.12s linear;
}
.bar.dragging .fill {
  transition: none;
}

.thumb {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.55);
  transform: scale(0);
  transition: transform 0.16s var(--ease);
  margin-right: -5px;
}
.bar:hover .thumb,
.bar.dragging .thumb {
  transform: scale(1);
}

.bubble {
  position: absolute;
  top: -6px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.65);
  transform: translateX(-3px);
  pointer-events: none;
}
</style>
