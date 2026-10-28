import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import DesktopLyric from './views/DesktopLyric.vue'
import { router } from './router'
import './styles/main.css'

const isLyricWindow = window.location.hash.startsWith('#/desktop-lyric')

async function bootstrap(): Promise<void> {
  // 桌面版由 preload 注入 window.api；Capacitor WebView 里没有 preload。
  // 桥（连同音源适配器）动态加载：桌面 bundle 不包含这些模块，
  // 也就不会把 Node 生态依赖（Buffer / node:crypto）带进渲染层。
  if (!window.api) {
    const { installMobileBridgeIfNeeded } = await import('./bridge/mobile')
    await installMobileBridgeIfNeeded()
  }
  if (isLyricWindow) {
    document.documentElement.classList.add('lyric-window')
    // 挂载前先取一次设置：桌面歌词是独立窗口，若等组件 mounted 再上主题，
    // 浅色用户会看到一瞬间的深色闪屏
    try {
      const settings = await window.api.getSettings()
      document.documentElement.dataset.theme =
        settings?.themeMode === 'light' ? 'light' : 'dark'
    } catch {
      document.documentElement.dataset.theme = 'dark'
    }
    createApp(DesktopLyric).mount('#app')
  } else {
    createApp(App).use(createPinia()).use(router).mount('#app')
    // Android：接管返回手势/返回键（覆盖层 → 路由 → 双击退出）
    if (/Android/i.test(navigator.userAgent)) {
      void import('./core/back-button').then((m) => void m.installAndroidBackButton())
    }
  }
}

void bootstrap()
