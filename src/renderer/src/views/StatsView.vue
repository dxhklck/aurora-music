<script setup lang="ts">
import { computed } from 'vue'
import CoverArt from '../components/CoverArt.vue'
import Icon from '../components/Icon.vue'
import { useStatsStore } from '../stores/stats'
import { usePlayerStore } from '../stores/player'
import {
  activeDays,
  formatListenTime,
  lastDays,
  listenStreak,
  platformBreakdown,
  topSongs
} from './stats/aggregate'

const stats = useStatsStore()
const player = usePlayerStore()

const heatmap = computed(() => lastDays(stats.data.days, 91))
/** 13 列 × 7 行的最大值，用来给格子上色 */
const heatMax = computed(() => Math.max(...heatmap.value.map((day) => day.ms), 1))
const active = computed(() => activeDays(stats.data.days))
const streak = computed(() => listenStreak(stats.data.days))
const monthlyTop = computed(() => topSongs(stats.data.songs, 20, 30))
const sources = computed(() => platformBreakdown(stats.data.songs))
const sourceMax = computed(() => Math.max(...sources.value.map((item) => item.count), 1))

/** 五档强度：0 为没听，其余按当日时长占峰值的比例分档 */
function level(ms: number): number {
  if (ms <= 0) return 0
  const ratio = ms / heatMax.value
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

const platformLabel: Record<string, string> = {
  netease: '网易云',
  qq: 'QQ 音乐',
  kuwo: '酷我',
  local: '本地文件'
}

function labelOf(platform: string): string {
  return platformLabel[platform] ?? platform.replace(/^mdl-/, '')
}

function playTop(index: number): void {
  const list = monthlyTop.value.map((item) => item.song)
  if (list.length) player.setQueue(list, index)
}
</script>

<template>
  <div class="stats">
    <header class="head">
      <div>
        <h1>收听报告</h1>
        <p class="sub">
          数据只存在这台机器上（localStorage），封顶 300 首 / 90 天，不会上传到任何地方。
        </p>
      </div>
      <div class="total">
        <span>累计收听</span>
        <strong>{{ formatListenTime(stats.totalListenMs) }}</strong>
      </div>
    </header>

    <section class="cards">
      <article class="card">
        <span>今天</span>
        <strong>{{ formatListenTime(stats.todayListenMs) }}</strong>
      </article>
      <article class="card">
        <span>有收听的天数</span>
        <strong>{{ active }} 天</strong>
      </article>
      <article class="card">
        <span>连续收听</span>
        <strong>{{ streak }} 天</strong>
      </article>
      <article class="card">
        <span>听过的不重复曲目</span>
        <strong>{{ Object.keys(stats.data.songs).length }} 首</strong>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2>最近 13 周</h2>
        <span class="hint">每格一天，颜色越深听得越久</span>
      </div>
      <div class="heatmap" role="img" aria-label="最近 13 周的收听热力图">
        <span
          v-for="day in heatmap"
          :key="day.key"
          class="cell"
          :class="`lv-${level(day.ms)}`"
          :title="`${day.key} · ${day.ms > 0 ? formatListenTime(day.ms) : '没有收听'}`"
        />
      </div>
    </section>

    <div class="two-col">
      <section class="panel">
        <div class="panel-head">
          <h2>本月最常听</h2>
          <span class="hint">{{ monthlyTop.length }} 首</span>
        </div>
        <div v-if="monthlyTop.length" class="top-list">
          <button
            v-for="(item, index) in monthlyTop"
            :key="item.key"
            class="top-row"
            @click="playTop(index)"
          >
            <span class="rank">{{ index + 1 }}</span>
            <CoverArt
              :src="item.song.coverUrl"
              :seed="item.key"
              :size="38"
              :radius="8"
              :song="item.song"
            />
            <span class="text">
              <strong class="truncate">{{ item.song.name }}</strong>
              <small class="truncate">{{ item.song.artists.join(' / ') || '未知歌手' }}</small>
            </span>
            <span class="count">{{ item.count }} 次</span>
          </button>
        </div>
        <p v-else class="empty">还没有足够的记录。听过几首之后这里会出现排行。</p>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>来源分布</h2>
          <span class="hint">按播放次数</span>
        </div>
        <div v-if="sources.length" class="bars">
          <div v-for="item in sources" :key="item.platform" class="bar-row">
            <span class="bar-label">{{ labelOf(item.platform) }}</span>
            <span class="bar-track">
              <span class="bar-fill" :style="{ width: `${(item.count / sourceMax) * 100}%` }" />
            </span>
            <span class="bar-value">{{ item.count }}</span>
          </div>
        </div>
        <p v-else class="empty">还没有播放记录。</p>

        <div class="hour-note">
          <Icon name="info" :size="13" />
          <span>只记「谁听了多少次、哪天听了多久」，不记听了哪一秒、也不记设备信息。</span>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.stats {
  padding: 22px 26px 90px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.head h1 {
  margin: 0 0 6px;
  font-size: 22px;
}

.sub {
  margin: 0;
  color: var(--text-3);
  font-size: 12px;
  max-width: 520px;
  line-height: 1.6;
}

.total {
  text-align: right;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.total span {
  font-size: 11px;
  color: var(--text-3);
}

.total strong {
  font-size: 20px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card span {
  font-size: 11px;
  color: var(--text-3);
}

.card strong {
  font-size: 18px;
}

.panel {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px 18px;
}

.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}

.panel-head h2 {
  margin: 0;
  font-size: 14px;
}

.hint {
  font-size: 11px;
  color: var(--text-3);
}

.heatmap {
  display: grid;
  grid-template-rows: repeat(7, 12px);
  grid-auto-flow: column;
  grid-auto-columns: 12px;
  gap: 4px;
  overflow-x: auto;
  padding-bottom: 2px;
}

.cell {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  background: var(--bg-soft, rgba(255, 255, 255, 0.05));
  border: 1px solid var(--border);
}

.cell.lv-1 {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  border-color: transparent;
}

.cell.lv-2 {
  background: color-mix(in srgb, var(--accent) 42%, transparent);
  border-color: transparent;
}

.cell.lv-3 {
  background: color-mix(in srgb, var(--accent) 65%, transparent);
  border-color: transparent;
}

.cell.lv-4 {
  background: var(--accent);
  border-color: transparent;
}

.two-col {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.top-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.top-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.top-row:hover {
  background: var(--bg-soft);
}

.rank {
  width: 18px;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.text strong {
  font-size: 12.5px;
  font-weight: 550;
}

.text small {
  font-size: 11px;
  color: var(--text-3);
}

.count {
  font-size: 11px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bar-row {
  display: grid;
  grid-template-columns: 68px minmax(0, 1fr) 36px;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
}

.bar-label {
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar-track {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-soft, rgba(255, 255, 255, 0.06));
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2, var(--accent)));
}

.bar-value {
  text-align: right;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

.hour-note {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
}

.empty {
  margin: 6px 0;
  font-size: 12px;
  color: var(--text-3);
}

@media (max-width: 1080px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .two-col {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
