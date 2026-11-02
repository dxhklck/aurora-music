<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import { usePlayerStore } from '../stores/player'
import { formatDuration } from '@shared/lyric'

const player = usePlayerStore()

/**
 * 用 uid 判断「正在播的那行」，不用 platform:id——
 * 同一首歌可以在队列里出现多次（反复点「下一首播放」），按 id 判断会让两行同时亮起。
 */
const currentUid = computed(() => player.current?.uid ?? '')

/* ---------------- 拖拽重排 ----------------
   列表项的 key 是 uid（不是 index），所以重排只移动 DOM 而不是重建：
   封面不重新请求、正在播那行的 .eq 动画不会重头开始。 */
const dragFrom = ref<number | null>(null)
const dragOver = ref<number | null>(null)

function onDragStart(index: number, event: DragEvent): void {
  dragFrom.value = index
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  // 某些内核不设数据就不肯开始拖拽
  event.dataTransfer.setData('text/plain', String(index))
}

function onDragOver(index: number): void {
  if (dragFrom.value === null || dragFrom.value === index) return
  dragOver.value = index
}

function onDrop(index: number): void {
  if (dragFrom.value !== null) player.moveQueueItem(dragFrom.value, index)
  onDragEnd()
}

function onDragEnd(): void {
  dragFrom.value = null
  dragOver.value = null
}

/* ---------------- 存为歌单 ---------------- */
const saving = ref(false)
const saveName = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

function startSave(): void {
  if (!player.queue.length) return
  saving.value = true
  saveName.value = ''
  void nextTick(() => nameInput.value?.focus())
}

async function confirmSave(): Promise<void> {
  if (await player.saveQueueAsPlaylist(saveName.value)) saving.value = false
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
          <button class="icon-btn" title="存为歌单" @click="startSave">
            <Icon name="plus" :size="16" />
          </button>
          <button class="icon-btn" title="清空" @click="player.clearQueue()">
            <Icon name="trash" :size="16" />
          </button>
          <button class="icon-btn" title="关闭" @click="player.showQueue = false">
            <Icon name="close" :size="16" />
          </button>
        </div>
      </header>

      <div v-if="saving" class="save-row">
        <input
          ref="nameInput"
          v-model="saveName"
          placeholder="歌单名称"
          maxlength="40"
          @keydown.enter="confirmSave"
          @keydown.esc="saving = false"
        />
        <button class="save-btn" @click="confirmSave">保存</button>
        <button class="save-btn ghost" @click="saving = false">取消</button>
      </div>

      <div class="list">
        <div
          v-for="(song, index) in player.queue"
          :key="song.uid"
          class="item"
          :class="{
            playing: song.uid === currentUid,
            dragging: dragFrom === index,
            'drop-target': dragOver === index && dragFrom !== index
          }"
          draggable="true"
          @dragstart="onDragStart(index, $event)"
          @dragover.prevent="onDragOver(index)"
          @drop.prevent="onDrop(index)"
          @dragend="onDragEnd"
          @dblclick="player.playAt(index)"
        >
          <button class="idx" @click="player.playAt(index)">
            <span v-if="song.uid === currentUid && player.playing" class="eq">
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
  /* 手机窄屏（≤640px）不能超出视口，留出左右 12px 呼吸 */
  max-width: calc(100vw - 24px);
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
  background: color-mix(in srgb, var(--text) 8%, transparent);
}
.item.playing .text strong {
  /* 混 text 而不是纯白：浅色主题下才不会糊成一片浅色 */
  color: color-mix(in srgb, var(--accent) 72%, var(--text));
}

/* 拖拽重排：拖动项淡出，落点在顶部画一条高亮线（比整块描边更接近「插到这里」） */
.item[draggable='true'] {
  cursor: grab;
}
.item.dragging {
  opacity: 0.35;
}
.item.drop-target {
  box-shadow: inset 0 2px 0 var(--accent);
}

/* 存为歌单的内联输入行 */
.save-row {
  display: flex;
  gap: 6px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--border);
}
.save-row input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--input-bg);
  color: var(--text);
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.save-row input:focus {
  border-color: var(--accent);
}
.save-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 12px;
  background: var(--accent);
  color: #fff;
  white-space: nowrap;
}
.save-btn.ghost {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-2);
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
