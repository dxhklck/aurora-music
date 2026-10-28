<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ChartSummary } from '@shared/types'
import ChartDotItem from '../components/ChartDotItem.vue'
import Icon from '../components/Icon.vue'
import { useAppStore } from '../stores/app'

const app = useAppStore()
const charts = ref<ChartSummary[]>([])
const loading = ref(false)

const provider = computed(() => app.currentProvider)
const supported = computed(() => provider.value?.capabilities.charts ?? false)

const alternatives = computed(() => app.providers.filter((item) => item.capabilities.charts))

/** 音源切换行：所有支持榜单的音源，点击即切换并重载 */
const providerChips = alternatives

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

    <div class="providers">
      <button
        v-for="item in providerChips"
        :key="item.id"
        class="p-chip"
        :class="{ on: item.id === app.platform }"
        :style="item.id === app.platform ? { borderColor: item.color } : undefined"
        @click="switchTo(item.id)"
      >
        <i class="dot" :style="{ background: item.color }" />
        {{ item.name }}
      </button>
    </div>

    <div v-if="loading" class="grid">
      <div v-for="i in 4" :key="i" class="skeleton card" style="height: 142px" />
    </div>

    <div v-else-if="charts.length" class="grid">
      <ChartDotItem v-for="chart in charts" :key="chart.id" :chart="chart" />
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

.providers {
  display: flex;
  gap: 8px;
  margin: 0 0 18px;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: none;
}
.providers::-webkit-scrollbar {
  display: none;
}
.p-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 13px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--border);
  transition: all 0.18s var(--ease);
}
.p-chip:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
.p-chip.on {
  color: var(--text);
  background: rgba(255, 255, 255, 0.09);
  font-weight: 600;
}
.p-chip .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px 12px;
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
