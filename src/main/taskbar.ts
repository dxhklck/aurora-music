import { app, BrowserWindow } from 'electron'
import type { DownloadTask } from '@shared/types'
import { IPC } from '@shared/ipc'
import { taskbarProgress } from '@shared/download-progress'
import { getMainWindow } from './windows'

/**
 * Windows 任务栏集成：跳转列表 + 下载进度。
 *
 * 跳转列表的每一项都是「重新启动一个进程 + 参数」，不是进程内回调——这是 Electron 的
 * 既定行为。单实例锁会把第二个进程挡掉，命令靠 `second-instance` 的 argv 传进来，
 * 所以参数格式（`--jump=<command>`）是与 index.ts 共享的约定，改一处必须改两处。
 */

export type JumpCommand = 'toggle' | 'next' | 'prev'
const JUMP_PREFIX = '--jump='

/** 把播放命令发给所有窗口（复用托盘/全局快捷键同一条通道） */
export function sendPlayCommand(command: JumpCommand): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.trayCommand, command)
    }
  }
}

/** 从第二实例的 argv 里取出跳转命令；不是跳转列表唤起时返回 null */
export function parseJumpCommand(argv: string[]): JumpCommand | null {
  const hit = argv.find((arg) => arg.startsWith(JUMP_PREFIX))
  if (!hit) return null
  const command = hit.slice(JUMP_PREFIX.length)
  return command === 'toggle' || command === 'next' || command === 'prev' ? command : null
}

/** 注册跳转列表（仅 Windows）；失败不影响启动 */
export function setupJumpList(): void {
  if (process.platform !== 'win32') return
  const task = (title: string, description: string, command: JumpCommand): Electron.JumpListItem => ({
    type: 'task',
    title,
    description,
    program: process.execPath,
    args: `${JUMP_PREFIX}${command}`,
    // 打包后 execPath 就是应用图标；dev 模式下是 electron.exe 的默认图标，不影响功能
    iconPath: process.execPath,
    iconIndex: 0
  })
  try {
    app.setJumpList([
      {
        type: 'tasks',
        items: [
          task('播放 / 暂停', '在后台切换播放状态', 'toggle'),
          task('上一首', '切到上一首', 'prev'),
          task('下一首', '切到下一首', 'next')
        ]
      }
    ])
  } catch {
    /* 系统不支持跳转列表时静默跳过 */
  }
}

/**
 * 下载进度映射到任务栏进度条。取值规则见 `shared/download-progress.ts`
 * （纯函数，边界由 tests/download-progress.test.ts 覆盖）。
 */
export function setTaskbarProgress(tasks: DownloadTask[]): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  try {
    win.setProgressBar(taskbarProgress(tasks))
  } catch {
    /* 进度条不是关键路径，失败就放弃 */
  }
}
