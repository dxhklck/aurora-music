<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { usePlayerStore } from '../stores/player'
import { formatDuration } from '@shared/lyric'
import type { AlternativeTrack } from '@shared/types'

const player = usePlayerStore()

/** 分数 <70 的默认折叠：它们多半是翻唱、现场版或名字沾边的另一首 */
const showMore = ref(false)
/** 正在试的候选 key，用来锁住列表并显示加载态 */
const trying = ref('')
/** 试过但播不起来的候选，标红留着，用户可以接着试下一个 */
const failed = ref<string[]>([])

function keyOf(item: AlternativeTrack): string {
  return `${item.song.platform}:${item.song.id}`
}

const strong = computed(() => player.alternatives.filter((item) => item.score >= 70))
const weak = computed(() => player.alternatives.filter((item) => item.score < 70))
const visible = computed(() => (showMore.value ? [...strong.value, ...weak.value] : strong.value))

async function pick(item: AlternativeTrack): Promise<void> {
  if (trying.value) return
  const key = keyOf(item)
  trying.value = key
  player.error = ''
  // 播不起来时 store 会把队列回退成原来那首并弹提示，这里只负责把这一行标红
  const ok = await player.switchToAlternative(item.song)
  trying.value = ''
  if (!ok) {
    failed.value = [...failed.value, key]
    return
  }
  close()
}

function close(): void {
  player.closeAlternatives()
  showMore.value = false
  failed.value = []
}
</script>

<template>
  <transition name="fade">
    <div v-if="player.alternativesOpen" class="alt-mask" @click.self="close">
      <section class="alt-panel">
        <header class="alt-head">
          <div class="alt-title">
            <strong>换一个版本</strong>
            <small class="truncate">{{ player.current?.name ?? '当前歌曲' }}</small>
          </div>
          <button class="icon-btn" title="关闭" @click="close">
            <Icon name="close" :size="15" />
          </button>
        </header>

        <p class="alt-hint">
          按歌名、歌手和时长匹配，<b>只保证很像，不保证能播</b>——点了才知道，播不了会留在列表里标红。
        </p>

        <div v-if="player.alternativesLoading" class="alt-state">
          <span class="spinner" />
          正在其它音源里找…
        </div>

        <div v-else-if="!player.alternatives.length" class="alt-state">
          没找到其它版本。可以回搜索页手动搜一下歌名。
        </div>

        <div v-else class="alt-list">
          <button
            v-for="item in visible"
            :key="keyOf(item)"
            class="alt-row"
            :class="{ failed: failed.includes(keyOf(item)), busy: trying === keyOf(item) }"
            :disabled="!!trying"
            @click="pick(item)"
          >
            <CoverArt
              :src="item.song.coverUrl"
              :seed="keyOf(item)"
              :size="38"
              :radius="9"
              :song="item.song"
            />
            <div class="alt-text">
              <strong class="truncate">{{ item.song.name }}</strong>
              <small class="truncate">
                {{ item.song.artists.join(' / ') || '未知歌手' }} · {{ item.platformName }}
              </small>
            </div>
            <span class="alt-tag" :class="{ ok: item.score >= 70 }">
              {{ item.score >= 70 ? '同名同歌手' : '可能是另一首' }}
            </span>
            <span class="alt-dur">{{ formatDuration(item.song.duration) }}</span>
            <span v-if="trying === keyOf(item)" class="spinner" />
            <span v-else-if="failed.includes(keyOf(item))" class="alt-fail">播不了</span>
          </button>

          <button v-if="!showMore && weak.length" class="alt-more" @click="showMore = true">
            再看 {{ weak.length }} 个不太确定的
          </button>
        </div>
      </section>
    </div>
  </transition>
</template>

<style scoped>
.alt-mask {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(2px);
}

.alt-panel {
  width: min(540px, 100%);
  max-height: min(72vh, 620px);
  display: flex;
  flex-direction: column;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  box-shadow: var(--shadow);
  overflow: hidden;
}

.alt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 14px 12px 18px;
  border-bottom: 1px solid var(--border);
}
.alt-title {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.alt-title strong {
  font-size: 14px;
}
.alt-title small {
  font-size: 11px;
  color: var(--text-3);
}

.alt-hint {
  margin: 0;
  padding: 10px 18px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
}
.alt-hint b {
  color: var(--text-2);
  font-weight: 500;
}

.alt-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 34px 18px;
  font-size: 12px;
  color: var(--text-3);
}

.alt-list {
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.alt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 12px;
  text-align: left;
  transition: background 0.16s;
}
.alt-row:hover:not(:disabled) {
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.alt-row:disabled {
  cursor: default;
}
.alt-row.busy {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.alt-row.failed {
  opacity: 0.55;
}

.alt-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.alt-text strong {
  font-size: 12.5px;
  font-weight: 500;
}
.alt-text small {
  font-size: 10.5px;
  color: var(--text-3);
}

.alt-tag {
  flex-shrink: 0;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--border);
}
.alt-tag.ok {
  color: color-mix(in srgb, var(--accent) 72%, var(--text));
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.alt-dur {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.alt-fail {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--danger);
}

.alt-more {
  margin-top: 4px;
  padding: 9px;
  border-radius: 12px;
  font-size: 11.5px;
  color: var(--text-3);
}
.alt-more:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
  color: var(--text-2);
}

.spinner {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--text) 20%, transparent);
  border-top-color: var(--accent);
  animation: alt-spin 0.8s linear infinite;
}
@keyframes alt-spin {
  to {
    transform: rotate(360deg);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
