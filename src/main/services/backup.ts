import { app, dialog, shell } from 'electron'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BackupExportResult,
  BackupFilePayload,
  BackupImportResult
} from '@shared/types'
import {
  BACKUP_FILES,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  mergeRestoredSettings,
  normalizeBackupLocal,
  stripCredentialsForBackup,
  validateBackup
} from '@shared/backup-format'
import { settings } from './settings'

/**
 * 全量备份 / 还原：配置 + 本地库索引 + 歌单 + 下载记录 + 渲染层统计。
 *
 * 三条边界（都是换机器时才会暴露的问题）：
 *
 * 1. **凭据不进备份**。备份文件是明文 JSON，会被传网盘、发给别人。Cookie 与账号信息
 *    一律不导出；还原时保留本机已有的凭据，不做「凭空登录」。
 * 2. **窗口几何不还原**。备份里的坐标属于另一块屏幕，直接写回可能把窗口摆到屏幕外。
 * 3. **还原必须重启**。主进程内存里是旧配置，写入磁盘后只要再发生一次 settings 回写
 *    （窗口位置就会触发），磁盘上的备份就被旧值盖掉。所以还原后只许重启，没有「稍后」。
 *
 * 这里只管「跟磁盘和对话框打交道」，格式校验在 shared/backup-format.ts（可单测）。
 */

/** 备份覆盖的配置文件；不在列表里的一律不碰（日志、缓存、凭据都不进备份） */
const CONFIG_FILES: readonly string[] = BACKUP_FILES

function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function normalizeLocal(input: unknown): Record<string, string> {
  return normalizeBackupLocal(input)
}

/**
 * 导出。`local` 由渲染层收集后传进来（localStorage 主进程读不到）。
 * 导出前先 flush：settings 的写盘是异步排队的，不等它落地会导出上一秒的旧配置。
 */
export async function exportBackup(local: Record<string, string>): Promise<BackupExportResult> {
  await settings.flush()
  const userData = app.getPath('userData')
  const files: Record<string, string> = {
    // settings.json 不能直接抄文件：原文里有 Cookie。用内存里的当前值脱敏后再序列化，
    // 顺带保证「刚改过还没落盘」的设置也是最新的。
    'settings.json': JSON.stringify(stripCredentialsForBackup(settings.get()), null, 2)
  }
  for (const name of CONFIG_FILES) {
    if (name === 'settings.json') continue
    const file = join(userData, name)
    if (!existsSync(file)) continue
    try {
      files[name] = await readFile(file, 'utf8')
    } catch {
      /* 单个文件读不了就跳过，不要让一次 EACCES 毁掉整个备份 */
    }
  }

  const payload: BackupFilePayload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion: app.getVersion(),
    createdAt: Date.now(),
    files,
    local: normalizeLocal(local)
  }

  const result = await dialog.showSaveDialog({
    title: '导出备份',
    defaultPath: join(app.getPath('documents'), `aurora-backup-${stamp()}.json`),
    filters: [{ name: 'Aurora 备份', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true, path: '', bytes: 0 }

  const body = JSON.stringify(payload, null, 2)
  try {
    await writeFile(result.filePath, body, 'utf8')
  } catch (error) {
    throw new Error(`写入备份文件失败：${(error as Error).message}`)
  }
  shell.showItemInFolder(result.filePath)
  return { canceled: false, path: result.filePath, bytes: Buffer.byteLength(body) }
}

/** 还原 settings.json 时保留本机凭据与窗口几何，其余字段以备份为准 */
function mergeSettings(raw: string): string | null {
  return mergeRestoredSettings(raw, settings.get())
}

/**
 * 还原。成功返回后调用方必须写回 `local` 并立刻重启——内存里还是旧配置，
 * 任何一次后续落盘都会把刚还原的文件覆盖掉。
 */
export async function importBackup(): Promise<BackupImportResult> {
  const picked = await dialog.showOpenDialog({
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: 'Aurora 备份', extensions: ['json'] }]
  })
  const source = picked.filePaths[0]
  if (picked.canceled || !source) {
    return { canceled: true, applied: false, local: {}, safetyDir: '' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(source, 'utf8'))
  } catch {
    return { canceled: false, applied: false, local: {}, safetyDir: '', error: '文件不是合法的 JSON' }
  }
  const validation = validateBackup(raw)
  if (!validation.ok) {
    return { canceled: false, applied: false, local: {}, safetyDir: '', error: validation.error }
  }
  const payload = validation.payload

  const userData = app.getPath('userData')
  // 安全副本：还原是覆盖式操作，留一份现场比事后追悔便宜
  const safetyDir = join(userData, `backup-before-restore-${stamp()}`)
  let copied = 0
  for (const name of CONFIG_FILES) {
    const file = join(userData, name)
    if (!existsSync(file)) continue
    try {
      await mkdir(safetyDir, { recursive: true })
      await copyFile(file, join(safetyDir, name))
      copied += 1
    } catch {
      /* 备份不了旧文件也要继续：否则一次权限问题就把还原彻底堵死 */
    }
  }

  const confirm = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['还原并重启', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '还原备份',
    message: '还原会覆盖当前的设置、本地库索引、歌单与下载记录。',
    detail: [
      copied ? `当前数据已自动备份到：\n${safetyDir}` : '当前没有可备份的数据。',
      '',
      `待还原：${Object.keys(payload.files).filter((name) => CONFIG_FILES.includes(name)).join('、') || '（空）'}`,
      '',
      '还原后应用会重启。登录状态与窗口位置保留本机现有值。'
    ].join('\n')
  })
  if (confirm.response !== 0) {
    return { canceled: true, applied: false, local: {}, safetyDir: copied ? safetyDir : '' }
  }

  // 先把内存里排队的写盘落地，避免还原后紧接着一次旧值回写
  await settings.flush()

  const failedFiles: string[] = []
  for (const [name, raw] of Object.entries(payload.files)) {
    if (!CONFIG_FILES.includes(name) || typeof raw !== 'string') continue
    let text = raw
    if (name === 'settings.json') {
      const merged = mergeSettings(raw)
      if (!merged) {
        failedFiles.push(name)
        continue
      }
      text = merged
    } else {
      // 其它文件只校验 JSON 合法性，内容原样写回
      try {
        JSON.parse(raw)
      } catch {
        failedFiles.push(name)
        continue
      }
    }
    try {
      await writeFile(join(userData, name), text, 'utf8')
    } catch {
      failedFiles.push(name)
    }
  }

  if (failedFiles.length === CONFIG_FILES.filter((name) => name in payload.files).length) {
    return {
      canceled: false,
      applied: false,
      local: {},
      safetyDir: copied ? safetyDir : '',
      error: '所有文件都写入失败，备份未生效',
      failedFiles
    }
  }

  return {
    canceled: false,
    applied: true,
    local: normalizeLocal(payload.local),
    safetyDir: copied ? safetyDir : '',
    failedFiles: failedFiles.length ? failedFiles : undefined
  }
}

/**
 * 重启应用。
 *
 * 用 `app.exit(0)` 而不是 `app.quit()`：quit 会触发 before-quit 里的
 * `settings.flush()` / `downloads.flush()`，把内存里的旧配置写回磁盘，
 * 正好覆盖掉刚还原的内容。这里要的是「立刻走，什么都不写」。
 */
export function relaunchApp(): void {
  app.relaunch()
  app.exit(0)
}
