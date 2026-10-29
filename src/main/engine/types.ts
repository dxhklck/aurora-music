/** 引擎层公共类型：运行时信息与状态 */

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
}
