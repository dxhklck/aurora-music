<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useSearchStore } from '../stores/search'
import { useAppStore } from '../stores/app'
import type { ThemeMode } from '@shared/types'

const router = useRouter()
const search = useSearchStore()
const app = useAppStore()
const query = ref('')
const maximized = ref(false)

/** 主题两档循环切换：深色 → 浅色 */
const THEME_ORDER: ThemeMode[] = ['dark', 'light']
const THEME_META: Record<ThemeMode, { label: string; icon: string }> = {
  dark: { label: '深色主题', icon: 'moon' },
  light: { label: '浅色主题', icon: 'sun' }
}
const themeMode = computed<ThemeMode>(() => app.settings?.themeMode ?? 'dark')

function cycleTheme(): void {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(themeMode.value) + 1) % THEME_ORDER.length]
  void app.patchSettings({ themeMode: next })
}

onMounted(async () => {
  maximized.value = await window.api.isMaximized()
})

function submit(): void {
  const keyword = query.value.trim()
  if (!keyword) return
  void router.push({ name: 'search' })
  void search.run(keyword)
}

const isMac = window.api.platform === 'darwin'

/** macOS 由系统处理标题栏双击缩放，避免和自绘逻辑叠加 */
function onTitleDblClick(): void {
  if (isMac) return
  toggleMaximize()
}

function toggleMaximize(): void {
  window.api.winMaximize()
  maximized.value = !maximized.value
}

function minimize(): void {
  window.api.winMinimize()
}

function closeWindow(): void {
  window.api.winClose()
}

async function toggleDesktopLyric(): Promise<void> {
  // 静默开关：不弹任何提示（歌词窗口自身的开启/关闭就是反馈）
  await window.api.toggleLyricWindow()
}
</script>

<template>
  <header class="titlebar" @dblclick="onTitleDblClick">
    <div class="brand">
      <div class="mark">
        <span></span><span></span><span></span><span></span>
      </div>
      <div class="brand-text">
        <strong>Aurora</strong>
        <em>MUSIC</em>
      </div>
    </div>

    <div class="search no-drag">
      <Icon name="search" :size="15" />
      <input
        v-model="query"
        type="text"
        placeholder="搜索歌曲 / 歌手 / 专辑"
        spellcheck="false"
        @keydown.enter="submit"
      />
      <kbd>↵</kbd>
    </div>

    <div class="spacer" />

    <button
      class="icon-btn no-drag"
      :title="`主题：${THEME_META[themeMode].label}（点击切换）`"
      @click="cycleTheme"
    >
      <Icon :name="THEME_META[themeMode].icon" :size="17" />
    </button>

    <button class="icon-btn no-drag" title="桌面歌词" @click="toggleDesktopLyric">
      <Icon name="monitor" :size="18" />
    </button>

    <button class="icon-btn no-drag" title="迷你播放器" @click="app.patchSettings({ miniMode: true })">
      <Icon name="expand" :size="17" />
    </button>

    <div class="win-controls no-drag">
      <button class="win-btn" title="最小化" @click="minimize">
        <Icon name="minimize" :size="14" />
      </button>
      <button class="win-btn" title="最大化" @click="toggleMaximize">
        <Icon :name="maximized ? 'restore' : 'maximize'" :size="13" />
      </button>
      <button class="win-btn close" title="关闭" @click="closeWindow">
        <Icon name="close" :size="14" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 4px;
  width: calc(var(--sidebar) - 26px);
}

.mark {
  width: 26px;
  height: 26px;
  border-radius: 9px;
  background: linear-gradient(140deg, var(--accent), var(--accent-2));
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;
  padding-bottom: 6px;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent) 45%, transparent);
}

.mark span {
  width: 2.5px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.92);
  animation: bar 1.4s ease-in-out infinite;
}
.mark span:nth-child(1) {
  height: 6px;
  animation-delay: 0s;
}
.mark span:nth-child(2) {
  height: 11px;
  animation-delay: 0.18s;
}
.mark span:nth-child(3) {
  height: 8px;
  animation-delay: 0.36s;
}
.mark span:nth-child(4) {
  height: 12px;
  animation-delay: 0.54s;
}

@keyframes bar {
  0%,
  100% {
    transform: scaleY(0.55);
  }
  50% {
    transform: scaleY(1);
  }
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1;
}
.brand-text strong {
  font-size: 15px;
  letter-spacing: 0.4px;
}
.brand-text em {
  font-style: normal;
  font-size: 8px;
  letter-spacing: 3px;
  color: var(--text-3);
  margin-top: 3px;
}

.search {
  width: min(420px, 38vw);
  height: 32px;
  border-radius: 999px;
  background: var(--input-bg);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  color: var(--text-3);
  transition: all 0.2s var(--ease);
}
.search:focus-within {
  background: var(--panel-strong);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text-2);
}
.search input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 12.5px;
  color: var(--text);
}
.search input::placeholder {
  color: var(--text-3);
}
.search kbd {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-3);
}

.spacer {
  flex: 1;
}

.win-controls {
  display: flex;
  gap: 2px;
  margin-left: 6px;
}

.win-btn {
  width: 34px;
  height: 28px;
  border-radius: 7px;
  color: var(--text-2);
  display: grid;
  place-items: center;
  transition: all 0.15s;
}
.win-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}
.win-btn.close:hover {
  background: #e5484d;
  color: #fff;
}
</style>
