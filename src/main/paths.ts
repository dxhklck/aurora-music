import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * 路径解析。
 *
 * 坑：直接用 `electron out/main/index.js` 启动时，`app.getAppPath()` 返回的是
 * `out/main`（入口文件所在目录），不是仓库根目录。所有资源路径都必须用这里算出来的
 * 根目录，否则打包后能找到、开发时反而找不到（或反之）。
 */
export function appRoot(): string {
  if (app.isPackaged) return process.resourcesPath
  // __dirname = <root>/out/main
  return join(__dirname, '..', '..')
}

/** 引擎目录（bridge.py 与虚拟环境所在处） */
export function engineDir(): string {
  const candidates = [join(appRoot(), 'engine'), join(process.resourcesPath ?? '', 'engine')]
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

export function bridgeScript(): string {
  const candidates = [join(engineDir(), 'musicdl', 'bridge.py'), join(appRoot(), 'engine', 'musicdl', 'bridge.py')]
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

/** 引擎自愈脚本（与 bridge.py 同目录，随包分发） */
export function repairScript(): string {
  return join(bridgeScript(), '..', 'repair_vendor.py')
}

/** 随包 vendor 的 musicdl 源码目录（自愈写入目标，优先级低于环境变量） */
export function vendoredMusicdlDir(): string {
  return join(engineDir(), 'vendor', 'musicdl')
}

/** musicdl 源码目录候选（按优先级）：环境变量 → 随包内置 → 同级仓库 → vendor */
export function musicdlDirs(): string[] {
  const list: string[] = []
  const push = (path: string): void => {
    if (path && existsSync(join(path, 'musicdl', '__init__.py')) && !list.includes(path)) list.push(path)
  }
  push(process.env.AURORA_MUSICDL_PATH ?? '')
  if (process.resourcesPath) push(join(process.resourcesPath, 'musicdl'))
  push(join(engineDir(), 'vendor', 'musicdl'))
  push(join(appRoot(), '..', 'musicdl'))
  push(join(appRoot(), '..', '..', 'musicdl'))
  return list
}
