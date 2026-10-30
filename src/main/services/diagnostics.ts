import { app, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings } from '@shared/types'
import { settings } from './settings'
import { snapshot as sourceHealthSnapshot } from './source-health'
import { readLogs, systemInfo } from './logger'

/**
 * 诊断报告：把「排查一个问题需要的全部环境信息」拼成一个纯文本，
 * 用户点一次就能拿到，不用指导他去找日志目录。
 *
 * 脱敏：settings 里的 Cookie / 手机号等凭据一律不落进报告，
 * 只保留会影响播放行为的开关（音源、音质、EQ、更新渠道等）。
 */

/** 允许出现在报告里的设置字段（白名单，新字段默认不导出） */
const SAFE_SETTING_KEYS: Array<keyof AppSettings> = [
  'platform',
  'quality',
  'autoSwitchSource',
  'downloadDir',
  'closeToTray',
  'updateChannel',
  'themeMode',
  'nowPlayingStyle',
  'playerTheme',
  'desktopLyricMode',
  'desktopLyricLocked',
  'volume',
  'playMode',
  'searchLimit',
  'downloadConcurrency',
  'downloadRetries',
  'writeTags',
  'engineEnabled',
  'equalizer'
]

function settingsDigest(): string {
  const current = settings.get() as unknown as Record<string, unknown>
  const lines: string[] = []
  for (const key of SAFE_SETTING_KEYS) {
    const value = current[key]
    if (value === undefined) continue
    lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  }
  const dirs = current.musicDirs
  if (Array.isArray(dirs)) lines.push(`musicDirs: ${dirs.length} 个目录`)
  return lines.join('\n')
}

function healthDigest(): string {
  try {
    const view = sourceHealthSnapshot()
    if (!view.items.length) return '（尚未巡检）'
    return view.items
      .map((item) => `${item.label}：${item.state}${item.ms ? ` ${item.ms}ms` : ''}${item.error ? ` — ${item.error}` : ''}`)
      .join('\n')
  } catch {
    return '（巡检数据不可用）'
  }
}

export async function exportDiagnostics(): Promise<string | null> {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const name = `aurora-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`

  const result = await dialog.showSaveDialog({
    title: '导出诊断信息',
    defaultPath: join(app.getPath('downloads'), name),
    filters: [{ name: '文本文件', extensions: ['txt'] }]
  })
  if (result.canceled || !result.filePath) return null

  const body = [
    '=== Aurora Music 诊断报告 ===',
    `生成时间：${now.toLocaleString()}`,
    '',
    '--- 运行环境 ---',
    systemInfo(),
    '',
    '--- 设置摘要（已脱敏，不含 Cookie）---',
    settingsDigest(),
    '',
    '--- 音源健康 ---',
    healthDigest(),
    '',
    '--- 最近日志 ---',
    await readLogs()
  ].join('\n')

  try {
    await writeFile(result.filePath, body, 'utf8')
    shell.showItemInFolder(result.filePath)
    return result.filePath
  } catch (error) {
    throw new Error(`写入诊断文件失败：${(error as Error).message}`)
  }
}
