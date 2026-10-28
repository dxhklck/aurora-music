<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useDownloadStore } from '../stores/download'

/**
 * 移动端底部标签栏（≤640px 显示，桌面版隐藏）。
 * 替代桌面侧边栏的导航职能；本地音乐暂不入栏（手机端低频），
 * 可从设置页进入。下载页带进行中角标。
 */
const route = useRoute()
const download = useDownloadStore()
const pending = computed(() => download.active.length)

const tabs = [
  { name: 'discover', to: '/', label: '发现', icon: 'home' },
  { name: 'search', to: '/search', label: '搜索', icon: 'search' },
  { name: 'charts', to: '/charts', label: '榜单', icon: 'chart' },
  { name: 'favorites', to: '/favorites', label: '收藏', icon: 'heart' },
  { name: 'downloads', to: '/downloads', label: '下载', icon: 'download' },
  { name: 'settings', to: '/settings', label: '设置', icon: 'settings' }
]

function isActive(name: string): boolean {
  if (name === 'discover') return route.path === '/'
  return route.name === name
}
</script>

<template>
  <nav class="bottomnav">
    <router-link
      v-for="tab in tabs"
      :key="tab.name"
      :to="tab.to"
      class="tab"
      :class="{ active: isActive(tab.name) }"
    >
      <span class="tab-icon">
        <Icon :name="tab.icon" :size="21" />
        <em v-if="tab.name === 'downloads' && pending" class="badge">{{ pending > 9 ? '9+' : pending }}</em>
      </span>
      <span class="tab-label">{{ tab.label }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
/* 桌面版完全不渲染占位 */
.bottomnav {
  display: none;
}

@media (max-width: 640px) {
  .bottomnav {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 4px 6px calc(5px + env(safe-area-inset-bottom, 0px));
    background: rgba(10, 10, 16, 0.94);
    border-top: 1px solid var(--border);
    backdrop-filter: blur(18px);
  }

  .tab {
    flex: 1;
    min-width: 0;
    min-height: 48px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    border-radius: 10px;
    color: var(--text-3);
    transition: color 0.18s var(--ease);
    -webkit-tap-highlight-color: transparent;
  }
  .tab.active {
    color: var(--accent);
  }

  .tab-icon {
    position: relative;
    display: grid;
    place-items: center;
    line-height: 0;
  }

  .tab-label {
    font-size: 10px;
    letter-spacing: 0.5px;
  }

  .badge {
    position: absolute;
    top: -4px;
    right: -10px;
    font-style: normal;
    font-size: 9px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    display: grid;
    place-items: center;
    font-weight: 600;
  }
}
</style>
