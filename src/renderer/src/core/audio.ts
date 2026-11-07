import { wave } from './wave'

type Handler = (payload: any) => void

/**
 * 播放引擎：对 HTMLAudioElement 的一层薄封装。
 * - 统一事件（time / duration / ended / playing / error / buffered）
 * - 切歌淡入淡出，避免爆音；交叉淡化用双元素同时升降
 * - 提供高精度 currentTime 供歌词时钟使用
 *
 * 淡入淡出的不变量：
 * 1. 淡入挂在 play() 承诺兑现后（规范上 = 真正开始出声的那一刻），
 *    不等更早的时机；播放被拒时先把音量归位再报错，避免滑块与实况不一致。
 * 2. 音量插值用定时器而不是 rAF：窗口最小化/被遮挡时 rAF 停摆，
 *    淡入会卡在半路（音量 0），同样表现为"在放但没声"。
 * 3. 音量/静音必须**同时**写给元素和音频图：元素一旦被
 *    `createMediaElementSource` 接管（打开过「正在播放」舞台就会），
 *    `el.volume` / `el.muted` 就失效了，只改元素等于没改。
 *
 * 双元素：`els[activeIdx]` 是「当前曲目」。交叉淡化把下一曲装进另一个元素，
 * 淡入完成后翻转 activeIdx；事件监听带 `from()` 门，非当前元素的事件一律忽略，
 * 否则旧元素到点触发的 ended 会把刚切过去的歌再跳走一次。
 */
class AudioEngine {
  private els: [HTMLAudioElement, HTMLAudioElement]
  private activeIdx = 0
  private handlers = new Map<string, Set<Handler>>()
  private fadeTimer: number | null = null
  private xfTimer: number | null = null
  private targetVolume = 0.75
  private muted = false
  /** 播放速率（0.5~2）。playbackRate 是元素属性，换 src / load 不清零，两个元素各设一次即可 */
  private rate = 1
  /** 每个元素的当前电平（0~targetVolume）。音频图接管后 el.volume 失效，只能记在引擎里 */
  private levels: [number, number] = [0.75, 0.75]
  private ready = false
  /** 停滞看门狗：waiting/play 后若长时间无进度，报告 stall（数据不来但连接未断，error 事件不会触发） */
  private stallTimer: number | null = null
  private stallBaseTime = 0
  private stallBaseBuffered = 0

  constructor() {
    const make = (): HTMLAudioElement => {
      const el = new Audio()
      el.preload = 'auto'
      // 频谱可视化依赖 MediaElementAudioSourceNode：不带 crossOrigin 的媒体算跨域脏数据，
      // analyser 读出来全是 0（muse:// 代理已统一补 CORS 响应头，anonymous 请求即可通过）
      el.crossOrigin = 'anonymous'
      return el
    }
    this.els = [make(), make()]
    this.levels = [this.targetVolume, this.targetVolume]
    this.applyVolume(this.targetVolume)
    this.bind()
  }

  /** 当前元素的统一入口：所有「对当前曲目」的操作都落到它 */
  private get el(): HTMLAudioElement {
    return this.els[this.activeIdx]
  }

  private bind(): void {
    for (const el of this.els) {
      const gate = (fn: () => void): void => {
        // 双元素并行时只放行当前元素的事件；旧元素淡出期的 paused/ended 不能漏进来
        if (el === this.els[this.activeIdx]) fn()
      }
      el.addEventListener('timeupdate', () => gate(() => this.emit('time', el.currentTime * 1000)))
      el.addEventListener('durationchange', () =>
        gate(() => this.emit('duration', Number.isFinite(el.duration) ? el.duration * 1000 : 0))
      )
      el.addEventListener('loadedmetadata', () =>
        gate(() => this.emit('duration', Number.isFinite(el.duration) ? el.duration * 1000 : 0))
      )
      el.addEventListener('progress', () => {
        gate(() => {
          if (!el.buffered.length) return
          this.emit('buffered', el.buffered.end(el.buffered.length - 1) * 1000)
        })
      })
      el.addEventListener('ended', () => gate(() => {
        this.stopStallWatch()
        this.emit('ended', null)
      }))
      el.addEventListener('play', () => gate(() => this.emit('playing', true)))
      el.addEventListener('playing', () =>
        gate(() => {
          this.stopStallWatch()
          this.emit('waiting', false)
        })
      )
      el.addEventListener('pause', () =>
        gate(() => {
          this.stopStallWatch()
          this.emit('playing', false)
          this.emit('waiting', false)
        })
      )
      el.addEventListener('waiting', () =>
        gate(() => {
          this.emit('waiting', true)
          this.startStallWatch()
        })
      )
      el.addEventListener('error', () =>
        gate(() => {
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
      )
    }
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
    this.stopCrossfade()
    this.stopStallWatch()
    // 两个都停：另一个元素可能装着交叉淡化残留的 src，不清会占解码器
    for (const el of this.els) el.pause()
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
    this.stopCrossfade()
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
    this.stopCrossfade()
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
    this.stopCrossfade()
    for (const el of this.els) el.pause()
    this.el.removeAttribute('src')
    this.el.load()
    this.ready = false
  }

  /**
   * 交叉淡化到新曲目。调用前提：当前正在播放、剩余时间足够（由 store 校验）。
   * 新元素 play() 兑现（= 真出声）才翻转 activeIdx；失败返回 false，调用方回退自然衔接。
   * 手动操作（load/play/pause/stop/seek）都会先 stopCrossfade——淡化只服务自动换曲。
   */
  async crossfadeTo(url: string, ms: number): Promise<boolean> {
    if (!this.ready || ms <= 0) return false
    const fromIdx = this.activeIdx
    const fromEl = this.els[fromIdx]
    if (fromEl.paused || !Number.isFinite(fromEl.duration)) return false
    const toIdx = fromIdx === 0 ? 1 : 0
    const toEl = this.els[toIdx]
    this.stopFade()
    toEl.pause()
    toEl.src = url
    toEl.load()
    this.setElementLevel(toIdx, 0)
    try {
      await toEl.play()
    } catch {
      // 新曲起不来：恢复现场，让旧曲继续放到自然结束
      this.setElementLevel(toIdx, this.targetVolume)
      toEl.removeAttribute('src')
      toEl.load()
      return false
    }
    this.activeIdx = toIdx
    const startedAt = performance.now()
    const fromLevel = this.levels[fromIdx]
    const target = this.targetVolume
    this.xfTimer = window.setInterval(() => {
      const progress = Math.max(0, Math.min(1, (performance.now() - startedAt) / ms))
      this.setElementLevel(toIdx, target * progress)
      this.setElementLevel(fromIdx, fromLevel * (1 - progress))
      if (progress >= 1) {
        this.stopCrossfadeTimer()
        fromEl.pause()
        // 旧元素电平归位：它现在是「待命元素」，下次淡化从满电平出发
        this.setElementLevel(fromIdx, target)
      }
    }, 16)
    this.startStallWatch()
    return true
  }

  /** 中止交叉淡化：定时器停、待命元素清干净（正在淡出的那个保持原状） */
  private stopCrossfade(): void {
    this.stopCrossfadeTimer()
    const standby = this.els[this.activeIdx === 0 ? 1 : 0]
    if (standby) {
      standby.pause()
    }
  }

  private stopCrossfadeTimer(): void {
    if (this.xfTimer !== null) {
      window.clearInterval(this.xfTimer)
      this.xfTimer = null
    }
  }

  /**
   * 设单元素电平（0~targetVolume）。两条路径与 setGain/setSink 同理：
   * 无音频图时 el.volume 直接生效；有图时 el.volume 被忽略，
   * 必须走分支增益（按 targetVolume 归一成比例）。
   */
  private setElementLevel(index: number, level: number): void {
    const clamped = Math.max(0, Math.min(this.targetVolume, Number.isFinite(level) ? level : 0))
    this.levels[index] = clamped
    const el = this.els[index]
    if (el) el.volume = clamped
    wave.setBranch(index, this.targetVolume > 0 ? clamped / this.targetVolume : 0)
  }

  seek(ms: number): void {
    const el = this.el
    if (!Number.isFinite(el.duration)) return
    const target = Math.max(0, Math.min(ms / 1000, el.duration - 0.05))
    if (el.paused || this.fadeTimer !== null || this.xfTimer !== null) {
      this.stopFade()
      this.stopCrossfade()
      el.currentTime = target
      return
    }
    // seek 防爆音：跳转点两侧若有波形断差，直接改 currentTime 会「啪」一声。
    // 播放中先 30ms 淡出 → 跳转 → 60ms 淡回原音量；复用 fadeTimer 的 16ms 步进。
    const from = el.volume
    let startedAt = performance.now()
    let seeked = false
    const step = (): void => {
      const progress = Math.max(0, Math.min(1, (performance.now() - startedAt) / (seeked ? 60 : 30)))
      this.applyVolume(seeked ? from * progress : from * (1 - progress))
      if (progress < 1) return
      if (!seeked) {
        el.currentTime = target
        seeked = true
        startedAt = performance.now()
        return
      }
      this.stopFade()
      this.fadeTimer = null
    }
    this.fadeTimer = window.setInterval(step, 16)
  }

  setVolume(volume: number): void {
    this.targetVolume = Math.max(0, Math.min(1, volume))
    // 手动改音量必须打断正在跑的淡入/淡出/交叉淡化：定时器每 16ms 会用插值覆盖音量，
    // 不打断的话用户刚拖到的值会在几帧内被拉回去（表现为「滑块动了但声音没变」）
    this.stopFade()
    this.stopCrossfade()
    this.applyVolume(this.targetVolume)
  }

  /** 浏览器对 volume 的合法区间是 [0,1]，淡入淡出插值时严防越界 */
  private applyVolume(value: number): void {
    if (!Number.isFinite(value)) return
    const clamped = Math.max(0, Math.min(1, value))
    this.el.volume = clamped
    this.levels[this.activeIdx] = clamped
    // 音频图接管后元素音量失效，必须同步到 master；未挂接时是空操作
    wave.setGain(clamped)
  }

  setMuted(muted: boolean): void {
    this.muted = Boolean(muted)
    for (const el of this.els) el.muted = this.muted
    wave.setMuted(this.muted)
  }

  /**
   * 播放速率（0.5~2.0）。HTMLAudioElement 的 playbackRate 默认变速不变调
   * （preservesPitch 走 time-stretch），练听力 / 跟唱 / 快进式听书直接可用。
   * 两个元素都要设：交叉淡化期间下一曲从另一个元素播放，速率不一致会突然变速。
   */
  setRate(rate: number): void {
    this.rate = Number.isFinite(rate) ? Math.max(0.5, Math.min(2, rate)) : 1
    for (const el of this.els) el.playbackRate = this.rate
  }

  /**
   * 切换音频输出设备（sinkId，'' = 系统默认）。
   *
   * 两条路径必须分开：音频图挂接后输出由 AudioContext 决定，对已接管的元素调
   * `setSinkId` 会抛 InvalidStateError；未挂接时反过来只有元素能决定输出。
   * 返回值 = 是否真的切换成功（设备被拔出、系统不支持时为 false）。
   */
  async setOutputDevice(deviceId: string): Promise<boolean> {
    // 先写进音频图缓存：之后才打开播放舞台（attach）时也能按当前设备重新应用
    if (wave.setSink(deviceId)) return true
    try {
      await this.el.setSinkId(deviceId)
      return true
    } catch {
      return false
    }
  }

  /**
   * 音频图挂接后由调用方（NowPlaying）补一次同步：
   * master 音量、静音态、两个分支的电平都按引擎当前值灌进去。
   * 挂接本身可能发生在播放中途甚至交叉淡化进行中，靠元素自身状态初始化会错。
   */
  syncGraph(): void {
    if (!wave.state.attached) return
    wave.setGain(this.targetVolume)
    wave.setMuted(this.muted)
    for (const index of [0, 1] as const) {
      wave.setBranch(index, this.targetVolume > 0 ? this.levels[index] / this.targetVolume : 0)
    }
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

  /**
   * 音频图挂接用的两个元素，按固定位置返回：分支 0 ↔ els[0]，分支 1 ↔ els[1]。
   * 不能随 activeIdx 翻转——分支编号是挂接时就定死的，翻了就对不上号。
   */
  get mediaEl(): HTMLAudioElement {
    return this.els[0]
  }

  /** 音频图第二个分支对应的元素（与 mediaEl 一起传给 wave.attach） */
  get secondaryEl(): HTMLAudioElement {
    return this.els[1]
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
