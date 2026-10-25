/** 由任意字符串派生一组稳定的渐变色，用作无封面时的占位视觉 */
export function gradientFromSeed(seed: string): string {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const hue = Math.abs(hash) % 360
  const hue2 = (hue + 48 + (Math.abs(hash >> 8) % 90)) % 360
  return `linear-gradient(140deg, hsl(${hue} 72% 52%), hsl(${hue2} 62% 24%))`
}

export function accentPair(seed: string): [string, string] {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const hue = Math.abs(hash) % 360
  return [`hsl(${hue} 78% 60%)`, `hsl(${(hue + 60) % 360} 70% 45%)`]
}
