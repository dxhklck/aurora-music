import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SHIFT,
  SAME_RECORDING_BER,
  bestBitErrorRate,
  sameRecording
} from '../src/shared/fingerprint-match.ts'

/** 确定性伪随机：测试不能有随机波动 */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomFrames(seed: number, count: number): Uint32Array {
  const next = rng(seed)
  const out = new Uint32Array(count)
  for (let i = 0; i < count; i++) out[i] = Math.floor(next() * 0x100000000) >>> 0
  return out
}

test('同一份指纹误码率为 0', () => {
  const a = randomFrames(1, 64)
  assert.equal(bestBitErrorRate(a, a), 0)
  assert.equal(sameRecording(a, a), true)
})

test('平移若干帧仍能对齐（拷贝文件的起始偏移）', () => {
  const base = randomFrames(2, 96)
  const shifted = base.slice(MAX_SHIFT)
  assert.equal(bestBitErrorRate(shifted, base), 0)
  assert.equal(sameRecording(shifted, base), true)
})

test('少量位翻转（换编码器）仍判为同一录音', () => {
  const a = randomFrames(3, 128)
  const b = Uint32Array.from(a)
  // 每 10 帧翻 1 位：128 帧共 13 位错误 / 4096 位 ≈ 0.003
  for (let i = 0; i < b.length; i += 10) b[i] = (b[i] ^ 0x1) >>> 0
  const ber = bestBitErrorRate(a, b)
  assert.ok(ber < SAME_RECORDING_BER, `ber=${ber}`)
  assert.equal(sameRecording(a, b), true)
})

test('两段不同音频误码率明显偏高', () => {
  const a = randomFrames(11, 128)
  const b = randomFrames(22, 128)
  const ber = bestBitErrorRate(a, b)
  assert.ok(ber > 0.35, `ber=${ber}`)
  assert.equal(sameRecording(a, b), false)
})

test('帧数太少时不下「相同」的结论', () => {
  const a = new Uint32Array([1, 2, 3])
  const b = new Uint32Array([1, 2, 3])
  assert.equal(bestBitErrorRate(a, b), 1)
  assert.equal(sameRecording(a, b), false)
})

test('极短的静音重叠不算「同一录音」（深查结果会拿去删文件）', () => {
  // 全是 0 的 8 帧前缀，与 3000 帧静音在任意 shift 下 BER 都是 0。
  // 早期只按「最小重叠长度」归一化，会把它们判成同一首歌。
  const shortSilence = new Uint32Array(8)
  const longSilence = new Uint32Array(3000)
  assert.equal(bestBitErrorRate(shortSilence, longSilence), 1)
  assert.equal(sameRecording(shortSilence, longSilence), false)
})
