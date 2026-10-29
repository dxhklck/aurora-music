<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ChartSummary, Song } from '@shared/types'
import SongTable from '../components/SongTable.vue'
import Icon from '../components/Icon.vue'
import { useAppStore } from '../stores/app'
import { usePlayerStore } from '../stores/player'

const props = defineProps<{ platform: string; id: string }>()

const app = useAppStore()
const player = usePlayerStore()
const router = useRouter()

const chart = ref<ChartSummary | null>(null)
const songs = ref<Song[]>([])
const total = ref(0)
const hasMore = ref(false)
const page = ref(1)
const loading = ref(true)
const loadingMore = ref(false)
const error = ref('')

const provider = computed(() => app.providers.find((item) => item.id === props.platform))
/** 引擎音源才带精确文件大小（sizeBytes），内置音源没有这个数据 */
const isEngine = computed(() => props.platform.startsWith('mdl-'))

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const charts = await window.api.charts(props.platform)
    chart.value = charts.find((item) => item.id === props.id) ?? null
    const result = await window.api.chartDetail({
      platform: props.platform,
      id: props.id,
      page: 1,
      limit: 40
    })
    songs.value = result.items
    total.value = result.total
    hasMore.value = result.hasMore
    page.value = 1
  } catch (err) {
    error.value = (err as Error).message || '榜单加载失败'
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loadingMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const result = await window.api.chartDetail({
      platform: props.platform,
      id: props.id,
      page: next,
      limit: 40
    })
    songs.value = [...songs.value, ...result.items]
    hasMore.value = result.hasMore
    page.value = next
  } catch {
    /* ignore */
  } finally {
    loadingMore.value = false
  }
}

function playAll(): void {
  if (!songs.value.length) return
  player.setQueue(songs.value, 0)
  app.toast(`开始播放《${chart.value?.name ?? '榜单'}》`, 'success')
}

onMounted(load)
</script>

<template>
  <div class="detail">
    <button class="back" @click="router.back()">
      <span>←</span> 返回
    </button>

    <header class="banner">
      <div class="banner-mask" />
      <div class="banner-deco">
        <span class="deco-num">{{ String(total || 100).padStart(3, '0') }}</span>
        <span class="deco-disc" />
      </div>
      <div class="banner-inner">
        <div class="badge">TOP LIST</div>
        <h1>{{ chart?.name ?? '榜单' }}</h1>
        <p>{{ chart?.subtitle ?? `${provider?.name} 官方榜单` }}</p>
        <div class="banner-meta">
          <span>{{ provider?.name }}</span>
          <span>·</span>
          <span>{{ total || songs.length }} 首</span>
          <span>·</span>
          <span>{{ chart?.updateFrequency ?? '每日更新' }}</span>
        </div>
        <div class="banner-actions">
          <button class="btn primary" :disabled="!songs.length" @click="playAll">
            <Icon name="play" :size="15" /> 播放全部
          </button>
        </div>
      </div>
    </header>

    <div v-if="error" class="error-box">
      <Icon name="close" :size="16" />
      <div>
        <strong>加载失败</strong>
        <p>{{ error }}</p>
      </div>
      <button class="btn" @click="load">重试</button>
    </div>

    <SongTable
      :songs="songs"
      :loading="loading"
      :show-size="isEngine"
      selectable
      empty-title="榜单为空"
      empty-hint="换个榜单或音源试试"
    />

    <div v-if="hasMore" class="more">
      <button class="btn" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? '加载中…' : '加载更多' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  padding: 6px 10px;
  border-radius: 8px;
  margin: 4px 0 14px;
}
.back:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.06);
}

.banner {
  position: relative;
  border-radius: 24px;
  overflow: hidden;
  padding: 32px 34px;
  margin-bottom: 24px;
  /* 跟随当前音源强调色：与全站 accent 同源，切音源即时刷新（原来绑定路由平台，切音源不动） */
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
}
.banner-mask {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background:
    radial-gradient(60% 100% at 90% 10%, rgba(255, 255, 255, 0.22), transparent 60%),
    linear-gradient(90deg, rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.12));
}
.banner-inner {
  position: relative;
  z-index: 2;
  color: #fff;
}

.banner-deco {
  position: absolute;
  right: 34px;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 18px;
  z-index: 1;
  pointer-events: none;
}

.deco-num {
  font-size: 128px;
  font-weight: 800;
  line-height: 1;
  color: rgba(255, 255, 255, 0.12);
  letter-spacing: -6px;
  font-variant-numeric: tabular-nums;
}

.deco-disc {
  width: 132px;
  height: 132px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 50% 50%, rgba(255, 255, 255, 0.22) 0 10%, transparent 11%),
    repeating-radial-gradient(circle at 50% 50%, rgba(0, 0, 0, 0.28) 0 1px, rgba(255, 255, 255, 0.06) 1px 4px);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
  opacity: 0.75;
  animation: turn 26s linear infinite;
}

@keyframes turn {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1100px) {
  .banner-deco {
    display: none;
  }
}
.badge {
  font-size: 9.5px;
  letter-spacing: 3px;
  opacity: 0.7;
}
.banner h1 {
  margin: 10px 0 6px;
  font-size: 34px;
  font-weight: 800;
  letter-spacing: -0.4px;
}
.banner p {
  margin: 0;
  font-size: 12.5px;
  opacity: 0.82;
}
.banner-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  opacity: 0.65;
  margin-top: 12px;
}
.banner-actions {
  margin-top: 18px;
}
.banner-actions .btn.primary {
  background: rgba(255, 255, 255, 0.94);
  color: #101018;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.28);
}

.more {
  display: flex;
  justify-content: center;
  padding: 20px 0 6px;
}

.error-box {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid rgba(255, 92, 124, 0.3);
  background: rgba(255, 92, 124, 0.08);
  color: var(--danger);
  margin-bottom: 18px;
}
.error-box strong {
  display: block;
  font-size: 13px;
  margin-bottom: 4px;
}
.error-box p {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-2);
}
</style>
