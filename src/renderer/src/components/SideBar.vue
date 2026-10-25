<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useAppStore } from '../stores/app'
import { usePlayerStore } from '../stores/player'
import { useDownloadStore } from '../stores/download'
import { usePlaylistStore } from '../stores/playlists'

const app = useAppStore()
const player = usePlayerStore()
const download = useDownloadStore()
const playlists = usePlaylistStore()
const route = useRoute()
const router = useRouter()
const open = ref(false)
const panel = ref<HTMLElement | null>(null)

const navs = [
  { name: 'discover', to: '/', label: '发现音乐', icon: 'home' },
  { name: 'search', to: '/search', label: '搜索', icon: 'search' },
  { name: 'charts', to: '/charts', label: '排行榜', icon: 'chart' },
  { name: 'favorites', to: '/favorites', label: '我的收藏', icon: 'heart' },
  { name: 'library', to: '/library', label: '本地音乐', icon: 'folder' },
  { name: 'downloads', to: '/downloads', label: '下载管理', icon: 'download' },
  { name: 'settings', to: '/settings', label: '设置', icon: 'settings' }
]

const activeName = computed(() => route.name as string)
const platform = computed(() => app.currentProvider)
const pending = computed(() => download.active.length)

/** 原生适配器与引擎音源分组展示：引擎有十几个源，混在一起会很难找 */
const nativeProviders = computed(() => app.providers.filter((item) => !item.id.startsWith('mdl-')))
const engineProviders = computed(() => app.providers.filter((item) => item.id.startsWith('mdl-')))

function select(id: string): void {
  open.value = false
  void app.setPlatform(id)
}

async function createPlaylist(): Promise<void> {
  // 默认名与按钮文案区分开，避免侧栏出现两个「新建歌单」；建好后可直接用铅笔重命名
  const created = await playlists.create('未命名歌单')
  if (created) void router.push(`/playlist/${created.id}`)
}

function onDocClick(event: MouseEvent): void {
  if (!open.value) return
  if (panel.value && !panel.value.contains(event.target as Node)) open.value = false
}

onMounted(() => document.addEventListener('mousedown', onDocClick))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocClick))
</script>

<template>
  <aside class="sidebar">
    <nav class="nav">
      <router-link
        v-for="item in navs"
        :key="item.name"
        :to="item.to"
        class="nav-item"
        :class="{ active: activeName === item.name }"
      >
        <Icon :name="item.icon" :size="18" />
        <span>{{ item.label }}</span>
        <em v-if="item.name === 'downloads' && pending" class="badge">{{ pending }}</em>
      </router-link>
    </nav>

    <div class="divider" />

    <div class="block">
      <p class="block-title">播放列表</p>
      <button class="nav-item as-button" @click="player.showQueue = !player.showQueue">
        <Icon name="list" :size="18" />
        <span>当前队列</span>
        <em class="count">{{ player.queue.length }}</em>
      </button>
      <button class="nav-item as-button" @click="player.showNowPlaying = true">
        <Icon name="lyrics" :size="18" />
        <span>歌词舞台</span>
      </button>
    </div>

    <div class="block">
      <p class="block-title">我的歌单</p>
      <div class="playlist-list">
        <router-link
          v-for="item in playlists.custom"
          :key="item.id"
          :to="`/playlist/${item.id}`"
          class="nav-item as-button"
          :class="{ active: route.path === `/playlist/${item.id}` }"
        >
          <Icon name="list" :size="16" />
          <span class="truncate">{{ item.name }}</span>
          <em class="count">{{ item.songs.length }}</em>
        </router-link>
        <button class="nav-item as-button" @click="createPlaylist">
          <Icon name="plus" :size="16" />
          <span>新建歌单</span>
        </button>
      </div>
    </div>

    <div class="flex-1" />

    <div ref="panel" class="platform-wrap">
      <p class="block-title">音源</p>
      <button class="platform-card" :class="{ open }" @click="open = !open">
        <span class="dot" :style="{ background: platform?.color }" />
        <div class="platform-info">
          <strong>{{ platform?.name ?? '加载中' }}</strong>
          <small>{{ platform?.description ?? '' }}</small>
        </div>
        <span class="chevron">⌃</span>
      </button>

      <transition name="pop">
        <div v-if="open" class="platform-menu glass">
          <p class="menu-group">内置与原生</p>
          <button
            v-for="item in nativeProviders"
            :key="item.id"
            class="platform-option"
            :class="{ selected: item.id === app.platform }"
            @click="select(item.id)"
          >
            <span class="dot" :style="{ background: item.color }" />
            <div class="option-text">
              <strong>{{ item.name }}</strong>
              <small>{{ item.description }}</small>
            </div>
            <Icon v-if="item.id === app.platform" name="check" :size="15" />
          </button>

          <template v-if="engineProviders.length">
            <p class="menu-group">musicdl 引擎</p>
            <button
              v-for="item in engineProviders"
              :key="item.id"
              class="platform-option"
              :class="{ selected: item.id === app.platform }"
              @click="select(item.id)"
            >
              <span class="dot" :style="{ background: item.color }" />
              <div class="option-text">
                <strong>{{ item.name }}</strong>
                <small>{{ item.description }}</small>
              </div>
              <Icon v-if="item.id === app.platform" name="check" :size="15" />
            </button>
          </template>

          <p class="menu-hint">新增平台只需实现 MusicProvider 接口并在主进程注册</p>
        </div>
      </transition>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  /* 窗口压到最小高度时侧栏内容会超出，允许滚动而不是被裁掉 */
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.sidebar::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 11px;
  height: 40px;
  padding: 0 12px;
  border-radius: 11px;
  color: var(--text-2);
  font-size: 13.5px;
  position: relative;
  transition: all 0.18s var(--ease);
  width: 100%;
  text-align: left;
}

.nav-item:hover {
  background: rgba(255, 255, 255, 0.055);
  color: var(--text);
}

.nav-item.active {
  color: var(--text);
  background: linear-gradient(
    100deg,
    color-mix(in srgb, var(--accent) 26%, transparent),
    rgba(255, 255, 255, 0.02)
  );
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 26%, transparent);
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.nav-item span {
  flex: 1;
}

.badge {
  font-style: normal;
  font-size: 10px;
  min-width: 16px;
  height: 16px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  display: grid;
  place-items: center;
  padding: 0 4px;
}

.count {
  font-style: normal;
  font-size: 11px;
  color: var(--text-3);
}

.as-button {
  border: none;
  background: transparent;
}

.playlist-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: min(104px, 13vh);
  overflow-y: auto;
}
.playlist-list .nav-item {
  height: 32px;
  font-size: 12.5px;
  color: var(--text-2);
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 2px 8px;
}

.block-title {
  margin: 0 0 6px;
  font-size: 10.5px;
  letter-spacing: 1.6px;
  text-transform: uppercase;
  color: var(--text-3);
  padding-left: 12px;
}

.flex-1 {
  flex: 1;
}

.platform-wrap {
  position: relative;
}

.platform-card {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.2s var(--ease);
}
.platform-card:hover,
.platform-card.open {
  background: rgba(255, 255, 255, 0.09);
  border-color: var(--border-strong);
}

.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 12px currentColor;
}

.platform-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.platform-info strong {
  font-size: 12.5px;
  font-weight: 600;
}
.platform-info small {
  font-size: 10.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chevron {
  color: var(--text-3);
  font-size: 12px;
  transform: rotate(180deg);
  transition: transform 0.2s;
}
.platform-card.open .chevron {
  transform: rotate(0deg);
}

.platform-menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  border-radius: 14px;
  padding: 6px;
  box-shadow: var(--shadow);
  z-index: 60;
  max-height: 340px;
  overflow-y: auto;
}

.platform-option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  text-align: left;
  transition: background 0.15s;
}
.platform-option:hover {
  background: rgba(255, 255, 255, 0.08);
}
.platform-option.selected {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
}

.option-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.option-text strong {
  font-size: 12.5px;
}
.option-text small {
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menu-hint {
  margin: 6px 8px 4px;
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.5;
}

.menu-group {
  margin: 8px 8px 4px;
  font-size: 10px;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--text-3);
}
.menu-group:first-child {
  margin-top: 2px;
}

.pop-enter-active,
.pop-leave-active {
  transition: all 0.18s var(--ease);
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(6px) scale(0.98);
}

/* 窗口压到最小高度时收紧行高，保证音源切换器始终可见 */
@media (max-height: 760px) {
  .sidebar {
    gap: 8px;
  }
  .nav-item {
    height: 34px;
  }
  .playlist-list {
    max-height: 56px;
  }
  .playlist-list .nav-item {
    height: 30px;
  }
}
</style>
