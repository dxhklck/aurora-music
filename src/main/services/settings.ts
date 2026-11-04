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

/** 优先源列表：去重 + 只留非空字符串。历史值/手改值不能让排序函数拿到脏数据 */
function normalizeSources(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  for (const item of input) {
    if (typeof item === 'string' && item) seen.add(item)
  }
  return [...seen]
}

const DEFAULT_SETTINGS: AppSettings = {
  // 首次启动落到一个真实音源。demo（离线演示）是 hidden 的，不在切换列表里，
  // 当默认值会让侧栏显示的源与实际使用的源不一致——全新安装打开只有 3 首 40 秒的曲子。
  platform: 'netease',
  quality: 'high',
  volume: 0.75,
  audioOutputId: '',
  audioOutputLabel: '',
  playMode: 'loop',
  downloadDir: '',
  /** 额外导入的本地音乐目录（与下载目录一起扫描） */
  musicDirs: [],
  searchLimit: 30,
  autoSwitchSource: true,
  preferredSources: [],
  loudnessNorm: false,
  crossfadeSec: 0,
  desktopLyricLocked: false,
  desktopLyricMode: 'mini',
  nowPlayingStyle: 'vinyl',
  playerTheme: 'aurora',
  themeMode: 'dark',
  downloadConcurrency: 2,
  downloadRetries: 3,
  writeTags: true,
  engineEnabled: true,
  updateChannel: '',
  equalizer: { enabled: false, gains: [0, 0, 0, 0, 0] },
  closeToTray: true,
  qqCookie: '',
  neteaseCookie: '',
  neteaseAccount: null,
  miniMode: false,
  windowBounds: {},
  desktopLyricBounds: {},
  tagsBackfilled: false
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
    this.cache.preferredSources = normalizeSources(this.cache.preferredSources)
    if (typeof this.cache.updateChannel !== 'string') this.cache.updateChannel = ''
    // 老版本没有输出设备字段：缺了就是系统默认，别让 undefined 流到 enumerateDevices 的比较里
    if (typeof this.cache.audioOutputId !== 'string') this.cache.audioOutputId = ''
    if (typeof this.cache.audioOutputLabel !== 'string') this.cache.audioOutputLabel = ''
    // 交叉淡化：非法值一律归零（0 = 关），别让 NaN 流进播放器
    const xf = Number(this.cache.crossfadeSec)
    if (!Number.isFinite(xf) || xf <= 0) this.cache.crossfadeSec = 0
    else this.cache.crossfadeSec = Math.min(12, Math.round(xf * 2) / 2)
    if (typeof this.cache.loudnessNorm !== 'boolean') this.cache.loudnessNorm = false
    return this.get()
  }

  get(): AppSettings {
    return { ...this.cache }
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.cache = {
      ...this.cache,
      ...patch,
      equalizer: normalizeEqualizer(patch.equalizer ?? this.cache.equalizer),
      preferredSources: normalizeSources(patch.preferredSources ?? this.cache.preferredSources),
      loudnessNorm: patch.loudnessNorm === undefined ? this.cache.loudnessNorm : Boolean(patch.loudnessNorm),
      crossfadeSec: (() => {
        const incoming = patch.crossfadeSec ?? this.cache.crossfadeSec
        const value = Number(incoming)
        if (!Number.isFinite(value) || value <= 0) return 0
        return Math.min(12, Math.round(value * 2) / 2)
      })()
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

  /**
   * 等队列里未完成的写入落地。
   * 窗口关闭时的保存是异步的（`void set(...)`），紧接着应用退出就会写不完——
   * before-quit 里要显式等一次。
   */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined)
  }
}

export const settings = new SettingsService()
