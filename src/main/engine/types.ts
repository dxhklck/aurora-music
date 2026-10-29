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
  /** 本会话各音源的请求成败计数（设置页用来判断哪个源坏了） */
  health: EngineSourceHealth[]
}

/**
 * 单个音源的健康度。只统计「本次运行期间」的请求结果，不落盘——
 * 上游接口的可用性变化很快，跨启动的历史数据反而会误导判断。
 */
export interface EngineSourceHealth {
  key: string
  label: string
  /** 成功次数 */
  ok: number
  /** 失败次数 */
  fail: number
  /** 最近一次失败原因（成功后清空） */
  lastError: string
  /** 最近一次请求的时间戳；0 表示本次会话还没用过 */
  lastAt: number
}
