import { BrowserWindow, globalShortcut } from 'electron'
import { IPC } from '@shared/ipc'
import type { AppSettings } from '@shared/types'
import { settings } from './services/settings'

/**
 * 全局快捷键。
 *
 * 三条可改（播放暂停 / 上一首 / 下一首），媒体键固定跟随、不参与自定义：
 * 它们是系统级按键，改掉反而会让用户找不到。
 *
 * 注册失败是常态而不是异常——组合键可能被别的软件占用。返回值列出失败项，
 * 设置页据此提示「这一项被占用了」，而不是静默不生效。
 */

export interface ShortcutBinding {
  /** 设置里的键名 */
  key: keyof AppSettings['shortcuts']
  /** 真正交给 globalShortcut 的 accelerator */
  accelerator: string
  command: 'toggle' | 'next' | 'prev'
  /** 界面上的说法 */
  label: string
}

/** 平台修饰键：mac 用 Control+Command，其它用 Ctrl+Alt */
function platformModifier(): string {
  return process.platform === 'darwin' ? 'Control+Command' : 'Control+Alt'
}

/**
 * 平台默认。上一首/下一首不用方向键：Windows 上 Ctrl+Alt+←/→ 被 Intel 显卡驱动
 * 占作「旋转屏幕」，注册必然失败（本机实测两项都失败）。逗号/句号紧挨方向键，
 * 不与常见软件冲突。
 */
export function defaultShortcuts(): AppSettings['shortcuts'] {
  const mod = platformModifier()
  // 用字面量 `,` `.` 而不是 Comma/Period：Electron 的 accelerator 只认字面符号，
  // 写成键名会直接被判非法（register 返回 false）
  return { toggle: `${mod}+P`, prev: `${mod}+,`, next: `${mod}+.` }
}

/** 设置里为空时回落到平台默认值，保证老配置升级后仍然可用 */
export function resolveShortcuts(): ShortcutBinding[] {
  const saved = settings.get().shortcuts ?? { toggle: '', next: '', prev: '' }
  const fallback = defaultShortcuts()
  return [
    {
      key: 'toggle',
      accelerator: saved.toggle || fallback.toggle,
      command: 'toggle',
      label: '播放 / 暂停'
    },
    { key: 'prev', accelerator: saved.prev || fallback.prev, command: 'prev', label: '上一首' },
    { key: 'next', accelerator: saved.next || fallback.next, command: 'next', label: '下一首' }
  ]
}

function broadcast(command: 'toggle' | 'next' | 'prev'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC.trayCommand, command)
    }
  }
}

/** 退出前释放：不释放的话下次启动可能撞上自己占用的组合键 */
export function clearShortcuts(): void {
  globalShortcut.unregisterAll()
}

/** 重新注册全部快捷键，返回注册失败（被占用 / 非法）的 accelerator */
export function reregisterShortcuts(): string[] {
  globalShortcut.unregisterAll()
  const failed: string[] = []

  const bindings = resolveShortcuts()
  for (const binding of bindings) {
    let ok = false
    try {
      ok = globalShortcut.register(binding.accelerator, () => broadcast(binding.command))
    } catch {
      ok = false
    }
    if (!ok) failed.push(binding.accelerator)
  }

  // 媒体键：注册失败不算用户配置问题（有些键盘/系统本来就不发），不进 failed
  const media: Array<[string, 'toggle' | 'next' | 'prev']> = [
    ['MediaPlayPause', 'toggle'],
    ['MediaPreviousTrack', 'prev'],
    ['MediaNextTrack', 'next']
  ]
  for (const [accelerator, command] of media) {
    try {
      globalShortcut.register(accelerator, () => broadcast(command))
    } catch {
      /* 忽略 */
    }
  }
  return failed
}
