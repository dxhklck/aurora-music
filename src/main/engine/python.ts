import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { bridgeScript, engineDir, musicdlDirs } from '../paths'
import { settings } from '../services/settings'
import { EngineUnavailableError, type EngineRuntimeInfo } from './types'

/** 引擎帧：一行一个 JSON，与 engine/musicdl/bridge.py 的协议一一对应 */
interface EngineFrame {
  id?: number
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string; trace?: string }
  event?: string
  taskId?: string
  [key: string]: unknown
}

interface PendingCall {
  cmd: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  /** 流式调用的中途推送（如搜索逐首返回） */
  onPartial?: (frame: EngineFrame) => void
}

export interface EngineEvent {
  event: string
  taskId?: string
  received?: number
  total?: number
  done?: boolean
  message?: string
}

const HANDSHAKE_TIMEOUT = 25_000
const DEFAULT_TIMEOUT = 45_000
const MAX_LOG_LINES = 60

/**
 * Python 运行时探测。
 *
 * 优先顺序：显式环境变量 → 打包内置 → 项目虚拟环境 → 系统 PATH。
 * 每一档都要真正把桥拉起来（收到 ready 帧）才算可用，避免「文件存在但依赖缺失」
 * 这类假阳性——用户看到「引擎已就绪」就应该真的能搜到歌。
 */
function pythonCandidates(): EngineRuntimeInfo[] {
  const list: EngineRuntimeInfo[] = []
  const push = (command: string, label: string): void => {
    if (!command) return
    if (command.includes('/') || command.includes('\\')) {
      if (!existsSync(command)) return
    }
    if (list.some((item) => item.command === command)) return
    list.push({ command, label })
  }

  // 设置页手动指定的解释器优先级最高——安装版没有 npm 脚本，这是唯一的自助入口
  try {
    push(settings.get().pythonPath ?? '', '设置中指定的解释器')
  } catch {
    /* 设置还没初始化（启动早期），跳过 */
  }
  push(process.env.AURORA_PYTHON ?? '', '环境变量 AURORA_PYTHON')

  const exe = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3'
  push(join(engineDir(), '.venv', exe), '项目虚拟环境')
  push(join(engineDir(), 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'), '项目内置 Python')
  if (process.resourcesPath) {
    push(join(process.resourcesPath, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'), '随应用内置的 Python')
  }

  if (process.platform === 'win32') {
    push('python', '系统 python')
    push('py', '系统 py 启动器')
  } else {
    push('python3', '系统 python3')
    push('python', '系统 python')
  }
  return list
}

/** musicdl 源码目录：打包内置 → 同级仓库 → 引擎目录下的 vendor */
function musicdlCandidates(): string[] {
  return musicdlDirs()
}

/**
 * musicdl 引擎进程。
 *
 * 设计要点：
 * - **懒启动**：只有真正用到 musicdl 音源时才拉进程，纯本地播放不付出任何代价；
 * - **单进程多并发**：请求用自增 id 复用同一条 stdin，Python 侧线程池并发处理；
 * - **崩溃可恢复**：进程退出后把未完成的调用全部拒绝，下次调用自动重启；
 * - **stderr 只做诊断**：协议帧走 stdout，引擎的日志/进度条全在 stderr，不解析。
 */
class PythonEngine {
  private child: ChildProcess | null = null
  private buffer = ''
  private seed = 0
  private pending = new Map<number, PendingCall>()
  private listeners = new Set<(event: EngineEvent) => void>()
  private starting: Promise<EngineRuntimeInfo> | null = null
  private runtime: EngineRuntimeInfo | null = null
  private ready = false
  private lastError = ''
  private logLines: string[] = []
  private disposed = false

  isReady(): boolean {
    return this.ready && !!this.child && !this.child.killed
  }

  status(): { ready: boolean; runtime: EngineRuntimeInfo | null; error: string; log: string[] } {
    return { ready: this.isReady(), runtime: this.runtime, error: this.lastError, log: [...this.logLines] }
  }

  onEvent(cb: (event: EngineEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 确保进程可用；并发调用共享同一次启动 */
  async ensure(): Promise<EngineRuntimeInfo> {
    if (this.isReady() && this.runtime) return this.runtime
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(): Promise<EngineRuntimeInfo> {
    if (this.disposed) throw new EngineUnavailableError('引擎已关闭')
    const script = bridgeScript()
    if (!existsSync(script)) throw new EngineUnavailableError(`找不到引擎脚本：${script}`)

    const musicdlPath = musicdlCandidates()[0] ?? ''
    const errors: string[] = []
    this.lastError = ''

    for (const candidate of pythonCandidates()) {
      // 每个候选单独试，fatal 帧里的原因只对本次尝试有效
      this.lastError = ''
      try {
        const runtime = await this.spawnWith(candidate, script, musicdlPath)
        this.runtime = runtime
        this.ready = true
        this.lastError = ''
        return runtime
      } catch (error) {
        errors.push(`${candidate.label}（${candidate.command}）：${(error as Error).message}`)
      }
    }

    this.lastError = errors.join('；') || '未找到可用的 Python 运行时'
    throw new EngineUnavailableError(this.lastError)
  }

  private spawnWith(
    candidate: EngineRuntimeInfo,
    script: string,
    musicdlPath: string
  ): Promise<EngineRuntimeInfo> {
    return new Promise<EngineRuntimeInfo>((resolve, reject) => {
      const args = ['-u', script, '--work-dir', join(app.getPath('temp'), 'aurora-musicdl')]
      if (musicdlPath) args.push('--musicdl-path', musicdlPath)

      let child: ChildProcess
      try {
        child = spawn(candidate.command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
        })
      } catch (error) {
        reject(error)
        return
      }

      this.child = child
      this.buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error('引擎启动超时（25s）'))
      }, HANDSHAKE_TIMEOUT)

      const onReady = (frame: EngineFrame): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ready = true
        resolve({ ...candidate, version: String(frame.version ?? ''), sources: Number(frame.sources ?? 0) })
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        this.consume(chunk, onReady)
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        this.appendLog(chunk)
      })
      child.on('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
        this.handleExit(`进程错误：${error.message}`)
      })
      child.on('exit', (code, signal) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          // 桥在退出前会先发一帧 fatal 说明原因（比如缺 musicdl 依赖），
          // 有的话就用它，比光秃秃的退出码有用得多
          reject(new Error(this.lastError || `进程退出 code=${code} signal=${signal}`))
        }
        this.handleExit(`引擎退出（code=${code}）`)
      })
    })
  }

  private appendLog(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim()
      if (!text) continue
      this.logLines.push(text)
    }
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines = this.logLines.slice(-MAX_LOG_LINES)
    }
  }

  private consume(chunk: string, onReady?: (frame: EngineFrame) => void): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (!line) continue
      let frame: EngineFrame
      try {
        frame = JSON.parse(line) as EngineFrame
      } catch {
        // 非协议输出（理论上不该出现）当作诊断日志
        this.appendLog(line)
        continue
      }
      this.dispatch(frame, onReady)
    }
  }

  private dispatch(frame: EngineFrame, onReady?: (frame: EngineFrame) => void): void {
    if (frame.event === 'ready') {
      onReady?.(frame)
      return
    }
    if (frame.event === 'partial') {
      // 流式推送：只投递给发起该请求的调用方，不广播
      if (typeof frame.id === 'number') this.pending.get(frame.id)?.onPartial?.(frame)
      return
    }
    if (frame.event === 'progress' || frame.event === 'error' || frame.event === 'fatal') {
      if (frame.event === 'fatal') {
        const hint = typeof frame.hint === 'string' ? frame.hint : ''
        const message = String(frame.message ?? '引擎启动失败')
        this.lastError = hint ? `${message}（${hint}）` : message
      }
      const event: EngineEvent = {
        event: frame.event,
        taskId: frame.taskId,
        received: typeof frame.received === 'number' ? frame.received : undefined,
        total: typeof frame.total === 'number' ? frame.total : undefined,
        done: frame.done === true,
        message: typeof frame.message === 'string' ? frame.message : undefined
      }
      for (const listener of this.listeners) listener(event)
      return
    }
    if (typeof frame.id !== 'number') return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    this.pending.delete(frame.id)
    clearTimeout(pending.timer)
    if (frame.ok) pending.resolve(frame.result)
    else {
      const code = frame.error?.code ?? 'internal'
      const message = frame.error?.message ?? '引擎调用失败'
      if (frame.error?.trace) this.appendLog(String(frame.error.trace))
      pending.reject(new EngineCallError(code, message, pending.cmd))
    }
  }

  private handleExit(reason: string): void {
    this.ready = false
    this.child = null
    // 启动阶段桥已经用 fatal 帧说明过原因（如缺依赖），别被退出码盖掉
    if (!this.lastError) this.lastError = reason
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new EngineUnavailableError(`${reason}（${pending.cmd}）`))
    }
    this.pending.clear()
  }

  async call<T>(cmd: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT): Promise<T> {
    return this.callStream<T>(cmd, params, undefined, timeoutMs)
  }

  /**
   * 带中途推送的调用。目前只有 search 用：引擎每解析出一首就推一条，
   * 前端可以先渲染再等收尾，不必盯着骨架屏干等十几秒。
   */
  async callStream<T>(
    cmd: string,
    params: Record<string, unknown>,
    onPartial?: (items: unknown[]) => void,
    timeoutMs = DEFAULT_TIMEOUT
  ): Promise<T> {
    await this.ensure()
    const child = this.child
    if (!child?.stdin?.writable) throw new EngineUnavailableError('引擎管道不可写')

    const id = ++this.seed
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EngineCallError('timeout', `${cmd} 超时（${Math.round(timeoutMs / 1000)}s）`, cmd))
      }, timeoutMs)

      this.pending.set(id, {
        cmd,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        onPartial: onPartial
          ? (frame) => {
              const items = (frame as { items?: unknown }).items
              if (Array.isArray(items) && items.length) onPartial(items)
            }
          : undefined
      })

      try {
        child.stdin!.write(`${JSON.stringify({ id, cmd, params })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error as Error)
      }
    })
  }

  /** 关掉当前进程但保留可重启能力（设置页「重新检测」用） */
  async stop(): Promise<void> {
    const child = this.child
    this.ready = false
    if (!child) return
    try {
      child.stdin?.write(`${JSON.stringify({ id: ++this.seed, cmd: 'shutdown' })}\n`)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.stop()
  }
}

/** 引擎返回的业务错误（可区分「没找到」「无版权」「超时」） */
export class EngineCallError extends Error {
  readonly code: string
  readonly cmd: string

  constructor(code: string, message: string, cmd = '') {
    super(message)
    this.name = 'EngineCallError'
    this.code = code
    this.cmd = cmd
  }
}

export const engine = new PythonEngine()
