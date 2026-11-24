import { useRouter } from 'vue-router'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import type { M3uImportResult } from '@shared/types'

/**
 * M3U 导入的公共流程：主进程弹文件对话框 → 解析并按本地库匹配 → 结果落 toast。
 *
 * 入口有两处（歌单详情页的 M3U 菜单、侧栏「我的歌单」的导入按钮），行为必须一致，
 * 所以收在这里。useRouter 依赖 setup 同步上下文，必须以工厂形式在 setup 里取好，
 * 不能放进异步点击回调里调用。
 */
export function useM3uFlow() {
  const app = useAppStore()
  const playlists = usePlaylistStore()
  const router = useRouter()

  /** targetId 缺省 = 导入为新歌单；传入 = 追加到该歌单 */
  async function importM3u(targetId?: string): Promise<void> {
    const result = await window.api.importPlaylistM3u(targetId)
    if (result.canceled) return
    await playlists.load()
    if (!result.total) {
      app.toast('这个文件里没有可识别的曲目', 'error')
      return
    }
    if (!result.matched) {
      app.toast(`${result.total} 首都没有匹配到本地库里的文件`, 'error')
      return
    }
    const verb = targetId ? '追加' : '导入'
    app.toast(
      result.missing
        ? `已${verb} ${result.matched} 首；${result.missing} 首在本地库里找不到`
        : `已${verb} ${result.matched} 首${targetId ? `到《${result.name}》` : ''}`,
      result.missing ? 'info' : 'success'
    )
    if (!targetId && result.playlistId) void router.push(`/playlist/${result.playlistId}`)
  }

  return { importM3u }
}

export type { M3uImportResult }
