import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppSettings, PlatformId, ProviderInfo } from '@shared/types'
import { applySavedOutput } from '../core/output'

export interface Toast {
  id: number
  type: 'info' | 'error' | 'success'
  message: string
}

let toastSeed = 0

export const useAppStore = defineStore('app', () => {
  const providers = ref<ProviderInfo[]>([])
  const platform = ref<PlatformId>('netease')
  const settings = ref<AppSettings | null>(null)
  const toasts = ref<Toast[]>([])
  const booted = ref(false)
  /** 桌面歌词窗口是否开着：主进程在创建/销毁时推过来，用来决定要不要每 250ms 推歌词状态 */
  const lyricOpen = ref(false)

  const currentProvider = computed<ProviderInfo | undefined>(
    () => providers.value.find((item) => item.id === platform.value) ?? providers.value[0]
  )
  const accent = computed<[string, string]>(
    () => currentProvider.value?.gradient ?? ['#7c6cff', '#2f2a6b']
  )
  const canCharts = computed(() => currentProvider.value?.capabilities.charts ?? false)

  async function boot(): Promise<void> {
    const [list, config] = await Promise.all([window.api.providers(), window.api.getSettings()])
    // hidden 音源（本地音乐、离线演示）不在切换列表中出现，但底层仍在服务播放
    providers.value = list.filter((item) => !item.hidden)
    settings.value = config
    // 判定必须用过滤后的列表：曾经用原始 list，hidden 的 demo 命中后 platform 停在
    // 'demo'，而侧栏按过滤后的列表找不到它 → 卡片显示第一个可见源、下拉无勾选，
    // 实际搜索/榜单却全走 demo。选中的音源必须是用户能在界面上看到的那个。
    const visible = providers.value.some((item) => item.id === config.platform)
    platform.value = visible ? config.platform : (providers.value[0]?.id ?? 'demo')
    // 修正过的结果写回，否则每次启动都要重算一遍（也让设置页显示的值与界面一致）
    if (!visible && platform.value !== config.platform) {
      await patchSettings({ platform: platform.value })
    }
    // 恢复输出设备：设备已拔掉时静默退回系统默认，不打扰启动流程
    void applySavedOutput(config.audioOutputId, config.audioOutputLabel)
    booted.value = true
  }

  /** 引擎开关会改变音源列表，设置页改完要重新拉一次 */
  async function reloadProviders(): Promise<void> {
    providers.value = (await window.api.providers()).filter((item) => !item.hidden)
    if (!providers.value.some((item) => item.id === platform.value)) {
      platform.value = providers.value[0]?.id ?? 'demo'
      await patchSettings({ platform: platform.value })
    }
  }

  async function setPlatform(id: PlatformId): Promise<void> {
    if (platform.value === id) return
    platform.value = id
    await patchSettings({ platform: id })
    toast(`已切换到 ${providers.value.find((item) => item.id === id)?.name ?? id}`, 'info')
  }

  async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await window.api.setSettings(patch)
  }

  function applySettings(next: AppSettings): void {
    settings.value = next
  }

  function toast(message: string, type: Toast['type'] = 'info'): void {
    const id = ++toastSeed
    toasts.value.push({ id, type, message })
    window.setTimeout(() => {
      toasts.value = toasts.value.filter((item) => item.id !== id)
    }, 3600)
  }

  return {
    providers,
    platform,
    settings,
    toasts,
    booted,
    lyricOpen,
    currentProvider,
    accent,
    canCharts,
    boot,
    reloadProviders,
    setPlatform,
    patchSettings,
    applySettings,
    toast
  }
})
