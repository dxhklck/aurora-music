/**
 * 频谱引擎：把 Web Audio AnalyserNode 接到播放元素上。
 * - 懒创建（第一次打开「正在播放」舞台时挂接），全局单例，之后复用
 * - MediaElementSource 一旦创建就接管元素出声，必须 analyser.connect(destination)，
 *   否则舞台开过一次后全程静音
 * - 播放中 analyser 读数持续全 0（跨域污染 / 上下文异常）时自动判定为
 *   「analyser 不可用」，可视化层降级为模拟波形，播放链路本身不受影响
 */

const FFT_SIZE = 2048
/** 连续全 0 超过此时长（ms）即判定 analyser 失效 */
const FLAT_TIMEOUT = 2000

class WaveEngine {
  private ctx: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
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
      source.connect(analyser)
      // 关键：不接 destination 元素就没声了
      analyser.connect(ctx.destination)
      this.ctx = ctx
      this.source = source
      this.analyser = analyser
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
