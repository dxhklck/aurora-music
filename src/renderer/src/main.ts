import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import DesktopLyric from './views/DesktopLyric.vue'
import { router } from './router'
import './styles/main.css'

const isLyricWindow = window.location.hash.startsWith('#/desktop-lyric')

if (isLyricWindow) {
  document.documentElement.classList.add('lyric-window')
  createApp(DesktopLyric).mount('#app')
} else {
  createApp(App).use(createPinia()).use(router).mount('#app')
}
