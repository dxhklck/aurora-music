import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { LibraryTrack } from '@shared/types'
import { useAppStore } from './app'

export const useLibraryStore = defineStore('library', () => {
  const items = ref<LibraryTrack[]>([])
  const loading = ref(false)
  /** 已导入的本地音乐目录（不含下载目录） */
  const importedDirs = ref<string[]>([])

  const totalSize = computed(() => items.value.reduce((sum, item) => sum + item.size, 0))

  async function load(): Promise<void> {
    loading.value = true
    try {
      items.value = await window.api.listLibrary()
      importedDirs.value = await window.api.listMusicDirs()
    } finally {
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    items.value = await window.api.refreshLibrary()
    importedDirs.value = await window.api.listMusicDirs()
  }

  async function importDir(): Promise<void> {
    const app = useAppStore()
    importedDirs.value = await window.api.importMusicDir()
    await refresh()
    if (importedDirs.value.length) app.toast('已导入本地音乐目录', 'success')
  }

  async function removeDir(dir: string): Promise<void> {
    importedDirs.value = await window.api.removeMusicDir(dir)
  }

  async function remove(id: string): Promise<void> {
    const app = useAppStore()
    await window.api.removeLibrary(id)
    items.value = items.value.filter((item) => item.id !== id)
    app.toast('已从音乐库移除（文件仍在磁盘）', 'info')
  }

  function reveal(id: string): void {
    void window.api.revealLibrary(id)
  }

  return { items, loading, totalSize, importedDirs, load, refresh, remove, reveal, importDir, removeDir }
})
