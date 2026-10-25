<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { wave } from '../core/wave'
import { usePlayerStore } from '../stores/player'

/**
 * 舞台音波可视化：三种形态共用同一帧循环。
 * - bars  频谱柱：低频左高频右，基线上柱体 + 水面倒影 + 峰值保持
 * - wave  声波曲线：时域波形，双层霓虹辉光
 * - ring  环形声浪：频谱环绕唱片/封面缓慢旋转（cx/cy 对准唱片圆心）
 * analyser 不可用时自动降级为模拟波动，播放中保证「始终在动」。
 */
const props = withDefaults(
  defineProps<{
    mode?: 'bars' | 'wave' | 'ring'
    colors?: [string, string]
    /** ring 模式的圆心（0-1 比例） */
    cx?: number
    cy?: number
  }>(),
  { mode: 'bars', colors: () => ['#8b7cff', '#3ec5ff'], cx: 0.5, cy: 0.45 }
)

const player = usePlayerStore()
const canvasRef = ref<HTMLCanvasElement | null>(null)

const BANDS = 76
let raf = 0
let ctx: CanvasRenderingContext2D | null = null
let ro: ResizeObserver | null = null
let w = 0
let h = 0
let t = 0
let rot = 0
let smooth = new Float32Array(0)
let peaks = new Float32Array(0)

function resize(): void {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const rect = canvas.getBoundingClientRect()
  w = Math.max(1, Math.round(rect.width))
  h = Math.max(1, Math.round(rect.height))
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  ctx = canvas.getContext('2d')
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/** 两个 hex 颜色线性插值 */
function mix(c1: string, c2: string, k: number): string {
  const p = (c: string): [number, number, number] => [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16)
  ]
  const [r1, g1, b1] = p(c1)
  const [r2, g2, b2] = p(c2)
  return `rgb(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(
    b1 + (b2 - b1) * k
  )})`
}

/** 模拟频谱：几组异相正弦叠加 + 低频脊，没有 analyser 也保证自然起伏 */
function simBand(i: number, n: number): number {
  const k = i / n
  const bass = Math.exp(-Math.pow(k * 4 - 0.6, 2))
  const v =
    0.3 +
    0.24 * Math.sin(t * 2.4 + k * 9) +
    0.18 * Math.sin(t * 3.9 + k * 23) +
    0.12 * Math.sin(t * 1.7 + k * 5) +
    0.14 * bass * Math.abs(Math.sin(t * 4.6))
  return Math.max(0.04, Math.min(1, v * (0.65 + bass * 0.6)))
}

function roundBar(x: number, y: number, bw: number, bh: number): void {
  if (!ctx || bh <= 0) return
  const r = Math.min(bw / 2, 2)
  ctx.beginPath()
  ctx.moveTo(x, y + bh)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.lineTo(x + bw - r, y)
  ctx.quadraticCurveTo(x + bw, y, x + bw, y + r)
  ctx.lineTo(x + bw, y + bh)
  ctx.closePath()
  ctx.fill()
}

function drawBars(): void {
  if (!ctx) return
  const baseline = h * 0.74
  const bw = w / BANDS
  for (let i = 0; i < BANDS; i++) {
    const v = smooth[i]
    if (v < 0.01) continue
    const bh = Math.max(2, v * baseline * 0.92)
    const x = i * bw + bw * 0.18
    const width = bw * 0.64
    ctx.fillStyle = mix(props.colors[0], props.colors[1], i / BANDS)
    ctx.globalAlpha = 0.92
    roundBar(x, baseline - bh, width, bh)
    // 水面倒影
    ctx.globalAlpha = 0.16
    roundBar(x, baseline + 3, width, Math.min(bh * 0.45, h - baseline - 4))
    // 峰值保持帽
    ctx.globalAlpha = 0.55
    ctx.fillRect(x, baseline - Math.max(2, peaks[i] * baseline * 0.92) - 3, width, 2)
  }
  ctx.globalAlpha = 1
}

function drawWave(simulated: boolean): void {
  if (!ctx) return
  const mid = h * 0.5
  const amp = h * 0.3
  const time = wave.time()
  ctx.lineWidth = 2.5
  ctx.lineJoin = 'round'
  for (let layer = 0; layer < 2; layer++) {
    ctx.beginPath()
    const steps = 140
    for (let i = 0; i <= steps; i++) {
      const k = i / steps
      let y: number
      if (!simulated && time.length > 128) {
        // 真实时域波形
        y = mid + ((time[Math.floor(k * (time.length - 1))] - 128) / 128) * amp * (layer ? 0.55 : 1)
      } else {
        const alive = player.playing ? 1 : 0.22
        y =
          mid +
          (Math.sin(k * 12.5 - t * 3.1 + layer) * 0.55 + Math.sin(k * 5.2 + t * 2.2 + layer * 2) * 0.45) *
            amp *
            (layer ? 0.3 : 0.5) *
            alive
      }
      if (i === 0) ctx.moveTo(0, y)
      else ctx.lineTo(k * w, y)
    }
    ctx.strokeStyle = props.colors[layer]
    ctx.globalAlpha = layer ? 0.55 : 0.9
    ctx.shadowColor = props.colors[layer]
    ctx.shadowBlur = 16
    ctx.stroke()
  }
  ctx.shadowBlur = 0
  ctx.globalAlpha = 1
}

function drawRing(): void {
  if (!ctx) return
  const cxp = w * props.cx
  const cyp = h * props.cy
  const R = Math.min(w, h) * 0.3
  ctx.lineCap = 'round'
  ctx.lineWidth = 3
  for (let i = 0; i < BANDS; i++) {
    const a = rot + (i / BANDS) * Math.PI * 2
    const v = smooth[i]
    const len = 3 + v * R * 0.85
    const c = Math.cos(a)
    const s = Math.sin(a)
    ctx.strokeStyle = mix(props.colors[0], props.colors[1], v)
    ctx.globalAlpha = 0.28 + v * 0.6
    ctx.beginPath()
    ctx.moveTo(cxp + c * (R + 8), cyp + s * (R + 8))
    ctx.lineTo(cxp + c * (R + 8 + len), cyp + s * (R + 8 + len))
    ctx.stroke()
  }
  // 内环细光圈
  ctx.globalAlpha = 0.5
  ctx.lineWidth = 1.5
  ctx.strokeStyle = props.colors[0]
  ctx.beginPath()
  ctx.arc(cxp, cyp, R + 4, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1
}

function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  if (!ctx) return
  t = now / 1000
  const playing = player.playing
  const freq = wave.freq()
  const simulated = wave.checkSimulated(playing)
  if (smooth.length !== BANDS) {
    smooth = new Float32Array(BANDS)
    peaks = new Float32Array(BANDS)
  }
  for (let i = 0; i < BANDS; i++) {
    let target: number
    if (simulated) {
      target = playing ? simBand(i, BANDS) : 0
    } else {
      // 对数分组：低频占窄带高频占宽带，视觉上更接近听感分布
      const span = Math.floor(freq.length * 0.72)
      const start = Math.floor(Math.pow(i / BANDS, 1.55) * span)
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / BANDS, 1.55) * span))
      let sum = 0
      for (let j = start; j < end; j++) sum += freq[j]
      target = Math.min(1, (sum / (end - start) / 255) * (0.85 + (i / BANDS) * 1.1))
    }
    smooth[i] += (target - smooth[i]) * (target > smooth[i] ? 0.38 : 0.12)
    peaks[i] = Math.max(peaks[i] - 0.006, smooth[i])
  }
  rot += 0.0022
  ctx.clearRect(0, 0, w, h)
  if (props.mode === 'wave') drawWave(simulated)
  else if (props.mode === 'ring') drawRing()
  else drawBars()
}

onMounted(() => {
  resize()
  const canvas = canvasRef.value
  if (canvas) {
    ro = new ResizeObserver(resize)
    ro.observe(canvas)
  }
  raf = requestAnimationFrame(frame)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  ro = null
})
</script>

<template>
  <canvas ref="canvasRef" class="audio-wave" />
</template>

<style scoped>
.audio-wave {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
