<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Song } from '@shared/types'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { usePlayerStore } from '../stores/player'
import { useAppStore } from '../stores/app'
import { formatDuration } from '@shared/lyric'

/**
 * 歌词手动匹配。
 *
 * 场景：音源给的歌词是另一版编曲 / 纯音乐版，时间轴全错。
 * 这里搜一个正确版本改绑，按歌记忆；不改变播放来源。
 */
const emit = defineEmits<{ close: [] }>()

const player = usePlayerStore()
const app = useAppStore()

const song = computed(() => player.current)
const picked = computed(() => player.lyricPickOf(player.current))

const keyword = ref('')
const results = ref<Song[]>([])
const searching = ref(false)
const applying = ref(false)

function defaultKeyword(): string {
  if (!song.value) return ''
  return [song.value.name, ...song.value.artists].filter(Boolean).join(' ')
}

async function run(): Promise<void> {
  const text = keyword.value.trim()
  if (!text || searching.value) return
  searching.value = true
  try {
    // 歌词库以网易云最全：固定用它搜候选，不跟随当前音源
    const page = await window.api.search({ platform: 'netease', keyword: text, page: 1, limit: 12 })
    results.value = page.items
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    searching.value = false
  }
}

async function apply(candidate: Song): Promise<void> {
  if (applying.value) return
  applying.value = true
  try {
    await player.applyLyricPick(candidate)
    app.toast(`歌词已改为《${candidate.name}》`, 'success')
    emit('close')
  } finally {
    applying.value = false
  }
}

async function reset(): Promise<void> {
  await player.applyLyricPick(null)
  app.toast('已恢复自动匹配歌词', 'info')
  emit('close')
}

onMounted(() => {
  keyword.value = defaultKeyword()
  void run()
})
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <header>
        <div class="head-text">
          <strong>匹配歌词</strong>
          <small class="truncate">
            {{ song ? `${song.name} · ${song.artists.join(' / ') || '未知歌手'}` : '当前没有播放中的歌曲' }}
          </small>
        </div>
        <button class="close" title="关闭" @click="emit('close')">
          <Icon name="close" :size="15" />
        </button>
      </header>

      <form class="find" @submit.prevent="run">
        <label>
          <Icon name="search" :size="14" />
          <input v-model="keyword" placeholder="搜歌名 / 歌手，选一个正确版本" spellcheck="false" />
        </label>
        <button class="btn primary" type="submit" :disabled="searching || !keyword.trim()">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
      </form>

      <p v-if="picked" class="picked">
        当前已手动指定：<strong>{{ picked.name }}</strong> · {{ picked.artists.join(' / ') }}
      </p>

      <div class="list">
        <button
          v-for="item in results"
          :key="`${item.platform}:${item.id}`"
          class="row"
          :disabled="applying"
          @click="apply(item)"
        >
          <CoverArt :src="item.coverUrl" :seed="`${item.platform}:${item.id}`" :size="34" :radius="8" />
          <span class="text">
            <strong class="truncate">{{ item.name }}</strong>
            <small class="truncate">{{ item.artists.join(' / ') || '未知歌手' }}</small>
          </span>
          <em>{{ item.album || '' }}</em>
          <span class="dur">{{ formatDuration(item.duration) }}</span>
        </button>
        <p v-if="!searching && !results.length" class="empty">没有搜到候选，换个关键词试试</p>
      </div>

      <footer>
        <button v-if="picked" class="btn" @click="reset">恢复自动匹配</button>
        <span class="tip">只影响歌词显示，不改变播放来源</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.58);
  backdrop-filter: blur(6px);
}
.dialog {
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: min(78vh, 640px);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px;
  border-radius: 18px;
  background: var(--overlay-bg);
  border: 1px solid var(--overlay-border);
  box-shadow: var(--shadow);
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.head-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.head-text strong {
  font-size: 15px;
}
.head-text small {
  font-size: 11.5px;
  color: var(--text-2);
}
.close {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-2);
}
.close:hover {
  background: var(--row-hover);
  color: var(--text);
}

.find {
  display: flex;
  gap: 8px;
}
.find label {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 11px;
  border-radius: 10px;
  border: 1px solid var(--border-strong);
  background: var(--input-bg);
  color: var(--text-3);
}
.find input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
}

.picked {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-2);
}
.picked strong {
  color: var(--accent);
  font-weight: 600;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 9px;
  text-align: left;
  transition: background 0.14s;
}
.row:hover:not(:disabled) {
  background: var(--row-hover);
}
.row:disabled {
  opacity: 0.5;
}
.text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.text strong {
  font-size: 12.5px;
  font-weight: 600;
}
.text small {
  font-size: 10.5px;
  color: var(--text-3);
}
.row em {
  flex: none;
  max-width: 120px;
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dur {
  flex: none;
  width: 38px;
  text-align: right;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.empty {
  margin: 18px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}
footer {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tip {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-3);
}
</style>
