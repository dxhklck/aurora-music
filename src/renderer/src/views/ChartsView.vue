<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ChartSummary } from '@shared/types'
import ChartCard from '../components/ChartCard.vue'
import Icon from '../components/Icon.vue'
import { useAppStore } from '../stores/app'

const app = useAppStore()
const charts = ref<ChartSummary[]>([])
const loading = ref(false)

const provider = computed(() => app.currentProvider)
const supported = computed(() => provider.value?.capabilities.charts ?? false)

const alternatives = computed(() => app.providers.filter((item) => item.capabilities.charts))

async function load(): Promise<void> {
  loading.value = true
  try {
    charts.value = await window.api.charts(app.platform)
  } catch {
    charts.value = []
  } finally {
    loading.value = false
  }
}

async function switchTo(id: string): Promise<void> {
  await app.setPlatform(id)
  await load()
}

onMounted(load)
watch(() => app.platform, load)
</script>

<template>
  <div class="charts">
    <header class="head">
      <div>
        <h1>排行榜</h1>
        <p>{{ provider?.name }} 的官方榜单，每日同步</p>
      </div>
      <span class="tag">{{ charts.length }} 个榜单</span>
    </header>

    <div v-if="loading" class="grid">
      <div v-for="i in 4" :key="i" class="skeleton card" style="height: 142px" />
    </div>

    <div v-else-if="charts.length" class="grid">
      <ChartCard v-for="chart in charts" :key="chart.id" :chart="chart" />
    </div>

    <div v-else class="empty-box">
      <span class="icon-wrap"><Icon name="chart" :size="26" /></span>
      <strong>{{ supported ? '暂时没有拿到榜单' : `${provider?.name} 不提供榜单` }}</strong>
      <p>
        {{
          supported
            ? '可能是接口限流，稍后重试或切换音源。'
            : '换个支持榜单的音源即可浏览热歌榜、新歌榜与飙升榜。'
        }}
      </p>
      <div class="alts">
        <button
          v-for="item in alternatives"
          :key="item.id"
          class="btn"
          :style="{ borderColor: item.color + '55' }"
          @click="switchTo(item.id)"
        >
          <i class="dot" :style="{ background: item.color }" />
          {{ item.name }}
        </button>
        <button class="btn" @click="load">
          <Icon name="refresh" :size="14" />
          重试
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin: 10px 0 22px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 750;
}
.head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
  gap: 12px;
}

.empty-box {
  margin-top: 40px;
  padding: 54px 30px;
  border-radius: 22px;
  border: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.icon-wrap {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  background: var(--panel);
  color: var(--text-2);
  margin-bottom: 8px;
}
.empty-box strong {
  font-size: 15px;
}
.empty-box p {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
  max-width: 420px;
  line-height: 1.7;
}
.alts {
  display: flex;
  gap: 8px;
  margin-top: 14px;
  flex-wrap: wrap;
  justify-content: center;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
</style>
