<script setup lang="ts">
import { onMounted, computed, ref, watch } from 'vue'
import Icon from '../components/Icon.vue'
import SongTable from '../components/SongTable.vue'
import { useSearchStore } from '../stores/search'
import { useAppStore } from '../stores/app'

const search = useSearchStore()
const app = useAppStore()
const input = ref(search.keyword)

/** 引擎音源要逐首解析真实地址，比官方接口慢，加载态要给出解释 */
const isEngine = computed(() => app.platform.startsWith('mdl-'))

function submit(): void {
  void search.run(input.value)
}

function pick(keyword: string): void {
  input.value = keyword
  suggestOpen.value = false
  void search.run(keyword)
}

/* 输入联想：聚焦且输入非空时，下拉匹配历史关键词（含子串，不限前缀） */
const suggestOpen = ref(false)
const suggestions = computed(() => {
  const q = input.value.trim().toLowerCase()
  if (!q || q === search.keyword.toLowerCase()) return []
  return search.history.filter((item) => item.toLowerCase().includes(q)).slice(0, 6)
})

function onBlur(): void {
  // 延迟关闭：让下拉项的 click 先触发（mousedown 已 prevent 掉失焦）
  setTimeout(() => {
    suggestOpen.value = false
  }, 150)
}

onMounted(() => {
  input.value = search.keyword
})

watch(
  () => app.platform,
  () => {
    if (search.keyword) void search.run(search.keyword)
    else search.reset()
  }
)
</script>

<template>
  <div class="search-view">
    <header class="head">
      <div>
        <h1>搜索</h1>
        <p>在 {{ app.currentProvider?.name }} 中检索，结果可一键播放或加入下载队列</p>
      </div>
      <span class="tag" v-if="search.cost">{{ search.cost }} ms</span>
    </header>

    <div class="search-box glass">
      <Icon name="search" :size="18" />
      <input
        v-model="input"
        placeholder="输入歌曲、歌手或专辑名，回车搜索"
        spellcheck="false"
        @focus="suggestOpen = suggestions.length > 0"
        @input="suggestOpen = true"
        @blur="onBlur"
        @keydown.enter="submit"
      />
      <button class="btn primary" @click="submit">搜索</button>
      <div v-if="suggestOpen && suggestions.length" class="suggest glass">
        <button
          v-for="item in suggestions"
          :key="item"
          class="s-item"
          @mousedown.prevent
          @click="pick(item)"
        >
          <Icon name="search" :size="13" />
          {{ item }}
        </button>
      </div>
    </div>

    <div v-if="search.history.length" class="history">
      <span class="label">最近搜索</span>
      <button v-for="item in search.history" :key="item" class="hchip" @click="pick(item)">
        {{ item }}
      </button>
      <button class="clear" @click="search.clearHistory()">清空</button>
    </div>

    <div v-if="search.error" class="error-box">
      <Icon name="close" :size="16" />
      <div>
        <strong>搜索失败</strong>
        <p>{{ search.error }}</p>
      </div>
      <button class="btn" @click="submit">重试</button>
    </div>

    <template v-if="search.keyword">
      <div class="result-head">
        <h2>
          “{{ search.keyword }}”
          <span v-if="search.total" class="count">{{ search.total }} 条结果</span>
        </h2>
        <span class="dim">来自 {{ app.currentProvider?.name }}</span>
      </div>

      <div v-if="search.loading && isEngine && !search.results.length" class="engine-hint">
        <span class="pulse" />
        引擎音源要逐首解析真实地址，解析出一首就显示一首；同一关键词会缓存 3 分钟
      </div>

      <SongTable
        :songs="search.results"
        :loading="search.loading"
        :show-size="isEngine"
        selectable
        empty-title="没有找到匹配的歌曲"
        empty-hint="检查关键词，或到侧边栏切换一个音源"
      />

      <div v-if="search.hasMore" class="more">
        <button class="btn" :disabled="search.loadingMore" @click="search.loadMore()">
          {{ search.loadingMore ? '加载中…' : '加载更多' }}
        </button>
      </div>
    </template>

    <div v-else class="empty guide">
      <strong>开始一次搜索</strong>
      <span>试试歌手名、歌曲名，或者直接粘贴一整句歌词</span>
      <div class="guide-chips">
        <button v-for="item in ['周杰伦', '晴天', '林俊杰', 'Lofi']" :key="item" @click="pick(item)">
          {{ item }}
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
  margin: 10px 0 20px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 750;
  letter-spacing: -0.3px;
}
.head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 54px;
  border-radius: 16px;
  padding: 0 10px 0 18px;
  color: var(--text-3);
  margin-bottom: 16px;
}
.search-box input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 14px;
  color: var(--text);
}
.search-box input::placeholder {
  color: var(--text-3);
}

.history {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 22px;
}
.label {
  font-size: 11px;
  color: var(--text-3);
}
.hchip {
  height: 26px;
  padding: 0 11px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-2);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  transition: all 0.18s;
}
.hchip:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.12);
}
.clear {
  font-size: 11px;
  color: var(--text-3);
  margin-left: 4px;
}
.clear:hover {
  color: var(--text-2);
}

.result-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin: 26px 0 12px;
}

.engine-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 11px;
  color: var(--text-3);
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid var(--border);
}
.engine-hint .pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent);
  animation: hint-pulse 1.4s ease-in-out infinite;
}
@keyframes hint-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.result-head h2 {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
}
.count {
  font-size: 11.5px;
  color: var(--text-3);
  font-weight: 400;
  margin-left: 8px;
}
.dim {
  font-size: 11px;
  color: var(--text-3);
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
  margin-bottom: 20px;
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
  max-width: 640px;
}

.guide {
  padding-top: 60px;
}
.guide-chips {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.guide-chips button {
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 12px;
  color: var(--text-2);
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
}
.guide-chips button:hover {
  color: var(--text);
  background: rgba(255, 255, 255, 0.1);
}

/* 输入联想下拉：贴在搜索框下方。
   底色用 --bg 高比例混合（而非 .glass 的 4.5% 白）：浮层压住「最近搜索」时
   半透明会让底下的 chips 文字透上来，和联想项糊成两层字。 */
.suggest {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 30;
  padding: 6px;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: var(--shadow);
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
}
.s-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.s-item:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}
</style>
