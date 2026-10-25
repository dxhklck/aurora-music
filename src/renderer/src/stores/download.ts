import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { DownloadTask, Song } from '@shared/types'
import { useAppStore } from './app'
import { plain } from '../core/plain'
import { friendlyError } from '../core/error'

let unsubscribe: (() => void) | null = null

export const useDownloadStore = defineStore('download', () => {
  const tasks = ref<DownloadTask[]>([])
  const ready = ref(false)

  const active = computed(() =>
    tasks.value.filter((task) => task.status === 'downloading' || task.status === 'queued')
  )
  const finished = computed(() => tasks.value.filter((task) => task.status === 'done'))
  const failed = computed(() => tasks.value.filter((task) => task.status === 'error'))

  async function init(): Promise<void> {
    if (unsubscribe) return
    tasks.value = await window.api.listDownloads()
    unsubscribe = window.api.onDownloadProgress((next) => {
      tasks.value = next
      ready.value = true
    })
    ready.value = true
  }

  async function enqueue(song: Song): Promise<void> {
    const app = useAppStore()
    try {
      const task = await window.api.enqueueDownload(plain(song))
      if (task.status === 'done') app.toast('该歌曲已下载', 'info')
      else app.toast(`开始下载：${song.name}`, 'success')
      tasks.value = await window.api.listDownloads()
    } catch (error) {
      app.toast(friendlyError(error), 'error')
    }
  }

  /** 批量下载：整张榜单 / 歌单 / 多选 */
  async function enqueueMany(songs: Song[]): Promise<void> {
    const app = useAppStore()
    if (!songs.length) return
    try {
      const created = await window.api.enqueueDownloads(songs.map((song) => plain(song)))
      tasks.value = await window.api.listDownloads()
      if (created.length) app.toast(`已加入下载队列：${created.length} 首`, 'success')
      else app.toast('这些歌曲都已在队列或已下载', 'info')
    } catch (error) {
      app.toast(friendlyError(error), 'error')
    }
  }

  async function cancel(id: string): Promise<void> {
    await window.api.cancelDownload(id)
  }

  async function retry(id: string): Promise<void> {
    await window.api.retryDownload(id)
  }

  async function retryFailed(): Promise<void> {
    const app = useAppStore()
    const count = await window.api.retryFailedDownloads()
    tasks.value = await window.api.listDownloads()
    app.toast(count ? `已重新排队 ${count} 个任务` : '没有需要重试的任务', count ? 'success' : 'info')
  }

  async function remove(id: string): Promise<void> {
    await window.api.removeDownload(id)
    tasks.value = await window.api.listDownloads()
  }

  async function clearFinished(): Promise<void> {
    await window.api.clearDownloads()
    tasks.value = await window.api.listDownloads()
  }

  return {
    tasks,
    ready,
    active,
    finished,
    failed,
    init,
    enqueue,
    enqueueMany,
    cancel,
    retry,
    retryFailed,
    remove,
    clearFinished
  }
})
