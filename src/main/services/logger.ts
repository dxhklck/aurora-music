import { app } from 'electron'
import { appendFile, mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

/**
 * 运行日志与诊断导出。
 *
 * 为什么要有它：打包后的应用出问题时，用户能提供的信息通常只有一句「没声音」。
 * 这里把主进程异常、渲染层未捕获错误、音源失败统一落到 userData/logs，
 * 再由「导出诊断」拼成一个文本文件交给用户发出来。
 *
 * 纪律：
 * - 写日志本身不许抛错（磁盘满 / 权限不足都不能影响播放）；
 * - 崩溃路径用同步写，异步 appendFile 在进程退出前来不及落盘；
 * - 只保留 5 个文件、单文件 2MB，长期运行不会把用户磁盘写满。
 */

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 5

let dirReady = false

function logDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function currentFile(): string {
  return join(logDir(), 'aurora.log')
}

async function ensureDir(): Promise<void> {
  if (dirReady) return
  await mkdir(logDir(), { recursive: true })
  dirReady = true
}

/** 单文件写满后滚动：aurora.log → aurora.1.log，超出 MAX_FILES 的最旧一份删掉 */
async function rotateIfNeeded(): Promise<void> {
  try {
    const info = await stat(currentFile())
    if (info.size < MAX_FILE_BYTES) return
    for (let index = MAX_FILES - 1; index >= 1; index -= 1) {
      const from = index === 1 ? currentFile() : join(logDir(), `aurora.${index - 1}.log`)
      const to = join(logDir(), `aurora.${index}.log`)
      try {
        await unlink(to)
      } catch {
        /* 目标不存在，正常 */
      }
      try {
        await rename(from, to)
      } catch {
        /* 源不存在，正常 */
      }
    }
  } catch {
    /* 文件还不存在 */
  }
}

function stamp(): string {
  return new Date().toISOString()
}

function format(level: string, scope: string, message: string): string {
  return `${stamp()} [${level}] [${scope}] ${message}\n`
}

/** 崩溃路径：同步写，进程马上要死了也来得及 */
export function logCrash(scope: string, error: unknown): void {
  const text = format('FATAL', scope, describe(error))
  try {
    appendFileSync(currentFile(), text, 'utf8')
  } catch {
    /* 写不进去就算了，别在崩溃路径上再抛 */
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack ?? ''}`.trim()
  }
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function write(level: string, scope: string, message: string): Promise<void> {
  try {
    await ensureDir()
    await rotateIfNeeded()
    await appendFile(currentFile(), format(level, scope, message), 'utf8')
  } catch {
    /* 日志失败绝不能影响主流程 */
  }
}

export const logger = {
  info(scope: string, message: string): void {
    void write('INFO', scope, message)
  },
  warn(scope: string, message: string): void {
    void write('WARN', scope, message)
  },
  error(scope: string, error: unknown): void {
    void write('ERROR', scope, describe(error))
  },
  crash(scope: string, error: unknown): void {
    logCrash(scope, error)
  }
}

/** 按时间倒序读取全部日志（新的在前），总量上限保护 */
export async function readLogs(maxBytes = 512 * 1024): Promise<string> {
  try {
    await ensureDir()
    const names = (await readdir(logDir()))
      .filter((name) => name.startsWith('aurora') && name.endsWith('.log'))
      // aurora.log 最新，aurora.1.log 次之……
      .sort((a, b) => {
        const rank = (name: string): number => (name === 'aurora.log' ? 0 : Number(name.split('.')[1]) || 0)
        return rank(a) - rank(b)
      })
    const chunks: string[] = []
    let used = 0
    for (const name of names) {
      const content = await readFile(join(logDir(), name), 'utf8')
      if (!content) continue
      chunks.push(`--- ${name} ---\n${content}`)
      used += content.length
      if (used >= maxBytes) break
    }
    return chunks.join('\n')
  } catch (error) {
    return `（读取日志失败：${describe(error)}）`
  }
}

/** 系统与运行时信息：排查环境相关问题的第一手材料 */
export function systemInfo(): string {
  const memory = os.totalmem() / 1024 / 1024 / 1024
  return [
    `应用版本：${app.getVersion()}`,
    `Electron：${process.versions.electron}　Chromium：${process.versions.chrome}　Node：${process.versions.node}`,
    `平台：${process.platform} ${os.release()}（${process.arch}）`,
    `CPU：${os.cpus()[0]?.model ?? '未知'} × ${os.cpus().length}`,
    `内存：${memory.toFixed(1)} GB`,
    `打包运行：${app.isPackaged ? '是' : '否'}`,
    `userData：${app.getPath('userData')}`
  ].join('\n')
}
