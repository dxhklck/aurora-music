import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import DesktopLyric from './views/DesktopLyric.vue'
import VolumePopup from './views/VolumePopup.vue'
import { router } from './router'
import './styles/main.css'

const isLyricWindow = window.location.hash.startsWith('#/desktop-lyric')
const isVolumePopup = window.location.hash.startsWith('#/volume-popup')

async function bootstrap(): Promise<void> {
  if (isVolumePopup) {
    // 音量气泡：透明浮层，不挂 Pinia/router（它只跟主窗口通过 IPC 同步音量）
    document.documentElement.classList.add('volume-popup')
    createApp(VolumePopup).mount('#app')
  } else if (isLyricWindow) {
    document.documentElement.classList.add('lyric-window')
    // 桌面歌词恒定深色（不跟应用主题）：它是浮在桌面壁纸上的组件，
    // 恒定半透明深色在任何壁纸上都协调，且给拖拽区提供绘制像素（透明窗口
    // 的 -webkit-app-region: drag 只在有像素的区域生效）
    createApp(DesktopLyric).mount('#app')
  } else {
    createApp(App).use(createPinia()).use(router).mount('#app')
  }
}

void bootstrap()
