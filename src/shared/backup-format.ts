import type { AppSettings, BackupFilePayload } from './types'

/**
 * 备份文件的格式约定与校验。
 *
 * 单独放在 shared 而不是 main/services/backup.ts 里，是为了让校验逻辑可单测：
 * 它决定「一份外来 JSON 会不会被写进用户目录」，写错的后果是配置被覆盖成垃圾。
 *
 * 两条硬规则：
 * 1. **文件名走白名单**。备份文件里的 key 是不可信输入，直接拼路径就是路径穿越
 *    （`../../.ssh/authorized_keys`）。只有 BACKUP_FILES 里的名字会被采纳。
 * 2. **格式版本只增不改**。旧版应用读到新版备份必须明确拒绝，而不是尽力解析。
 *
 * 注意：本文件对 types 只有 `import type`，没有值导入——Node 的原生测试运行器
 * 直接跑 .ts 时不做路径解析，值导入会因为缺扩展名报 ERR_MODULE_NOT_FOUND。
 */

/** 备份文件格式标识 */
export const BACKUP_FORMAT = 'aurora-backup'
/** 格式版本。只增不改：旧版应用读到新版备份必须明确拒绝 */
export const BACKUP_VERSION = 1

/** 备份覆盖的配置文件；不在列表里的一律不碰（日志、缓存、凭据都不进备份） */
export const BACKUP_FILES = [
  'settings.json',
  'library.json',
  'library-ignored.json',
  'playlists.json',
  'downloads.json'
] as const

/**
 * 渲染层 localStorage 的白名单。
 * 队列与断点不备份：在线曲目换机器后要重新取址，本地曲目路径基本失效，
 * 还原一堆播不了的条目比空队列更糟。
 */
export const BACKUP_LOCAL_KEYS = [
  'aurora.stats',
  'aurora.recent',
  'aurora.lyric-offsets'
] as const

export function normalizeBackupLocal(input: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!input || typeof input !== 'object') return out
  const source = input as Record<string, unknown>
  for (const key of BACKUP_LOCAL_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

export type BackupValidation =
  | { ok: true; payload: BackupFilePayload }
  | { ok: false; error: string }

/**
 * 导出前抹掉「不属于数据、只属于这台机器」的字段。
 *
 * 备份文件是明文 JSON，会被传网盘、发给别人，所以：
 * - Cookie / 网易云账号 —— 绝不导出；
 * - 窗口几何 —— 换机器没有意义（还原时也不会采用，见 `mergeRestoredSettings`）；
 * - 迷你态 —— 当前窗口形态，不是偏好。
 *
 * 返回新对象，不改入参：settings.get() 的返回值是共享缓存，就地修改会直接改掉运行时状态。
 */
export function stripCredentialsForBackup(current: AppSettings): AppSettings {
  return {
    ...current,
    qqCookie: '',
    neteaseCookie: '',
    neteaseAccount: null,
    windowBounds: {},
    desktopLyricBounds: {},
    miniMode: false
  }
}

/**
 * 还原时「只认本机」的那几个字段。
 * 单独声明成窄接口而不是直接吃 AppSettings：调用方传完整设置即可（结构类型自动满足），
 * 测试也不必为了跑一个合并函数去构造三十个字段。
 */
export interface LocalOnlySettings {
  qqCookie: string
  neteaseCookie: string
  neteaseAccount: AppSettings['neteaseAccount']
  windowBounds: AppSettings['windowBounds']
  desktopLyricBounds: AppSettings['desktopLyricBounds']
  miniMode: boolean
}

/**
 * 还原 settings.json 时把「属于本机、不属于备份」的字段打回去：
 *
 * - 凭据（Cookie / 网易云账号）：备份是明文文件，会被传网盘、发给别人。
 *   还原不该让一台新机器凭空获得别人的登录态。
 * - 窗口几何：备份里的坐标属于另一块屏幕，直接写回可能把窗口摆到屏幕外，用户以为应用坏了。
 * - 迷你态：那是「当前窗口形态」而不是偏好，还原成 true 会让人以为界面缩不回去。
 *
 * 返回序列化后的文本；备份内容不是合法 JSON 对象时返回 null（调用方据此判失败）。
 */
export function mergeRestoredSettings(raw: string, current: LocalOnlySettings): string | null {
  let incoming: Partial<AppSettings>
  try {
    incoming = JSON.parse(raw) as Partial<AppSettings>
  } catch {
    return null
  }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null
  incoming.qqCookie = current.qqCookie
  incoming.neteaseCookie = current.neteaseCookie
  incoming.neteaseAccount = current.neteaseAccount
  incoming.windowBounds = current.windowBounds
  incoming.desktopLyricBounds = current.desktopLyricBounds
  incoming.miniMode = false
  return JSON.stringify(incoming, null, 2)
}

export function validateBackup(raw: unknown): BackupValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '文件内容不是有效的备份对象' }
  }
  const source = raw as Partial<BackupFilePayload>
  if (source.format !== BACKUP_FORMAT) {
    return { ok: false, error: '这不是 Aurora Music 的备份文件' }
  }
  const version = Number(source.version)
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, error: '备份文件缺少格式版本号，可能已损坏' }
  }
  if (version > BACKUP_VERSION) {
    return {
      ok: false,
      error: `备份来自更新的版本（格式 v${version}），请先升级应用`
    }
  }
  if (!source.files || typeof source.files !== 'object' || Array.isArray(source.files)) {
    return { ok: false, error: '备份文件里没有可还原的内容' }
  }

  // 只采纳白名单文件名，且值必须是字符串原文
  const files: Record<string, string> = {}
  for (const name of BACKUP_FILES) {
    const value = (source.files as Record<string, unknown>)[name]
    if (typeof value === 'string' && value) files[name] = value
  }
  if (!Object.keys(files).length) {
    return { ok: false, error: '备份里没有任何可还原的配置文件' }
  }

  return {
    ok: true,
    payload: {
      format: BACKUP_FORMAT,
      version,
      appVersion: typeof source.appVersion === 'string' ? source.appVersion : '',
      createdAt: Number(source.createdAt) || 0,
      files,
      local: normalizeBackupLocal(source.local)
    }
  }
}
