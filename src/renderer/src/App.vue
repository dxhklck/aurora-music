<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import PlayerBar from './components/PlayerBar.vue'
import MiniPlayer from './components/MiniPlayer.vue'
import NowPlaying from './components/NowPlaying.vue'
import QueueDrawer from './components/QueueDrawer.vue'
import ToastHost from './components/ToastHost.vue'
import PlaylistPicker from './components/PlaylistPicker.vue'
import { useAppStore } from './stores/app'
import { usePlayerStore } from './stores/player'
import { useDownloadStore } from './stores/download'
import { useLibraryStore } from './stores/library'
import { usePlaylistStore } from './stores/playlists'
import { plain } from './core/plain'
import { wave } from './core/wave'
import type { LyricWindowState } from '@shared/types'
import type { TrayState } from '@shared/api'

const app = useAppStore()
const player = usePlayerStore()
const download = useDownloadStore()
const library = useLibraryStore()
const playlists = usePlaylistStore()

let lyricTimer = 0
let offSettings: (() => void) | null = null
let offToast: (() => void) | null = null
let offTray: (() => void) | null = null
let offLyricState: (() => void) | null = null
/** 托盘状态只在变化时推送，缓存上一次的比较基准 */
let lastTrayState = ''

const shellStyle = computed(() => ({
  '--accent': app.accent[0],
  '--accent-2': app.accent[1]
}))

function pushLyricState(): void {
  const song = player.displaySong
  const state: LyricWindowState = {
    playing: player.playing,
    lines: player.lyric?.lines ?? [],
    offset: player.lyric?.offset ?? 0,
    index: player.activeLyricIndex,
    time: player.time,
    sentAt: Date.now(),
    title: song?.name ?? '',
    artist: song?.artists.join(' / ') ?? '',
    locked: app.settings?.desktopLyricLocked ?? false,
    // 强调色随 250ms 推送实时联动桌面歌词窗口（独立窗口拿不到 shellStyle；
    // 歌词窗口恒定深色，不推 themeMode）
    accent: app.accent[0],
    accent2: app.accent[1]
  }
  window.api.pushLyricState(plain(state))
}

/** 迷你播放器：主窗口收缩成置顶小浮窗，只留 MiniPlayer */
const isMini = computed(() => app.settings?.miniMode ?? false)

// 收起时把全屏覆盖层都关掉，避免展开后残留
watch(isMini, (mini) => {
  if (mini) {
    player.showNowPlaying = false
    player.showQueue = false
  }
})

// 主题两档：dark / light，随设置变更同步到 <html data-theme>
// （旧配置可能残留 'system'，兜底回深色）
const resolvedTheme = computed(() => (app.settings?.themeMode === 'light' ? 'light' : 'dark'))
watch(resolvedTheme, (theme) => {
  document.documentElement.dataset.theme = theme
})

/** 托盘只关心歌名与播放状态；250ms 定时器里顺带比较，有变化才发 IPC */
function pushTrayState(): void {
  const song = player.displaySong
  const state: TrayState = {
    title: song?.name ?? '',
    artist: song?.artists.join(' / ') ?? '',
    playing: player.playing
  }
  const key = `${state.playing}|${state.title}|${state.artist}`
  if (key === lastTrayState) return
  lastTrayState = key
  window.api.pushTrayState(state)
}

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
  if (event.code === 'Space') {
    // 焦点在按钮上时把空格留给按钮自身激活：否则点了「收起」再按空格，
    // 默认点击被 preventDefault 吃掉，按钮看起来"没有反应"。
    if (target?.tagName === 'BUTTON') return
    event.preventDefault()
    void player.toggle()
  } else if (event.code === 'KeyL' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    // L = 歌词舞台开关（输入框守卫在上面已排除，Ctrl/Alt 组合键不抢）
    event.preventDefault()
    player.showNowPlaying = !player.showNowPlaying
  } else if (event.code === 'ArrowRight' && event.shiftKey) {
    player.next()
  } else if (event.code === 'ArrowLeft' && event.shiftKey) {
    player.prev()
  } else if (event.code === 'ArrowRight') {
    player.seekTo(Math.min(player.duration, player.time + 5000))
  } else if (event.code === 'ArrowLeft') {
    player.seekTo(Math.max(0, player.time - 5000))
  } else if (event.code === 'ArrowUp') {
    event.preventDefault()
    player.setVolume(player.volume + 0.05)
  } else if (event.code === 'ArrowDown') {
    event.preventDefault()
    player.setVolume(player.volume - 0.05)
  }
}

onMounted(async () => {
  document.documentElement.dataset.platform = window.api.platform
  await app.boot()
  if (app.settings) {
    player.hydrate({ volume: app.settings.volume, playMode: app.settings.playMode })
    // 均衡器：音频图是懒创建的，这里先灌一次参数，等第一次打开播放舞台时按它初始化
    const eq = app.settings.equalizer
    if (eq) {
      wave.setEqualizer(eq.gains, eq.enabled)
      wave.setNightLimiter(eq.night === true)
    }
  }
  player.bindEngine()
  await Promise.all([download.init(), library.load(), playlists.load()])

  offSettings = window.api.onSettingsChanged((next) => app.applySettings(next))
  offToast = window.api.onToast((payload) => app.toast(payload.message, payload.type))
  offTray = window.api.onTrayCommand((command) => {
    if (command === 'toggle') void player.toggle()
    else if (command === 'next') player.next()
    else if (command === 'prev') player.prev()
  })
  // 歌词窗口的开关由主进程掌控（设置页、托盘、快捷键都能触发），只认它推来的标记
  offLyricState = window.api.onLyricWindowState((state) => {
    const flag = state as { open?: boolean; closed?: boolean } | null
    if (flag?.open) app.lyricOpen = true
    else if (flag?.closed) app.lyricOpen = false
  })
  window.addEventListener('keydown', onKey)
  lyricTimer = window.setInterval(() => {
    // 窗口没开时不必序列化整份歌词再跨进程送一次
    if (app.lyricOpen) pushLyricState()
    pushTrayState()
  }, 250)
})

onBeforeUnmount(() => {
  window.clearInterval(lyricTimer)
  window.removeEventListener('keydown', onKey)
  offSettings?.()
  offToast?.()
  offTray?.()
  offLyricState?.()
})
</script>

<template>
  <div class="shell" :style="shellStyle" :class="{ 'stage-open': player.showNowPlaying, mini: isMini }">
    <template v-if="!isMini">
      <TitleBar />
      <SideBar />
      <main class="page">
        <router-view v-slot="{ Component }">
          <transition name="route" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
      <PlayerBar />
    </template>
    <MiniPlayer v-else />

    <transition name="stage">
      <NowPlaying v-if="player.showNowPlaying" />
    </transition>

    <QueueDrawer />
    <PlaylistPicker />

    <transition name="fade">
      <div v-if="player.notice" class="source-notice">
        <span class="pulse" />
        {{ player.notice }}
      </div>
    </transition>

    <transition name="fade">
      <div v-if="player.error" class="play-error" @click="player.error = ''">
        <strong>播放失败</strong>
        <span>{{ player.error }}</span>
        <em>点击关闭</em>
      </div>
    </transition>

    <ToastHost />
  </div>
</template>

<style scoped>
.titlebar {
  grid-area: 1 / 1 / 2 / 3;
}
.sidebar {
  grid-area: 2 / 1 / 3 / 2;
}
.page {
  grid-area: 2 / 2 / 3 / 3;
}
.playerbar {
  grid-area: 3 / 1 / 4 / 3;
}

/* 窄窗口：标题栏/侧栏退场，内容 + 播放条单列两行 */
@media (max-width: 640px) {
  .titlebar,
  .sidebar {
    display: none;
  }
  .page {
    grid-area: 1 / 1 / 2 / 2;
  }
  .playerbar {
    grid-area: 2 / 1 / 3 / 2;
  }
}

.source-notice {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  bottom: calc(var(--player) + 16px);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 999px;
  font-size: 11.5px;
  color: var(--text-2);
  background: var(--toast-bg);
  border: 1px solid var(--border-strong);
  backdrop-filter: blur(14px);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}

.pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ffd479;
  box-shadow: 0 0 10px #ffd479;
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.play-error {
  position: fixed;
  right: 24px;
  top: 60px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-radius: 12px;
  background: rgba(60, 16, 26, 0.92);
  border: 1px solid rgba(255, 92, 124, 0.35);
  font-size: 12px;
  color: #ffd0d8;
  cursor: pointer;
  max-width: 70vw;
}
.play-error strong {
  font-size: 12px;
}
.play-error em {
  font-style: normal;
  font-size: 10.5px;
  color: rgba(255, 208, 216, 0.55);
}

.stage-enter-active,
.stage-leave-active {
  transition: opacity 0.32s var(--ease), transform 0.32s var(--ease);
}
.stage-enter-from,
.stage-leave-to {
  opacity: 0;
  transform: translateY(18px) scale(1.01);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s var(--ease);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
