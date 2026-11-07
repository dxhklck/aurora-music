/**
 * 指纹比对：判断两个文件是不是「同一段录音」（同曲不同码率、flac 与 mp3）。
 *
 * 为什么不用歌名歌手比对：那套只认元数据，而重复文件的元数据往往正是坏的
 * （文件名当歌名、没有歌手），恰恰是它抓不到的那一批。
 *
 * 数据来自 `fpcalc -json -raw`：每帧一个 uint32，ChromaPrint 的 12 位子指纹在这里
 * 展开成 32 位字。同一录音即使换了编码器，逐位差异也很小（实测同一段音频 BER ≈ 0.08）；
 * 不同歌曲则接近 0.5（随机比特）。
 *
 * 只做 ±3 帧的平移搜索：拷贝出来的文件都从 0 秒开始，对齐偏差不会超过几十毫秒；
 * 全量搜索是 O(n·m)，3000 帧就要 900 万次 popcount，库里几百首会卡死。
 */

/** 同一录音的判定线。实测：同录音 0.03~0.09，不同歌曲 0.4~0.5 */
export const SAME_RECORDING_BER = 0.12

/** 允许的相对平移（帧）。1 帧 ≈ 0.124 秒 */
export const MAX_SHIFT = 3

/**
 * 至少要有这么多帧重叠才下结论。
 * 之前只用「较短一方的长度」归一化：8 帧静音前缀 vs 3000 帧静音能凑出 BER=0，
 * 被判成同一录音；而深查结果会直接拿去删文件，误判代价太大。
 */
export const MIN_COMPARE_FRAMES = 32

function popcount(value: number): number {
  let x = value
  x -= (x >> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333)
  x = (x + (x >> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >> 24
}

/** 在 [-maxShift, maxShift] 的平移里取最小误码率；短于 8 帧直接判为不相似 */
export function bestBitErrorRate(
  a: Uint32Array,
  b: Uint32Array,
  maxShift = MAX_SHIFT
): number {
  if (a.length < 8 || b.length < 8) return 1
  let best = 1
  for (let shift = -maxShift; shift <= maxShift; shift++) {
    const startA = Math.max(0, shift)
    const startB = Math.max(0, -shift)
    const length = Math.min(a.length - startA, b.length - startB)
    if (length < MIN_COMPARE_FRAMES) continue
    let errors = 0
    for (let i = 0; i < length; i++) errors += popcount(a[startA + i] ^ b[startB + i])
    const ber = errors / (length * 32)
    if (ber < best) best = ber
  }
  return best
}

/** 时长差超过这个值就一定不是同一录音（同一个母带转码不会差这么多） */
export const SAME_RECORDING_MAX_GAP_SEC = 5

export function sameRecording(
  a: Uint32Array,
  b: Uint32Array,
  threshold = SAME_RECORDING_BER
): boolean {
  return bestBitErrorRate(a, b) < threshold
}
