/** 引擎层公共类型：运行时信息与错误分类 */

export interface EngineRuntimeInfo {
  /** 可执行文件路径或 PATH 上的命令名 */
  command: string
  /** 人类可读的来源说明，用于设置页展示 */
  label: string
  version?: string
  /** 引擎自报的可用音源数量 */
  sources?: number
}

export interface EngineStatus {
  ready: boolean
  runtime: EngineRuntimeInfo | null
  error: string
  log: string[]
  /** 引擎脚本与 musicdl 源码是否就位（决定要不要引导用户安装依赖） */
  bridgeFound: boolean
  musicdlFound: boolean
  /** 安装版与开发版的补救办法不一样，文案要分开 */
  packaged: boolean
}

/** Python 运行时缺失 / 进程崩溃 / 管道不可写，都属于这一类 */
export class EngineUnavailableError extends Error {
  readonly code = 'engine_unavailable'

  constructor(message: string) {
    super(message)
    this.name = 'EngineUnavailableError'
  }
}
