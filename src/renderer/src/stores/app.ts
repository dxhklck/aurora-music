import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppSettings, PlatformId, ProviderInfo } from '@shared/types'

export interface Toast {
  id: number
  type: 'info' | 'error' | 'success'
  message: string
}

let toastSeed = 0

export const useAppStore = defineStore('app', () => {
  const providers = ref<ProviderInfo[]>([])
  const platform = ref<PlatformId>('demo')
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
    // hidden 音源（本地音乐等）不在切换列表中出现，但底层仍在服务播放
    providers.value = list.filter((item) => !item.hidden)
    settings.value = config
    platform.value = list.some((item) => item.id === config.platform)
      ? config.platform
      : (list[0]?.id ?? 'demo')
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
