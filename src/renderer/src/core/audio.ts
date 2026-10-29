import { wave } from './wave'

type Handler = (payload: any) => void

/**
 * 播放引擎：对 HTMLAudioElement 的一层薄封装。
 * - 统一事件（time / duration / ended / playing / error / buffered）
 * - 切歌淡入淡出，避免爆音
 * - 提供高精度 currentTime 供歌词时钟使用
 *
 * 淡入淡出的两个不变量：
 * 1. 淡入挂在 play() 承诺兑现后（规范上 = 真正开始出声的那一刻），
 *    不等更早的时机；播放被拒时先把音量归位再报错，避免滑块与实况不一致。
 * 2. 音量插值用定时器而不是 rAF：窗口最小化/被遮挡时 rAF 停摆，
 *    淡入会卡在半路（音量 0），同样表现为"在放但没声"。
 * 3. 音量/静音必须**同时**写给元素和音频图里的 GainNode：元素一旦被
 *    `createMediaElementSource` 接管（打开过「正在播放」舞台就会），
 *    `el.volume` / `el.muted` 就失效了，只改元素等于没改。
 */
class AudioEngine {
  private el: HTMLAudioElement
  private handlers = new Map<string, Set<Handler>>()
  private fadeTimer: number | null = null
  private targetVolume = 0.75
  private ready = false
  /** 停滞看门狗：waiting/play 后若长时间无进度，报告 stall（数据不来但连接未断，error 事件不会触发） */
  private stallTimer: number | null = null
  private stallBaseTime = 0
  private stallBaseBuffered = 0

  constructor() {
    this.el = new Audio()
    this.el.preload = 'auto'
    // 频谱可视化依赖 MediaElementAudioSourceNode：不带 crossOrigin 的媒体算跨域脏数据，
    // analyser 读出来全是 0（muse:// 代理已统一补 CORS 响应头，anonymous 请求即可通过）
    this.el.crossOrigin = 'anonymous'
    this.applyVolume(this.targetVolume)
    this.bind()
  }

  private bind(): void {
    const el = this.el
    el.addEventListener('timeupdate', () => this.emit('time', el.currentTime * 1000))
    el.addEventListener('durationchange', () =>
      this.emit('duration', Number.isFinite(el.duration) ? el.duration * 1000 : 0)
    )
    el.addEventListener('loadedmetadata', () =>
      this.emit('duration', Number.isFinite(el.duration) ? el.duration * 1000 : 0)
    )
    el.addEventListener('progress', () => {
      if (!el.buffered.length) return
      this.emit('buffered', el.buffered.end(el.buffered.length - 1) * 1000)
    })
    el.addEventListener('ended', () => {
      this.stopStallWatch()
      this.emit('ended', null)
    })
    el.addEventListener('play', () => this.emit('playing', true))
    el.addEventListener('playing', () => {
      this.stopStallWatch()
      this.emit('waiting', false)
    })
    el.addEventListener('pause', () => {
      this.stopStallWatch()
      this.emit('playing', false)
      this.emit('waiting', false)
    })
    el.addEventListener('waiting', () => {
      this.emit('waiting', true)
      this.startStallWatch()
    })
    el.addEventListener('error', () => {
      this.stopStallWatch()
      const code = el.error?.code
      const message =
        code === 4
          ? '音频加载失败，可能是版权限制或链接过期'
          : code === 2
            ? '网络中断，音频加载失败'
            : '播放出错，请尝试切换歌曲或音源'
      this.emit('waiting', false)
      this.emit('error', message)
    })
  }

  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
    return () => this.handlers.get(event)?.delete(handler)
  }

  private emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.forEach((handler) => handler(payload))
  }

  load(url: string, options: { autoplay?: boolean } = {}): void {
    this.stopFade()
    this.stopStallWatch()
    this.el.pause()
    this.el.src = url
    this.el.load()
    this.ready = true
    this.emit('waiting', false)
    if (options.autoplay) {
      this.applyVolume(0)
      this.startStallWatch()
      void this.el
        .play()
        .then(() => this.fadeTo(this.targetVolume, 420))
        .catch(() => {
          this.applyVolume(this.targetVolume)
          // play() 拒绝不全是自动播放拦截：元素加载失败（如文件损坏）时
          // error 事件先到，error.code 比笼统的"被拦截"更有诊断价值
          const code = this.el.error?.code
          const message =
            code === 4
              ? '音频文件损坏或格式不受支持，请重新下载'
              : code === 2
                ? '网络中断，音频加载失败'
                : '自动播放被拦截，请手动点击播放'
          this.emit('error', message)
        })
    }
  }

  async play(): Promise<void> {
    if (!this.ready) return
    this.stopFade()
    this.applyVolume(0)
    this.startStallWatch()
    try {
      await this.el.play()
    } catch (error) {
      this.stopStallWatch()
      this.applyVolume(this.targetVolume)
      throw error
    }
    this.fadeTo(this.targetVolume, 320)
  }

  pause(): void {
    this.stopFade()
    const from = this.el.volume
    const startedAt = performance.now()
    const step = (): void => {
      const progress = Math.max(0, Math.min(1, (performance.now() - startedAt) / 220))
      this.applyVolume(from * (1 - progress))
      if (progress >= 1) {
        this.stopFade()
        this.el.pause()
      }
    }
    this.fadeTimer = window.setInterval(step, 16)
  }

  stop(): void {
    this.stopStallWatch()
    this.el.pause()
    this.el.removeAttribute('src')
    this.el.load()
    this.ready = false
  }

  seek(ms: number): void {
    if (!Number.isFinite(this.el.duration)) return
    this.el.currentTime = Math.max(0, Math.min(ms / 1000, this.el.duration - 0.05))
  }

  setVolume(volume: number): void {
    this.targetVolume = Math.max(0, Math.min(1, volume))
    // 手动改音量必须打断正在跑的淡入/淡出：fadeTo 每 16ms 会用插值覆盖 el.volume，
    // 不打断的话用户刚拖到的值会在几帧内被拉回去（表现为「滑块动了但声音没变」）
    this.stopFade()
    this.applyVolume(this.targetVolume)
  }

  /** 浏览器对 volume 的合法区间是 [0,1]，淡入淡出插值时严防越界 */
  private applyVolume(value: number): void {
    if (!Number.isFinite(value)) return
    const clamped = Math.max(0, Math.min(1, value))
    this.el.volume = clamped
    // 音频图接管后元素音量失效，必须同步到 GainNode；未挂接时是空操作
    wave.setGain(clamped)
  }

  setMuted(muted: boolean): void {
    this.el.muted = muted
    wave.setMuted(muted)
  }

  private fadeTo(target: number, duration: number): void {
    this.stopFade()
    const from = this.el.volume
    const startedAt = performance.now()
    const step = (): void => {
      const progress = Math.max(0, Math.min(1, (performance.now() - startedAt) / duration))
      this.applyVolume(from + (target - from) * progress)
      if (progress >= 1) this.stopFade()
    }
    this.fadeTimer = window.setInterval(step, 16)
  }

  private stopFade(): void {
    if (this.fadeTimer !== null) {
      window.clearInterval(this.fadeTimer)
      this.fadeTimer = null
    }
  }

  /**
   * 停滞看门狗：arm 后 15s 检查一次——播放位置或缓冲有推进就继续观察，
   * 完全没动静则发出 stall 事件。覆盖「连接正常但数据不来」的停顿，
   * 这种停顿 error 事件永远不触发，表现为 UI 在放、实际静音。
   */
  private startStallWatch(): void {
    this.stopStallWatch()
    this.stallBaseTime = this.el.currentTime
    this.stallBaseBuffered = this.bufferedEnd()
    this.stallTimer = window.setTimeout(() => {
      this.stallTimer = null
      const advanced =
        this.el.currentTime > this.stallBaseTime + 0.05 || this.bufferedEnd() > this.stallBaseBuffered
      if (advanced) {
        this.startStallWatch()
        return
      }
      this.emit('waiting', false)
      this.emit('stall', null)
    }, 15_000)
  }

  private stopStallWatch(): void {
    if (this.stallTimer !== null) {
      window.clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  private bufferedEnd(): number {
    try {
      return this.el.buffered.length ? this.el.buffered.end(this.el.buffered.length - 1) : 0
    } catch {
      return 0
    }
  }

  get currentTime(): number {
    return this.el.currentTime * 1000
  }

  get duration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration * 1000 : 0
  }

  get paused(): boolean {
    return this.el.paused
  }

  /** 底层媒体元素（频谱可视化创建 MediaElementSource 用；别用来改播放状态） */
  get mediaEl(): HTMLAudioElement {
    return this.el
  }
}

export const audio = new AudioEngine()

// 调试钩子（仅 dev 构建生效）：CDP 诊断用——音频元素是游离节点，不在 DOM 里，
// 外部诊断需要 window.__audio 才能摸到它。
//
// 注意：下面的 tripwire 会接管 el.volume / el.muted 的存取器（转发给原生属性后再记录，
// 不改变行为），并起一个 250ms 的轮询定时器。生产构建不需要这些开销，因此只在 dev 启用。
if (import.meta.env.DEV) {
  ;(window as unknown as { __audio?: AudioEngine }).__audio = audio

  // 取证 tripwire：谁改了音量/静音/挂起，就把改动值和调用堆栈打到 console.error
  // （配 ELECTRON_ENABLE_LOGGING=1 时进 stderr，可从 dev 终端日志直接取证）
  const el = (audio as unknown as { el: HTMLAudioElement }).el
  const sink: { at: number; msg: string; stack: string }[] = []
  ;(window as unknown as { __diag?: typeof sink }).__diag = sink
  const diag = (msg: string): void => {
    const stack = new Error().stack?.split('\n').slice(1, 6).join('\n') ?? ''
    sink.push({ at: Date.now(), msg, stack })
    console.error(`[audio-diag] ${msg}\n${stack}`)
  }
  for (const prop of ['volume', 'muted'] as const) {
    // 取原生描述符，set 时先转发再记录——否则「只记录不生效」的诊断本身就成了 bug
    const native = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop)
    let value: number | boolean = el[prop]
    Object.defineProperty(el, prop, {
      get: () => value,
      set: (next: number | boolean) => {
        native?.set?.call(el, next)
        const actual = (native?.get?.call(el) ?? next) as number | boolean
        if (actual !== value) {
          value = actual
          diag(`${prop} -> ${String(actual)}`)
        }
      },
      configurable: true
    })
  }
  const pauseDiag = el.pause.bind(el)
  el.pause = (...args: unknown[]) => {
    diag('pause() 被调用')
    return (pauseDiag as (...a: unknown[]) => HTMLAudioElement)(...args)
  }
  let lastSrc = el.src
  // HMR 会重复执行本模块，先清掉上一轮，避免 dev 下定时器越叠越多
  const w = window as unknown as { __diagTimer?: number }
  if (w.__diagTimer) window.clearInterval(w.__diagTimer)
  w.__diagTimer = window.setInterval(() => {
    if (el.src !== lastSrc) {
      lastSrc = el.src
      diag(`src -> ${el.src.slice(0, 80)}`)
    }
  }, 250)
  ;['pause', 'emptied', 'stalled', 'suspend', 'error'].forEach((t) =>
    el.addEventListener(t, () => {
      if (t !== 'pause' || !el.paused) return
      diag(`事件 ${t}（readyState=${el.readyState}, ct=${Math.round(el.currentTime * 1000)}）`)
    })
  )
}
