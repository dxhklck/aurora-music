<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import ChartDotItem from '../components/ChartDotItem.vue'
import VinylDisc from '../components/VinylDisc.vue'
import SongTable from '../components/SongTable.vue'
import { useAppStore } from '../stores/app'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useSearchStore } from '../stores/search'
import type { ChartSummary } from '@shared/types'

const app = useAppStore()
const player = usePlayerStore()
const library = useLibraryStore()
const search = useSearchStore()
const router = useRouter()

const charts = ref<ChartSummary[]>([])
const loading = ref(false)
const starting = ref(false)

const provider = computed(() => app.currentProvider)
const recent = computed(() => player.recent.slice(0, 6))
/** 首页排行榜区块只精选前 4 个（全量榜单在「排行榜」页） */
const featuredCharts = computed(() => charts.value.slice(0, 4))
/**
 * 底部搜索胶囊：三路混排，替代原来的 5 个写死词。
 * 1. 最近播放里的歌手（去重取 2 个）——跟着用户口味走
 * 2. 时段风格词——和 hero 的时段推荐一个体系
 * 3. 大众兜底词——历史为空时也不冷场
 * 引擎海外音源（mdl-）整组换成英文风格词，避免中文词搜不到东西。
 */
const suggestions = computed<string[]>(() => {
  if (provider.value?.id.startsWith('mdl-')) {
    return ['Lo-Fi', 'Jazz', 'Piano', 'Acoustic', 'Chill']
  }
  const artists: string[] = []
  for (const song of player.recent) {
    for (const name of song.artists) {
      const trimmed = name.trim()
      if (trimmed && !artists.includes(trimmed)) artists.push(trimmed)
    }
    if (artists.length >= 2) break
  }
  return [...new Set([...artists, bucket.value.styleWord, '周杰伦', '晴天', '陈奕迅'])].slice(0, 5)
})

/* ---------------- 时段推荐：不同时段选不同榜单 + 不同开场白 ---------------- */
interface TimeBucket {
  from: number
  to: number
  title: [string, string]
  tagline: string
  /** 按榜单名关键字挑（榜单顺序各平台不同，匹配不到就退回第一个） */
  chartKind: string
  /** 时段风格搜索词：喂给底部胶囊 */
  styleWord: string
}
const BUCKETS: TimeBucket[] = [
  { from: 5, to: 11, title: ['把清晨留给', '旋律'], tagline: '清晨时段 · 用新歌开始一天', chartKind: '新歌', styleWord: '轻快' },
  { from: 11, to: 17, title: ['把午后留给', '节拍'], tagline: '午后时段 · 热歌正当时', chartKind: '热歌', styleWord: 'City Pop' },
  { from: 17, to: 23, title: ['把黄昏留给', '慢板'], tagline: '黄昏时段 · 听听正在飙升的', chartKind: '飙升', styleWord: '怀旧' },
  { from: 23, to: 5, title: ['把夜晚留给', '声音'], tagline: '深夜时段 · 声音调暗一点', chartKind: '热歌', styleWord: '助眠' }
]
const bucket = computed<TimeBucket>(() => {
  const h = new Date().getHours()
  return (
    BUCKETS.find((b) => (b.from <= b.to ? h >= b.from && h < b.to : h >= b.from || h < b.to)) ??
    BUCKETS[3]
  )
})
/** 当前时段推荐的榜单（从已加载的榜单里按名挑） */
const heroChart = computed<ChartSummary | undefined>(
  () => charts.value.find((c) => c.name.includes(bucket.value.chartKind)) ?? charts.value[0]
)
const heroTag = computed(() =>
  heroChart.value ? `hero:${app.platform}:${heroChart.value.id}` : ''
)
/** 按钮文案：队列就是当前时段的榜单 → 「继续播放」；否则「立即播放」 */
const buttonLabel = computed(() =>
  heroTag.value && player.queueTag === heroTag.value && player.queue.length
    ? '继续播放'
    : '立即播放'
)

async function loadCharts(): Promise<void> {
  loading.value = true
  try {
    charts.value = await window.api.charts(app.platform)
  } catch {
    charts.value = []
  } finally {
    loading.value = false
  }
}

async function startListening(): Promise<void> {
  // 会话内已经建过这份榜单的队列：不重建，直接接着播（按钮此时就是暂停/继续）
  if (heroTag.value && player.queueTag === heroTag.value && player.queue.length) {
    void player.toggle()
    return
  }
  const chart = heroChart.value
  if (!chart) {
    if (!player.queue.length) {
      const page = await window.api.search({
        platform: app.platform,
        keyword: '',
        page: 1,
        limit: 30
      }).catch(() => null)
      if (page?.items.length) player.setQueue(page.items, 0)
    } else {
      void player.toggle()
    }
    return
  }
  starting.value = true
  try {
    const page = await window.api.chartDetail({
      platform: app.platform,
      id: chart.id,
      page: 1,
      limit: 40
    })
    if (!page.items.length) {
      app.toast('该榜单暂时没有可播放曲目', 'error')
      return
    }
    const result = await player.startHero(page.items, `hero:${app.platform}:${chart.id}`)
    if (result.resumed) {
      app.toast(`接上上次没听完的《${result.song?.name ?? ''}》`, 'info')
    }
  } catch (error) {
    app.toast((error as Error).message || '加载失败', 'error')
  } finally {
    starting.value = false
  }
}

function quickSearch(keyword: string): void {
  void router.push({ name: 'search' })
  void search.run(keyword)
}

onMounted(async () => {
  await loadCharts()
  if (!library.items.length) void library.load()
})

watch(() => app.platform, loadCharts)
</script>

<template>
  <div class="discover">
    <section class="hero">
      <div class="hero-glow" />
      <div class="hero-content">
        <span class="eyebrow">AURORA · 沉浸式音乐空间</span>
        <h1>
          {{ bucket.title[0] }}<br />
          <em>{{ bucket.title[1] }}</em>
        </h1>
        <p>
          {{ provider?.name }} 已就绪 —— {{ provider?.description }}
        </p>
        <div class="hero-actions">
          <button class="btn primary" :disabled="starting" @click="startListening">
            <Icon name="play" :size="15" />
            {{ starting ? '正在准备…' : buttonLabel }}
          </button>
          <button class="btn" @click="router.push({ name: 'charts' })">
            <Icon name="chart" :size="15" />
            浏览榜单
          </button>
        </div>
        <div class="pills">
          <span class="pill">{{ bucket.tagline }}</span>
          <span class="pill">
            <i class="dot" :style="{ background: provider?.color }" />
            {{ provider?.name }}
          </span>
          <span class="pill">{{ player.queue.length }} 首在队列</span>
          <span class="pill" v-if="library.items.length">{{ library.items.length }} 首本地</span>
        </div>
      </div>

      <div class="hero-visual">
        <!-- 黑胶：播放时才旋转，唱臂默认停在盘外（size=0 自适应容器） -->
        <VinylDisc :size="0" />
      </div>
    </section>

    <div class="chips">
      <button v-for="item in suggestions" :key="item" class="chip" @click="quickSearch(item)">
        <Icon name="search" :size="13" />
        {{ item }}
      </button>
    </div>

    <template v-if="charts.length">
      <h2 class="section-title">
        排行榜
        <span class="tag">{{ provider?.name }}</span>
        <button class="text-btn" @click="router.push({ name: 'charts' })">更多榜单 →</button>
      </h2>
      <div class="chart-grid">
        <!-- 首页只精选前 4 个榜单（榜单全量在「排行榜」页） -->
        <ChartDotItem v-for="chart in featuredCharts" :key="chart.id" :chart="chart" />
      </div>
    </template>

    <template v-if="recent.length">
      <h2 class="section-title">
        最近播放
        <button class="text-btn" @click="player.showQueue = true">查看队列 →</button>
      </h2>
      <SongTable :songs="recent" :show-album="false" empty-title="还没有播放记录" />
    </template>

    <div class="notice" v-if="provider?.note">
      <Icon name="clock" :size="14" />
      {{ provider.note }}
    </div>
  </div>
</template>

<style scoped>
.discover {
  padding-top: 4px;
}

.hero {
  position: relative;
  border-radius: 26px;
  padding: 40px 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  overflow: hidden;
  background: linear-gradient(
    120deg,
    color-mix(in srgb, var(--accent) 26%, rgba(255, 255, 255, 0.03)),
    rgba(255, 255, 255, 0.02) 60%
  );
  border: 1px solid var(--border);
  min-height: 300px;
}

.hero-glow {
  position: absolute;
  width: 520px;
  height: 520px;
  border-radius: 50%;
  right: -80px;
  top: -220px;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent-2) 45%, transparent), transparent 65%);
  filter: blur(30px);
  opacity: 0.7;
}

.hero-content {
  position: relative;
  z-index: 2;
  max-width: 560px;
}

.eyebrow {
  font-size: 10.5px;
  letter-spacing: 2.4px;
  color: var(--text-3);
  text-transform: uppercase;
}

.hero h1 {
  margin: 14px 0 12px;
  font-size: 46px;
  line-height: 1.08;
  font-weight: 800;
  letter-spacing: -0.5px;
}
.hero h1 em {
  font-style: normal;
  background: linear-gradient(100deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.hero p {
  margin: 0 0 22px;
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.7;
  max-width: 440px;
}

.hero-actions {
  display: flex;
  gap: 10px;
}

.pills {
  display: flex;
  gap: 8px;
  margin-top: 20px;
  flex-wrap: wrap;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
}
.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.hero-visual {
  position: relative;
  /* 明显放大：唱片尺寸由组件按容器短边自适应（0.9 比例） */
  width: clamp(270px, 24vw, 380px);
  height: clamp(210px, 19vw, 310px);
  display: grid;
  place-items: center;
  flex-shrink: 0;
  overflow: visible;
}

.chips {
  display: flex;
  gap: 8px;
  margin-top: 18px;
  flex-wrap: wrap;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 13px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--border);
  transition: all 0.2s var(--ease);
}
.chip:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.1);
  border-color: var(--border-strong);
}

.chart-grid {
  display: grid;
  /* 所有榜单强制同一行：列数跟随榜单数量，每列等宽收窄铺满容器 */
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 8px 10px;
}

.text-btn {
  font-size: 11px;
  color: var(--text-3);
  margin-left: auto;
  font-weight: 400;
}
.text-btn:hover {
  color: var(--text);
}

.notice {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  color: var(--text-3);
  padding: 10px 14px;
  border-radius: 12px;
  border: 1px dashed var(--border);
}

@media (max-width: 1160px) {
  .hero-visual {
    display: none;
  }
  .hero h1 {
    font-size: 38px;
  }
}

/* 手机规格：hero 收紧、按钮加大到 44px 触控、搜索胶囊可横滑 */
@media (max-width: 640px) {
  .hero {
    padding: 24px 20px;
    min-height: 0;
    border-radius: 20px;
  }
  .eyebrow {
    font-size: 10px;
    letter-spacing: 2px;
  }
  .hero h1 {
    font-size: 30px;
    margin: 10px 0 8px;
  }
  .hero p {
    margin-bottom: 16px;
    font-size: 12.5px;
  }
  .hero-actions .btn {
    height: 44px;
    flex: 1;
    font-size: 14px;
  }
  .pills {
    margin-top: 14px;
    gap: 6px;
  }
  .chips {
    margin-top: 14px;
    flex-wrap: nowrap;
    overflow-x: auto;
    scrollbar-width: none;
    margin-right: -14px;
    padding-right: 14px;
  }
  .chips::-webkit-scrollbar {
    display: none;
  }
  .chip {
    height: 38px;
    padding: 0 15px;
    font-size: 12.5px;
    flex-shrink: 0;
  }
  .chart-grid {
    gap: 4px 10px;
    /* 手机上单行塞不下全部榜单：仍保持单行，改为横向滑动，列保住最小可读宽度 */
    grid-auto-columns: minmax(150px, 1fr);
    overflow-x: auto;
    scrollbar-width: none;
    margin-right: -14px;
    padding-right: 14px;
  }
  .chart-grid::-webkit-scrollbar {
    display: none;
  }
}
</style>
