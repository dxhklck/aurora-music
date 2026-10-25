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

const song = computed(() => playlists.pickerSong)

async function addTo(id: string): Promise<void> {
  if (!song.value || busy.value) return
  busy.value = true
  try {
    await playlists.addSongs(id, [song.value])
    playlists.closePicker()
  } finally {
    busy.value = false
  }
}

async function createAndAdd(): Promise<void> {
  const value = name.value.trim()
  if (!value || !song.value || busy.value) return
  busy.value = true
  try {
    const created = await playlists.create(value, [song.value])
    if (created) app.toast(`已新建《${created.name}》并加入`, 'success')
    name.value = ''
    playlists.closePicker()
  } finally {
    busy.value = false
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && song.value) playlists.closePicker()
}

watch(song, async (value) => {
  if (!value) return
  await nextTick()
  input.value?.focus()
})

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="song" class="backdrop" @click.self="playlists.closePicker()">
        <div class="picker glass">
          <header>
            <div class="head-text">
              <strong>加入歌单</strong>
              <small class="truncate">{{ song.name }} · {{ song.artists.join(' / ') || '未知歌手' }}</small>
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
  inset: 0;
  z-index: 130;
  display: grid;
  place-items: center;
  background: rgba(4, 4, 8, 0.6);
  backdrop-filter: blur(6px);
}

.picker {
  width: 380px;
  max-width: calc(100vw - 48px);
  border-radius: 18px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  box-shadow: var(--shadow);
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
  color: var(--text-3);
}

.close {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.close:hover {
  background: rgba(255, 255, 255, 0.1);
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
  background: rgba(255, 255, 255, 0.08);
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
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.create {
  display: flex;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.create input {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--border);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
}
.create input:focus {
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  background: rgba(255, 255, 255, 0.09);
}
</style>
