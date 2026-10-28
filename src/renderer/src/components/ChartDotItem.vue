<script setup lang="ts">
import { computed } from 'vue'
import type { ChartSummary } from '@shared/types'

const props = defineProps<{
  chart: ChartSummary
  /** 圆点颜色：不传则按色板循环取 */
  color?: string
}>()

/** 8 色循环色板：榜单入口小圆点用，各榜单可区分 */
const PALETTE = [
  '#e5484d', // crimson
  '#f59e0b', // amber
  '#22c55e', // green
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#f472b6', // pink
  '#14b8a6', // teal
  '#fb923c' // orange
]

const dotColor = computed(
  () => props.color ?? PALETTE[Math.abs(hash(props.chart.id)) % PALETTE.length]
)

function hash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return h
}
</script>

<template>
  <router-link :to="`/charts/${chart.platform}/${chart.id}`" class="chart-dot">
    <i class="dot" :style="{ background: dotColor }" />
    <span>{{ chart.name }}</span>
    <small>{{ chart.updateFrequency ?? '实时' }}</small>
  </router-link>
</template>

<style scoped>
.chart-dot {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  min-height: 44px;
  padding: 0 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel);
  transition: all 0.18s var(--ease);
}
.chart-dot:hover {
  background: var(--panel-strong);
  border-color: var(--border-strong);
}

.dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  box-shadow: 0 0 8px color-mix(in srgb, currentColor 40%, transparent);
}

.chart-dot > span {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  /* 单行完整显示：不换行、不省略 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: clip;
}
.chart-dot > small {
  flex: none;
  margin-left: auto;
  padding-left: 8px;
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
}
</style>
