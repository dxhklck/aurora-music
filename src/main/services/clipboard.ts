import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Electron 的 clipboard 只能写文本/图片/HTML，没有跨平台的「文件列表」API。
 * 文件剪贴板必须落到各平台的系统剪贴板实现：
 * - Windows：CF_HDROP，PowerShell 5.1 的 Set-Clipboard -Path 正好封装了它（PowerShell 7 反而没有这个参数）
 * - macOS：NSPasteboard 的 NSFilenamesPboardType，用 osascript 塞 POSIX file 列表
 * - Linux：freedesktop 的 text/uri-list，wl-copy（Wayland）或 xclip（X11）
 * 三者都只写「路径引用」：源文件被删除/移动后，粘贴会失败，这是系统剪贴板的固有语义。
 */

export interface ClipboardResult {
  ok: boolean
  message?: string
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const withStderr = error as Error & { stderr?: string }
    const stderr = withStderr.stderr?.trim()
    return stderr ? stderr.split('\n').slice(-2).join(' ') : error.message
  }
  return String(error)
}

/** Windows：必须用 5.1 的 powershell.exe；-EncodedCommand 走 UTF-16LE base64，绕开一切引号转义 */
async function copyOnWindows(files: string[]): Promise<ClipboardResult> {
  const list = files.map((path) => `'${path.replace(/'/g, "''")}'`).join(',')
  const script = `Set-Clipboard -Path @(${list}) -ErrorAction Stop`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  // 命令行总长上限 32767，base64 后每条路径约膨胀 2.7 倍
  if (encoded.length > 28_000) {
    return { ok: false, message: '一次复制的文件太多，请分批操作，或改用「复制路径」' }
  }
  const exe = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  await run(
    exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: 15_000, windowsHide: true }
  )
  return { ok: true }
}

/** macOS：单个文件不能包成 list，否则 Finder 粘贴会变成一个文本片段 */
async function copyOnMac(files: string[]): Promise<ClipboardResult> {
  const quote = (path: string): string => `POSIX file "${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  const body =
    files.length === 1 ? `set the clipboard to (${quote(files[0])})` : `set the clipboard to {${files.map(quote).join(', ')}}`
  await run('osascript', ['-e', body], { timeout: 15_000 })
  return { ok: true }
}

function writeStdin(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} 退出码 ${code}`))
    })
    child.stdin.end(input)
  })
}

/** Linux：text/uri-list 每行一个 file:// URI，CRLF 分隔 */
async function copyOnLinux(files: string[]): Promise<ClipboardResult> {
  const uris = files
    .map((path) => `file://${encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F')}`)
    .join('\r\n')
  const payload = `${uris}\r\n`
  try {
    await writeStdin('wl-copy', ['--type', 'text/uri-list'], payload)
    return { ok: true }
  } catch {
    /* 不是 Wayland，或者没装 wl-clipboard，继续试 X11 */
  }
  try {
    await writeStdin('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i'], payload)
    return { ok: true }
  } catch {
    return { ok: false, message: '当前桌面缺少 wl-copy / xclip，无法写入文件剪贴板' }
  }
}

export async function copyFilesToClipboard(paths: string[]): Promise<ClipboardResult> {
  const files = paths.filter((path) => !!path && existsSync(path))
  if (!files.length) return { ok: false, message: '没有可复制的文件（可能已被移动或删除）' }
  const skipped = paths.length - files.length

  try {
    const result =
      process.platform === 'win32'
        ? await copyOnWindows(files)
        : process.platform === 'darwin'
          ? await copyOnMac(files)
          : await copyOnLinux(files)
    if (!result.ok) return result
    return skipped ? { ok: true, message: `已跳过 ${skipped} 个不存在的文件` } : { ok: true }
  } catch (error) {
    return { ok: false, message: messageOf(error) }
  }
}
