import { join } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { AppSettings } from '@shared/types'

const DEFAULT_SETTINGS: AppSettings = {
  platform: 'demo',
  quality: 'high',
  volume: 0.75,
  playMode: 'loop',
  downloadDir: '',
  /** 额外导入的本地音乐目录（与下载目录一起扫描） */
  musicDirs: [],
  searchLimit: 30,
  autoSwitchSource: true,
  desktopLyricLocked: false,
  desktopLyricMode: 'mini',
  nowPlayingStyle: 'vinyl',
  playerTheme: 'aurora',
  themeMode: 'dark',
  downloadConcurrency: 2,
  downloadRetries: 3,
  writeTags: true,
  engineEnabled: true,
  closeToTray: true,
  qqCookie: '',
  neteaseCookie: '',
  neteaseAccount: null,
  miniMode: false,
  windowBounds: {}
}

/** 设置持久化（settings.json，原子写入 + 内存缓存） */
class SettingsService {
  private filePath = ''
  private cache: AppSettings = { ...DEFAULT_SETTINGS }

  async init(userDataDir: string, defaultDownloadDir: string): Promise<AppSettings> {
    this.filePath = join(userDataDir, 'settings.json')
    this.cache = { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir }
    if (existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppSettings>
        this.cache = { ...this.cache, ...parsed }
      } catch {
        /* 配置损坏时回退默认值 */
      }
    }
    if (!this.cache.downloadDir) this.cache.downloadDir = defaultDownloadDir
    return this.get()
  }

  get(): AppSettings {
    return { ...this.cache }
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.cache = { ...this.cache, ...patch }
    if (this.filePath) {
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    }
    return this.get()
  }
}

export const settings = new SettingsService()
