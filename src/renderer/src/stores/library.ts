import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { DuplicateGroup, LibraryOpReport, LibraryTrack } from '@shared/types'
import { useAppStore } from './app'

export const useLibraryStore = defineStore('library', () => {
  const items = ref<LibraryTrack[]>([])
  const loading = ref(false)
  /** 已导入的本地音乐目录（不含下载目录） */
  const importedDirs = ref<string[]>([])
  /** 上次重复扫描命中的条目数，用于工具栏角标 */
  const duplicateIds = ref(0)

  /** 缺失文件不计入占用，否则统计会虚高 */
  const totalSize = computed(() =>
    items.value.reduce((sum, item) => sum + (item.missing ? 0 : item.size), 0)
  )
  const missingCount = computed(() => items.value.filter((item) => item.missing).length)

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

  /** 单曲：仅从库移除（不动磁盘） */
  async function remove(id: string): Promise<void> {
    const app = useAppStore()
    items.value = await window.api.removeLibrary(id)
    app.toast('已从音乐库移除，文件仍在磁盘', 'info')
  }

  /** 批量：仅从库移除 */
  async function removeMany(ids: string[]): Promise<LibraryOpReport | null> {
    if (!ids.length) return null
    const report = await window.api.removeLibraryMany(ids)
    items.value = await window.api.listLibrary()
    notify(report, '已从音乐库移除')
    return report
  }

  /** 删除文件：下载目录进回收站，导入目录自动降级为仅移除 */
  async function deleteFiles(ids: string[]): Promise<LibraryOpReport | null> {
    if (!ids.length) return null
    const report = await window.api.deleteLibraryFiles(ids)
    items.value = await window.api.listLibrary()
    notify(report, '已删除')
    return report
  }

  async function copyTo(ids: string[]): Promise<LibraryOpReport | null> {
    const report = await window.api.copyLibraryTracks(ids)
    if (report) notify(report, '已复制')
    return report
  }

  async function exportTo(ids: string[], template: string): Promise<LibraryOpReport | null> {
    const report = await window.api.exportLibraryTracks(ids, template)
    if (report) notify(report, '已导出')
    return report
  }

  async function findDuplicates(): Promise<DuplicateGroup[]> {
    const groups = await window.api.findDuplicateTracks()
    duplicateIds.value = groups.reduce((sum, group) => sum + group.ids.length, 0)
    return groups
  }

  async function relocate(): Promise<void> {
    const app = useAppStore()
    const fixed = await window.api.relocateLibraryTracks()
    await refresh()
    app.toast(fixed ? `已重新定位 ${fixed} 个文件` : '没有找到匹配的文件', fixed ? 'success' : 'info')
  }

  async function purgeMissing(): Promise<void> {
    const app = useAppStore()
    const removed = await window.api.purgeMissingTracks()
    await load()
    app.toast(`已清理 ${removed} 个缺失条目`, 'info')
  }

  async function copyPath(ids: string[]): Promise<void> {
    const app = useAppStore()
    const paths = items.value.filter((item) => ids.includes(item.id)).map((item) => item.filePath)
    if (!paths.length) return
    await window.api.copyText(paths.join('\n'))
    app.toast(paths.length > 1 ? `已复制 ${paths.length} 条路径` : '路径已复制', 'success')
  }

  /** 批量改标签：缺省字段保持原样，歌名不参与（逐首不同） */
  async function updateMetaMany(
    ids: string[],
    patch: { artists?: string; album?: string }
  ): Promise<LibraryOpReport | null> {
    if (!ids.length) return null
    const report = await window.api.updateLibraryMetaMany(ids, patch)
    items.value = await window.api.listLibrary()
    notify(report, '已更新')
    return report
  }

  /** 复制文件本身到系统剪贴板，粘到资源管理器/聊天窗口就是一个文件 */
  async function copyFiles(ids: string[]): Promise<boolean> {
    const app = useAppStore()
    if (!ids.length) return false
    const result = await window.api.copyLibraryFiles(ids)
    if (!result.ok) {
      app.toast(result.message ?? '复制文件失败，可改用「复制路径」', 'error')
      return false
    }
    app.toast(
      result.message ?? `已复制 ${ids.length} 个文件，可直接粘贴到文件夹或聊天窗口`,
      'success'
    )
    return true
  }

  function reveal(id: string): void {
    void window.api.revealLibrary(id)
  }

  /** 部分成功是常态：分别报成功与失败数量，具体原因看明细弹层 */
  function notify(report: LibraryOpReport, verb: string): void {
    const app = useAppStore()
    if (!report.items.length) return
    if (!report.failed) {
      app.toast(`${verb} ${report.ok} 项`, 'success')
      return
    }
    if (!report.ok) {
      app.toast(report.items[0]?.note ?? `${verb}失败`, 'error')
      return
    }
    app.toast(`${verb} ${report.ok} 项，${report.failed} 项失败`, 'info')
  }

  return {
    items,
    loading,
    totalSize,
    missingCount,
    duplicateIds,
    importedDirs,
    load,
    refresh,
    remove,
    removeMany,
    deleteFiles,
    copyTo,
    exportTo,
    findDuplicates,
    relocate,
    purgeMissing,
    copyPath,
    updateMetaMany,
    copyFiles,
    reveal,
    importDir,
    removeDir
  }
})
