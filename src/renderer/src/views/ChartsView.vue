<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ChartSummary, Song } from '@shared/types'
import Icon from '../components/Icon.vue'
import { useAppStore } from '../stores/app'
import { usePlayerStore } from '../stores/player'

const app = useAppStore()
const player = usePlayerStore()
const charts = ref<ChartSummary[]>([])
const loading = ref(false)

const provider = computed(() => app.currentProvider)
const supported = computed(() => provider.value?.capabilities.charts ?? false)

const alternatives = computed(() => app.providers.filter((item) => item.capabilities.charts))

/** 音源切换行：所有支持榜单的音源，点击即切换并重载 */
const providerChips = alternatives

/* ---------------- TOP3 预览：9 张卡片全带预览（每卡 1 次 limit=3 请求） ---------------- */
const PREVIEW_LIMIT = 9
const previews = ref<Record<string, Song[]>>({})
const previewLoading = ref(false)
/** 竞态令牌：切音源后旧请求不得回写 */
let loadToken = 0

async function loadPreviews(list: ChartSummary[], token: number): Promise<void> {
  const targets = list.slice(0, PREVIEW_LIMIT)
  if (!targets.length) {
    previews.value = {}
    return
  }
  previewLoading.value = true
  const results = await Promise.allSettled(
    targets.map((chart) =>
      window.api.chartDetail({ platform: app.platform, id: chart.id, page: 1, limit: 3 })
    )
  )
  if (token !== loadToken) return
  const next: Record<string, Song[]> = {}
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') next[targets[i].id] = result.value.items.slice(0, 3)
  })
  previews.value = next
  previewLoading.value = false
}

/** 卡片色带：8 色循环色板按榜单 id 哈希取色，与发现页圆点同体系 */
const PALETTE = [
  '#e5484d', '#f59e0b', '#22c55e', '#38bdf8',
  '#a78bfa', '#f472b6', '#14b8a6', '#fb923c'
]
function bandColor(chart: ChartSummary): string {
  let h = 0
  for (let i = 0; i < chart.id.length; i++) h = (h * 31 + chart.id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

/** 音源脏数据兜底：与 player store 的 sanitize 同规则 */
function dispName(song: Song): string {
  return song.name && song.name.toLowerCase() !== 'undefined' ? song.name : '未知曲目'
}

async function load(): Promise<void> {
  const token = ++loadToken
  loading.value = true
  try {
    charts.value = await window.api.charts(app.platform)
  } catch {
    charts.value = []
  } finally {
    if (token === loadToken) loading.value = false
  }
  if (token === loadToken) void loadPreviews(charts.value, token)
}

async function switchTo(id: string): Promise<void> {
  await app.setPlatform(id)
  await load()
}

/** 从榜单第 index 首开始播放（拉完整榜单建队列，预览点击/播放全部共用） */
async function playFrom(chart: ChartSummary, index = 0): Promise<void> {
  try {
    const page = await window.api.chartDetail({
      platform: app.platform,
      id: chart.id,
      page: 1,
      limit: 40
    })
    if (!page.items.length) {
      app.toast(`《${chart.name}》暂时没有可播放曲目`, 'error')
      return
    }
    player.setQueue(page.items, index)
  } catch (err) {
    app.toast((err as Error).message || '榜单加载失败', 'error')
  }
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

    <!-- 骨架与真实卡片同构，避免加载跳变 -->
    <div v-if="loading" class="grid">
      <div v-for="i in 3" :key="i" class="chart-card skeleton" />
    </div>

    <div v-else-if="charts.length" class="grid">
      <article
        v-for="chart in charts"
        :key="chart.id"
        class="chart-card"
        :style="{ '--band': bandColor(chart) }"
      >
        <header class="cc-head">
          <i class="cc-disc" aria-hidden="true" />
          <div class="cc-title">
            <h3>{{ chart.name }}</h3>
            <span>{{ chart.updateFrequency ?? '每日更新' }}</span>
          </div>
          <button class="cc-play" title="播放整个榜单" @click="playFrom(chart)">
            <Icon name="play" :size="14" />
          </button>
        </header>

        <ol v-if="previews[chart.id]?.length" class="cc-list">
          <li v-for="(song, i) in previews[chart.id]" :key="song.id" @click="playFrom(chart, i)">
            <em>{{ i + 1 }}</em>
            <div class="cc-meta">
              <span class="cc-name">{{ dispName(song) }}</span>
              <span class="cc-artist">{{ song.artists.join(' / ') }}</span>
            </div>
            <Icon class="cc-hover-play" name="play" :size="12" />
          </li>
        </ol>
        <p v-else class="cc-none">{{ previewLoading ? '预览加载中…' : '暂无预览' }}</p>

        <footer class="cc-foot">
          <router-link :to="`/charts/${chart.platform}/${chart.id}`" class="cc-more">
            查看完整榜单 →
          </router-link>
        </footer>
      </article>
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

/* ---------------- 榜单卡片 ---------------- */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.chart-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 12px;
  border-radius: 16px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-top: 3px solid var(--band);
  transition: all 0.2s var(--ease);
}
.chart-card:hover {
  background: var(--panel-strong);
  border-color: var(--border-strong);
  border-top-color: var(--band);
  transform: translateY(-2px);
}
.chart-card.skeleton {
  min-height: 218px;
}

.cc-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cc-disc {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, color-mix(in srgb, var(--band) 55%, #fff) 0 12%, transparent 13%),
    repeating-radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.18) 0 1px, transparent 1px 3px),
    radial-gradient(circle at 40% 35%, var(--band), color-mix(in srgb, var(--band) 45%, #101018));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--band) 35%, transparent);
}
.cc-title {
  flex: 1;
  min-width: 0;
}
.cc-title h3 {
  margin: 0;
  font-size: 14.5px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cc-title span {
  font-size: 10.5px;
  color: var(--text-3);
}
.cc-play {
  flex: none;
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  background: var(--band);
  opacity: 0.88;
  transition: all 0.18s var(--ease);
}
.cc-play:hover {
  opacity: 1;
  transform: scale(1.06);
}

.cc-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
}
.cc-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}
.cc-list li:hover {
  background: var(--panel-strong);
}
.cc-list em {
  flex: none;
  width: 16px;
  font-style: normal;
  font-size: 11px;
  font-weight: 700;
  color: var(--band);
  font-variant-numeric: tabular-nums;
}
.cc-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.cc-name {
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cc-artist {
  flex: none;
  max-width: 45%;
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cc-hover-play {
  flex: none;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.15s;
}
.cc-list li:hover .cc-hover-play {
  opacity: 1;
}
.cc-none {
  margin: 6px 0;
  font-size: 11.5px;
  color: var(--text-3);
}

.cc-foot {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: auto;
}
.cc-more {
  font-size: 11.5px;
  color: var(--text-3);
  transition: color 0.15s;
}
.cc-more:hover {
  color: var(--text);
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

@media (max-width: 640px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
