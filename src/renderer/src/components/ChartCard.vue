<script setup lang="ts">
import { computed } from 'vue'
import type { ChartSummary } from '@shared/types'
import CoverArt from './CoverArt.vue'
import Icon from './Icon.vue'

const props = defineProps<{ chart: ChartSummary }>()

const seed = computed(() => `${props.chart.platform}:${props.chart.id}`)
</script>

<template>
  <router-link :to="`/charts/${chart.platform}/${chart.id}`" class="chart-card card">
    <div class="art">
      <CoverArt :src="chart.coverUrl" :seed="seed" :size="118" :radius="14" />
      <span class="freq">{{ chart.updateFrequency ?? '实时' }}</span>
      <span class="play"><Icon name="play" :size="16" /></span>
    </div>
    <div class="meta">
      <strong class="truncate">{{ chart.name }}</strong>
      <small class="truncate">{{ chart.subtitle ?? '—' }}</small>
    </div>
  </router-link>
</template>

<style scoped>
.chart-card {
  display: flex;
  gap: 14px;
  padding: 12px;
  align-items: center;
  min-width: 0;
}

.art {
  position: relative;
  line-height: 0;
  border-radius: 14px;
  overflow: hidden;
}

.freq {
  position: absolute;
  left: 6px;
  bottom: 6px;
  font-size: 9px;
  padding: 2px 6px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.55);
  color: rgba(255, 255, 255, 0.7);
  backdrop-filter: blur(6px);
}

.play {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
  opacity: 0;
  transition: opacity 0.22s var(--ease);
}
.chart-card:hover .play {
  opacity: 1;
}

.meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.meta strong {
  font-size: 14px;
  font-weight: 600;
}
.meta small {
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.5;
}
</style>
