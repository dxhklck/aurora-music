<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { usePlayerStore } from '../stores/player'
import { formatDuration } from '@shared/lyric'

const player = usePlayerStore()

const currentKey = computed(() =>
  player.current ? `${player.current.platform}:${player.current.id}` : ''
)

function keyOf(index: number): string {
  const song = player.queue[index]
  return song ? `${song.platform}:${song.id}` : ''
}
</script>

<template>
  <transition name="slide">
    <aside v-if="player.showQueue" class="drawer glass">
      <header class="head">
        <div>
          <strong>播放队列</strong>
          <small>{{ player.queue.length }} 首</small>
        </div>
        <div class="row" style="gap: 4px">
          <button class="icon-btn" title="清空" @click="player.clearQueue()">
            <Icon name="trash" :size="16" />
          </button>
          <button class="icon-btn" title="关闭" @click="player.showQueue = false">
            <Icon name="close" :size="16" />
          </button>
        </div>
      </header>

      <div class="list">
        <div
          v-for="(song, index) in player.queue"
          :key="song.platform + song.id + index"
          class="item"
          :class="{ playing: keyOf(index) === currentKey }"
          @dblclick="player.playAt(index)"
        >
          <button class="idx" @click="player.playAt(index)">
            <span v-if="keyOf(index) === currentKey && player.playing" class="eq">
              <i /><i /><i />
            </span>
            <Icon v-else name="play" :size="12" />
          </button>
          <CoverArt
            :src="song.coverUrl"
            :seed="`${song.platform}:${song.id}`"
            :size="36"
            :radius="8"
            :song="song"
          />
          <div class="text">
            <strong class="truncate">{{ song.name }}</strong>
            <small class="truncate">{{ song.artists.join(' / ') }}</small>
          </div>
          <span class="dur">{{ formatDuration(song.duration) }}</span>
          <button class="remove" @click.stop="player.removeAt(index)">
            <Icon name="close" :size="13" />
          </button>
        </div>

        <div v-if="!player.queue.length" class="empty">
          <strong>队列是空的</strong>
          <span>在歌曲上点「下一首播放」或双击任意列表</span>
        </div>
      </div>
    </aside>
  </transition>
</template>

<style scoped>
.drawer {
  position: fixed;
  right: 16px;
  bottom: calc(var(--player) + 6px);
  width: 380px;
  max-height: min(62vh, 560px);
  border-radius: 20px;
  z-index: 70;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
  /* 跟随深浅主题：--bg-elev 在浅色下是白色系，深色下是深色面板 */
  background: var(--bg-elev);
  backdrop-filter: blur(26px) saturate(1.4);
  -webkit-backdrop-filter: blur(26px) saturate(1.4);
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 14px 10px 18px;
  border-bottom: 1px solid var(--border);
}
.head strong {
  font-size: 14px;
}
.head small {
  margin-left: 8px;
  font-size: 11px;
  color: var(--text-3);
}

.list {
  overflow-y: auto;
  padding: 8px;
  flex: 1;
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 12px;
  transition: background 0.16s;
}
.item:hover {
  background: var(--panel);
}
.item.playing .text strong {
  /* 混 text 而不是纯白：浅色主题下才不会糊成一片浅色 */
  color: color-mix(in srgb, var(--accent) 72%, var(--text));
}

.idx {
  width: 22px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.eq {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.eq i {
  width: 2px;
  background: var(--accent);
  border-radius: 2px;
  animation: bounce 0.9s ease-in-out infinite;
}
.eq i:nth-child(1) {
  height: 5px;
  animation-delay: 0s;
}
.eq i:nth-child(2) {
  height: 11px;
  animation-delay: 0.18s;
}
.eq i:nth-child(3) {
  height: 7px;
  animation-delay: 0.36s;
}
@keyframes bounce {
  0%,
  100% {
    transform: scaleY(0.5);
  }
  50% {
    transform: scaleY(1);
  }
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
  font-weight: 500;
}
.text small {
  font-size: 10.5px;
  color: var(--text-3);
}

.dur {
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.remove {
  opacity: 0;
  color: var(--text-3);
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: grid;
  place-items: center;
}
.item:hover .remove {
  opacity: 1;
}
.remove:hover {
  background: var(--panel-strong);
  color: var(--text);
}

.slide-enter-active,
.slide-leave-active {
  transition: all 0.26s var(--ease);
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateX(24px) translateY(8px);
}
</style>
