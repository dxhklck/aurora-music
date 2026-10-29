import { join } from 'node:path'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { AppSettings } from '@shared/types'

/** 均衡器固定五段，增益必须恒为 5 个数字：长度不对时 setEqualizer 会静默不生效 */
const EQ_BANDS = 5
const EQ_MAX_GAIN = 12

function normalizeEqualizer(input: unknown): AppSettings['equalizer'] {
  const source = (input ?? {}) as { enabled?: unknown; gains?: unknown }
  const raw = Array.isArray(source.gains) ? source.gains : []
  return {
    enabled: source.enabled === true,
    gains: Array.from({ length: EQ_BANDS }, (_, index) => {
      const value = Number(raw[index])
      return Number.isFinite(value) ? Math.max(-EQ_MAX_GAIN, Math.min(EQ_MAX_GAIN, value)) : 0
    })
  }
}

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
  equalizer: { enabled: false, gains: [0, 0, 0, 0, 0] },
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
  /**
   * 落盘串行队列。两次并发 set（例如「改迷你模式」与「窗口位置回写」几乎同时发生）
   * 会抢同一个 .tmp 文件：先完成的 rename 把后一个的 tmp 移走，后者 rename 直接 ENOENT。
   */
  private writing: Promise<void> = Promise.resolve()

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
    // 老版本 settings.json 没有这个字段，或者只存了一半：统一补成合法形态
    this.cache.equalizer = normalizeEqualizer(this.cache.equalizer)
    return this.get()
  }

  get(): AppSettings {
    return { ...this.cache }
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.cache = {
      ...this.cache,
      ...patch,
      equalizer: normalizeEqualizer(patch.equalizer ?? this.cache.equalizer)
    }
    if (this.filePath) {
      // 快照必须在排队前取：串行执行时用的应是「调用那一刻」的完整状态
      const snapshot = JSON.stringify(this.cache, null, 2)
      const run = this.writing.then(() => this.writeSnapshot(snapshot))
      // 队列本身要吃掉失败，否则一次写盘错误会让后续所有 set 全部连带 reject
      this.writing = run.catch(() => undefined)
      await run
    }
    return this.get()
  }

  private async writeSnapshot(payload: string): Promise<void> {
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, payload, 'utf8')
    await rename(tmp, this.filePath)
  }
}

export const settings = new SettingsService()
