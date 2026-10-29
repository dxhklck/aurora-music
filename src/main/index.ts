import { app, BrowserWindow, Menu, globalShortcut } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { writeFile, readFile } from 'node:fs/promises'
import { IPC } from '@shared/ipc'
import { registerMediaScheme, installMediaProtocol } from './protocol'
import { createMainWindow } from './windows'
import { createTray } from './tray'
import { bootstrapProviders, registerEngineProviders } from './providers'
import { setProviderCookies } from './providers/cookies'
import { registerIpc } from './ipc'
import { library } from './services/library'
import { playlists } from './services/playlists'
import { settings } from './services/settings'
import { downloads } from './services/download'
import { runSelfTest } from './selftest'
import { initUpdater } from './updater'

// 自定义协议必须在 app ready 之前登记
registerMediaScheme()

// 无 GPU 的 CI/截图环境
// 注意：这里只关闭硬件加速，必须保留软件光栅化（SwiftShader）。
// 一旦加上 --disable-software-rasterizer，Chromium 的 GPU 进程会因无可用后端而直接崩溃
// （FATAL: GPU process isn't usable），截图与自检模式会连带失效。
// 部分 Windows 机器上 GPU 进程的沙箱初始化会失败（exit_code=-1073741819 / 0xC0000005），
// 因此额外关闭 GPU 进程沙箱——只影响 GPU 子进程，主进程沙箱策略不变。
if (process.env.AURORA_SELFTEST || process.env.AURORA_CAPTURE || process.env.AURORA_HEADLESS) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
}

/**
 * 演示音源目录在不同启动方式下位置不同（打包 / electron-vite dev / electron out/main），
 * 逐个探测第一个存在的路径，避免首次启动就没有离线曲目。
 */
function resolveDemoDir(): string {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'demo'), join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'demo')]
    : [
        join(app.getAppPath(), 'resources', 'demo'),
        join(__dirname, '../../resources/demo'),
        join(process.cwd(), 'resources', 'demo')
      ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[0]
}

// 自检使用独立的 userData，避免污染用户真实的 settings / library / downloads
if (process.env.AURORA_SELFTEST) {
  app.setPath('userData', join(app.getPath('temp'), 'aurora-selftest'))
}

/**
 * 全局媒体快捷键：在任意应用中控制播放。
 * 与托盘菜单复用同一条 IPC 命令通道（命令由渲染进程的 player store 执行）。
 * 组合键被其它程序占用时单个跳过并告警，不阻塞启动；用户可在对应软件里改键位。
 */
function registerGlobalShortcuts(): void {
  const mod = process.platform === 'darwin' ? 'Control+Command' : 'Control+Alt'
  const bindings: Array<[string, 'toggle' | 'next' | 'prev']> = [
    [`${mod}+P`, 'toggle'],
    [`${mod}+Left`, 'prev'],
    [`${mod}+Right`, 'next'],
    // 键盘媒体键：笔记本/耳机的播放暂停键，无需组合键
    ['MediaPlayPause', 'toggle'],
    ['MediaPreviousTrack', 'prev'],
    ['MediaNextTrack', 'next']
  ]
  for (const [accelerator, command] of bindings) {
    const ok = globalShortcut.register(accelerator, () => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send(IPC.trayCommand, command)
        }
      }
    })
    if (!ok) process.stdout.write(`[shortcut] 注册失败（可能被占用）：${accelerator}\n`)
  }
}

async function bootstrapRuntime(): Promise<void> {
  installMediaProtocol()

  // 探针/截图模式可显式指定 userData（裸跑 electron.exe 时应用名解析不到，会落到 Electron 目录）
  if (process.env.AURORA_USER_DATA) app.setPath('userData', process.env.AURORA_USER_DATA)

  bootstrapProviders(resolveDemoDir())

  const defaultDownloadDir = process.env.AURORA_SELFTEST
    ? join(app.getPath('temp'), 'aurora-selftest', 'downloads')
    : join(app.getPath('music'), 'Aurora Music')
  await settings.init(app.getPath('userData'), defaultDownloadDir)
  // 登录态 Cookie：启动时灌入运行时仓库，之后每次请求时由音源适配器读取
  setProviderCookies({
    qq: settings.get().qqCookie,
    netease: settings.get().neteaseCookie
  })
  library.configure(app.getPath('userData'))
  await library.load()
  // 本地音乐：下载目录 + 用户导入的目录。导入新目录时由 IPC 再触发一次扫描。
  library.setScanDirs([settings.get().downloadDir, ...settings.get().musicDirs])
  const imported = await library.scanLocalDirs().catch(() => 0)
  if (imported) process.stdout.write(`[library] 扫描本地目录，新增 ${imported} 首\n`)
  playlists.configure(app.getPath('userData'))
  await playlists.load()

  // 引擎音源：设置里关掉就不注册，避免音源列表出现一堆不可用的平台
  if (settings.get().engineEnabled) registerEngineProviders()

  downloads.configure(app.getPath('userData'))
  await downloads.load()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed())
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // Windows 任务栏分组/通知需要 AppUserModelId
    if (process.platform === 'win32') app.setAppUserModelId('com.aurora.music')
    // macOS 必须保留应用菜单，否则 Cmd+C/V/A/Q 等标准快捷键会失效
    Menu.setApplicationMenu(
      process.platform === 'darwin'
        ? Menu.buildFromTemplate([
            { role: 'appMenu' },
            { role: 'editMenu' },
            { role: 'viewMenu' },
            { role: 'windowMenu' }
          ])
        : null
    )
    await bootstrapRuntime()

    // 无界面自检模式（开发辅助）
    if (process.env.AURORA_SELFTEST) {
      const code = await runSelfTest()
      await downloads.flush().catch(() => undefined)
      app.exit(code)
      return
    }

    registerIpc()
    // 自动更新：仅打包后的 Windows 生效（内部自判，dev/其他平台是空操作）
    initUpdater()

    downloads.on('update', (tasks) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC.downloadProgress, tasks)
      }
    })

    const win = createMainWindow()
    createTray()
    registerGlobalShortcuts()

    // 截图模式（用于文档/回归检查）
    // AURORA_AUTOACCEPT：自动验收（音频元素全程采样），与 capture 同管线但保留硬件加速
    const capturePath = process.env.AURORA_CAPTURE || process.env.AURORA_AUTOACCEPT
    if (capturePath) {
      win.webContents.on('console-message', (...args: any[]) => {
        const detail = args[1]
        const message = typeof detail === 'object' ? detail?.message : args[2]
        const level = typeof detail === 'object' ? detail?.level : args[1]
        if (level === 'error' || level === 3 || level === 2) {
          process.stdout.write(`[renderer:${level}] ${message}\n`)
        }
      })
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const script =
              process.env.AURORA_CAPTURE_SCRIPT ??
              (process.env.AURORA_CAPTURE_SCRIPT_FILE
                ? await readFile(process.env.AURORA_CAPTURE_SCRIPT_FILE, 'utf8')
                : undefined)
            if (script) {
              const result = await win.webContents.executeJavaScript(script, true)
              if (result !== undefined) process.stdout.write(`script result: ${JSON.stringify(result)}\n`)
            }
            const image = await win.webContents.capturePage()
            await writeFile(capturePath, image.toPNG())
            process.stdout.write(`captured: ${capturePath}\n`)
            const others = BrowserWindow.getAllWindows().filter(
              (item) => item !== win && !item.isDestroyed()
            )
            for (const [index, other] of others.entries()) {
              const shot = await other.webContents.capturePage()
              await writeFile(`${capturePath}.win${index}.png`, shot.toPNG())
              process.stdout.write(`captured window ${index}: ${other.getTitle()}\n`)
            }
          } catch (error) {
            process.stdout.write(`capture failed: ${String(error)}\n`)
          }
          app.exit(0)
        }, 2600)
      })
    }

    app.on('activate', () => {
      if (!BrowserWindow.getAllWindows().length) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // 退出前把下载队列刷盘，避免丢状态
  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    globalShortcut.unregisterAll()
    event.preventDefault()
    void (async () => {
      await downloads.flush().catch(() => undefined)
      app.exit(0)
    })()
  })
}
