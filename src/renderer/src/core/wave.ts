/**
 * 频谱引擎：把 Web Audio AnalyserNode 接到播放元素上。
 * - 懒创建（第一次打开「正在播放」舞台时挂接），全局单例，之后复用
 * - 播放中 analyser 读数持续全 0（跨域污染 / 上下文异常）时自动判定为
 *   「analyser 不可用」，可视化层降级为模拟波形，播放链路本身不受影响
 *
 * 两个必须记住的 Web Audio 陷阱（都踩过）：
 *
 * 1. `createMediaElementSource` 一旦执行，元素的**声音就改由音频图输出**，
 *    此后 `el.volume` / `el.muted` 被浏览器完全忽略——只改这两个属性会出现
 *    「滑块在动、喇叭图标显示静音，但声音照旧」。所以音量与静音必须同时作用到
 *    图里的 GainNode 上（见 `setGain` / `setMuted`）。
 * 2. analyser 是**增益前**的旁路（source → analyser），不串在输出链上。
 *    这样静音时可视化仍在起伏——符合播放器习惯；若串在增益后，
 *    一静音波形就变直线，2 秒后还会被判成「analyser 失效」而降级成假波形。
 *
 * 输出链：`source → gain → destination`；可视链：`source → analyser`。
 */

const FFT_SIZE = 2048
/** 连续全 0 超过此时长（ms）即判定 analyser 失效 */
const FLAT_TIMEOUT = 2000

class WaveEngine {
  private ctx: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  /** 真正控制出声的增益节点（元素自身的 volume/muted 被接管后已失效） */
  private gain: GainNode | null = null
  /** 缓存的音量/静音：挂接可能发生在设过音量之后，创建 GainNode 时要按当前值初始化 */
  private volume = 1
  private muted = false
  private freqData = new Uint8Array(0)
  private timeData = new Uint8Array(0)
  private flatSince = 0
  private simulated = false

  /** 挂接 analyser；多次调用幂等 */
  attach(el: HTMLAudioElement): void {
    if (this.source) {
      this.resume()
      return
    }
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor || !el.src) return
      const ctx = new Ctor()
      const source = ctx.createMediaElementSource(el)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = 0.82
      // 可视旁路：增益前取样，静音时波形照样动
      source.connect(analyser)
      // 输出链：必须经 gain 再到 destination，否则元素 volume/muted 被接管后无处可调
      const gain = ctx.createGain()
      // 挂接可能晚于设音量（舞台在播放中途才打开），用元素当前状态初始化
      this.volume = el.volume
      this.muted = el.muted
      gain.gain.value = this.muted ? 0 : this.volume
      source.connect(gain)
      gain.connect(ctx.destination)
      this.ctx = ctx
      this.source = source
      this.analyser = analyser
      this.gain = gain
      this.freqData = new Uint8Array(analyser.frequencyBinCount)
      this.timeData = new Uint8Array(analyser.fftSize)
      if (!el.paused) this.resume()
    } catch {
      // 挂接失败（如元素已被其它 Graph 接管）：停留在无 analyser 状态，
      // 可视化走模拟波形，播放完全不受影响
      this.simulated = true
    }
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined)
  }

  /**
   * 设定输出音量（0~1）。未挂接音频图时是空操作——那时由元素的 volume 生效。
   * 每帧都可能被淡入淡出调用，直接赋值即可，别再套自动化曲线。
   */
  setGain(volume: number): void {
    if (!Number.isFinite(volume)) return
    this.volume = Math.max(0, Math.min(1, volume))
    this.applyGain()
  }

  setMuted(muted: boolean): void {
    this.muted = Boolean(muted)
    this.applyGain()
  }

  private applyGain(): void {
    if (!this.gain) return
    this.gain.gain.value = this.muted ? 0 : this.volume
  }

  /** 诊断/测试用：当前增益值与是否已挂接 */
  get state(): { attached: boolean; volume: number; muted: boolean; gain: number } {
    return {
      attached: Boolean(this.gain),
      volume: this.volume,
      muted: this.muted,
      gain: this.gain ? this.gain.gain.value : -1
    }
  }

  /** 诊断/测试用：增益节点（可临时接一个 analyser 量真实输出电平） */
  get output(): GainNode | null {
    return this.gain
  }

  /** 频域数据（0-255），未挂接时返回全 0 数组 */
  freq(): Uint8Array {
    if (this.analyser) this.analyser.getByteFrequencyData(this.freqData)
    return this.freqData
  }

  /** 时域数据（以 128 为中线的波形），未挂接时返回全 0 数组 */
  time(): Uint8Array {
    if (this.analyser) this.analyser.getByteTimeDomainData(this.timeData)
    return this.timeData
  }

  /** 是否应走模拟波形（在 frame 循环里每帧调用） */
  checkSimulated(playing: boolean): boolean {
    if (!this.analyser) return true
    if (!playing) {
      this.flatSince = 0
      return this.simulated
    }
    let max = 0
    for (let i = 4; i < this.freqData.length; i++) {
      if (this.freqData[i] > max) max = this.freqData[i]
    }
    if (max <= 1) {
      if (!this.flatSince) this.flatSince = performance.now()
      else if (performance.now() - this.flatSince > FLAT_TIMEOUT) this.simulated = true
    } else {
      this.flatSince = 0
      this.simulated = false
    }
    return this.simulated
  }
}

export const wave = new WaveEngine()

// 诊断用：开发者工具 / CDP 里能直接读 wave.freq() 判断 analyser 是否真的出数据
;(window as unknown as { __wave?: WaveEngine }).__wave = wave
