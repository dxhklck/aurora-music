<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { usePlaylistStore } from '../stores/playlists'
import { useAppStore } from '../stores/app'

const playlists = usePlaylistStore()
const app = useAppStore()
const name = ref('')
const input = ref<HTMLInputElement | null>(null)
const busy = ref(false)

const songs = computed(() => playlists.pickerSongs)
/** 只有一首时才在标题下显示歌名带动词，多首显示数量 */
const single = computed(() => (songs.value.length === 1 ? songs.value[0] : null))

async function addTo(id: string): Promise<void> {
  if (!songs.value.length || busy.value) return
  busy.value = true
  try {
    await playlists.addSongs(id, songs.value)
    playlists.closePicker()
  } finally {
    busy.value = false
  }
}

async function createAndAdd(): Promise<void> {
  const value = name.value.trim()
  if (!value || !songs.value.length || busy.value) return
  busy.value = true
  try {
    const count = songs.value.length
    const created = await playlists.create(value, songs.value)
    if (created) {
      app.toast(
        count > 1 ? `已新建《${created.name}》并加入 ${count} 首` : `已新建《${created.name}》并加入`,
        'success'
      )
    }
    name.value = ''
    playlists.closePicker()
  } finally {
    busy.value = false
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && songs.value.length) playlists.closePicker()
}

/* 每次打开都换成一个新数组，按引用监听才能覆盖「上一次也是单曲」的情况 */
watch(songs, async (list) => {
  name.value = ''
  if (!list.length) return
  await nextTick()
  input.value?.focus()
})

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="songs.length" class="backdrop" @click.self="playlists.closePicker()">
        <div class="picker glass">
          <header>
            <div class="head-text">
              <strong>{{ songs.length > 1 ? `加入歌单（${songs.length} 首）` : '加入歌单' }}</strong>
              <small class="truncate">
                {{ single ? `${single.name} · ${single.artists.join(' / ') || '未知歌手'}` : '选择已有歌单追加，或在下方新建一个' }}
              </small>
            </div>
            <button class="close" title="关闭" @click="playlists.closePicker()">
              <Icon name="close" :size="15" />
            </button>
          </header>

          <div class="list">
            <button
              v-for="item in playlists.items"
              :key="item.id"
              class="option"
              :disabled="busy"
              @click="addTo(item.id)"
            >
              <Icon :name="item.builtin ? 'heart-filled' : 'list'" :size="15" />
              <span class="truncate">{{ item.name }}</span>
              <em>{{ item.songs.length }}</em>
            </button>
          </div>

          <div class="create">
            <input
              ref="input"
              v-model="name"
              maxlength="40"
              placeholder="新建歌单名称"
              @keydown.enter.stop="createAndAdd"
            />
            <button class="btn primary" :disabled="!name.trim() || busy" @click="createAndAdd">
              新建并加入
            </button>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: rgba(4, 4, 8, 0.6);
  backdrop-filter: blur(6px);
}

.picker {
  width: 380px;
  max-width: calc(100vw - 24px);
  max-width: calc(100vw - 48px);
  border-radius: 18px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-shadow: var(--shadow);
  /* .glass 只有 4.5% 白（浅色主题是 5% 黑），叠在 60% 黑的遮罩上等于没有面板：
     深色主题下糊成一片灰，浅色主题下更是深字压深底。这里改成近实心底。 */
  background: var(--overlay-bg);
  border: 1px solid var(--overlay-border);
}

header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.head-text strong {
  font-size: 15px;
  font-weight: 650;
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

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow-y: auto;
}
.option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  color: var(--text-2);
  text-align: left;
  transition: background 0.15s;
}
.option:hover:not(:disabled) {
  background: var(--row-hover);
  color: var(--text);
}
.option:disabled {
  opacity: 0.5;
}
.option span {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.option em {
  font-style: normal;
  font-size: 11px;
  color: var(--text-2);
  opacity: 0.8;
  font-variant-numeric: tabular-nums;
}

.create {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--overlay-border);
}
.create input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  /* 输入框必须有可见的框：直接用 --panel 在实心面板上看不出边界 */
  background: var(--input-bg);
  border: 1px solid var(--border-strong);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.create input::placeholder {
  color: var(--text-2);
  opacity: 0.7;
}
.create input:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: var(--input-bg);
}
</style>
