/**
 * 生成内置演示音源（离线可播放的合成器小品）。
 * 纯 Node 实现，40 秒 22050Hz 单声道 WAV，体积小且无版权问题。
 *
 * 用法： node scripts/make-demo-audio.mjs
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SR = 22050
const DURATION = 40.0

const NOTE_BASE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }
const TWO_PI = Math.PI * 2

const freq = (note, octave) => {
  const midi = 12 * (octave + 1) + NOTE_BASE[note]
  return 440.0 * 2 ** ((midi - 69) / 12)
}

const pluck = (f, length, gain = 1.0) => {
  const n = Math.trunc(length * SR)
  const out = new Float32Array(n)
  const attack = Math.trunc(0.006 * SR)
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const env = Math.exp(-3.2 * t) * (i < attack ? i / attack : 1.0)
    const value =
      Math.sin(TWO_PI * f * t) +
      0.34 * Math.sin(TWO_PI * 2 * f * t) +
      0.12 * Math.sin(TWO_PI * 3 * f * t)
    out[i] = value * env * gain * 0.28
  }
  return out
}

const padChord = (freqs, length, gain = 1.0) => {
  const n = Math.trunc(length * SR)
  const out = new Float32Array(n)
  const attack = Math.trunc(0.55 * SR)
  const release = Math.trunc(0.75 * SR)
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    let env
    if (i < attack) env = (i / attack) ** 1.6
    else if (i > n - release) env = Math.max(0.0, (n - i) / release)
    else env = 1.0
    let value = 0.0
    for (let index = 0; index < freqs.length; index += 1) {
      const f = freqs[index]
      const detune = 1.0 + (index % 2 ? 0.0016 : -0.0012)
      const vib = 1.0 + 0.0015 * Math.sin(TWO_PI * 0.18 * t + index)
      value += Math.sin(TWO_PI * f * detune * vib * t)
      value += 0.18 * Math.sin(TWO_PI * f * 2 * t)
    }
    out[i] = value * env * gain * 0.11
  }
  return out
}

const kick = (length = 0.3, gain = 1.0) => {
  const n = Math.trunc(length * SR)
  const out = new Float32Array(n)
  let phase = 0.0
  for (let i = 0; i < n; i += 1) {
    const t = i / SR
    const f = 118 * Math.exp(-22 * t) + 42
    phase += (TWO_PI * f) / SR
    const env = Math.exp(-7.5 * t)
    out[i] = Math.sin(phase) * env * gain * 0.5
  }
  return out
}

const mix = (target, source, offset) => {
  const limit = Math.min(target.length - offset, source.length)
  if (limit <= 0) return
  for (let i = 0; i < limit; i += 1) target[offset + i] += source[i]
}

const render = (chords, bpm, arpPattern, seed) => {
  const total = Math.trunc(DURATION * SR)
  const buf = new Float32Array(total)
  const bar = (4 * 60.0) / bpm
  const step = bar / 8

  const kickBuf = kick()
  for (let barIndex = 0; barIndex < Math.trunc(DURATION / bar) + 1; barIndex += 1) {
    const base = Math.trunc(barIndex * bar * SR)
    mix(buf, kickBuf, base)
    mix(buf, kickBuf, base + Math.trunc(((2 * 60.0) / bpm) * SR))
  }

  for (let barIndex = 0; barIndex < Math.trunc(DURATION / bar) + 1; barIndex += 1) {
    const chord = chords[barIndex % chords.length]
    const pad = padChord(chord, bar * 1.02, 1.0)
    mix(buf, pad, Math.trunc(barIndex * bar * SR))
  }

  let eighth = 0
  while (eighth * step < DURATION) {
    const chord = chords[Math.trunc(Math.trunc(eighth * step / bar) % chords.length)]
    const patternIndex = arpPattern[eighth % arpPattern.length]
    const baseFreq = chord[patternIndex % chord.length]
    const octaveUp = patternIndex >= chord.length ? 2.0 : 1.0
    mix(buf, pluck(baseFreq * octaveUp, 0.95, 0.9), Math.trunc(eighth * step * SR))
    if (eighth % 8 === 3) {
      mix(buf, pluck(baseFreq * 2.0, 0.6, 0.45), Math.trunc((eighth + 0.5) * step * SR))
    }
    eighth += 1
  }

  for (let i = 0; i < total; i += 1) {
    const t = i / SR
    buf[i] += 0.008 * Math.sin(TWO_PI * 1568 * t + seed) * (0.5 + 0.5 * Math.sin(TWO_PI * 0.07 * t))
  }

  const fadeIn = Math.trunc(0.6 * SR)
  const fadeOut = Math.trunc(1.8 * SR)
  for (let i = 0; i < total; i += 1) {
    if (i < fadeIn) buf[i] *= i / fadeIn
    if (i > total - fadeOut) buf[i] *= Math.max(0.0, (total - i) / fadeOut)
    buf[i] = Math.tanh(buf[i] * 1.15) * 0.82
  }

  return buf
}

/** 16bit PCM 单声道 WAV（44 字节标准头） */
const writeWav = (path, samples) => {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    const clipped = Math.max(-1.0, Math.min(1.0, samples[i]))
    data.writeInt16LE(Math.trunc(clipped * 32767), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SR, 24)
  header.writeUInt32LE(SR * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([header, data]))
}

const TRACKS = [
  {
    file: 'night-flight.wav',
    bpm: 84,
    chords: [
      [freq('A', 3), freq('C', 4), freq('E', 4), freq('G', 4)],
      [freq('F', 3), freq('A', 3), freq('C', 4), freq('E', 4)],
      [freq('C', 3), freq('E', 3), freq('G', 3), freq('B', 3)],
      [freq('G', 3), freq('B', 3), freq('D', 4), freq('E', 4)]
    ],
    arp: [0, 2, 1, 3, 4, 2, 3, 1],
    seed: 0.3
  },
  {
    file: 'morning-mist.wav',
    bpm: 72,
    chords: [
      [freq('C', 3), freq('E', 3), freq('G', 3), freq('B', 3)],
      [freq('E', 3), freq('G', 3), freq('B', 3), freq('D', 4)],
      [freq('A', 3), freq('C', 4), freq('E', 4), freq('G', 4)],
      [freq('F', 3), freq('A', 3), freq('C', 4), freq('E', 4)]
    ],
    arp: [0, 3, 2, 1, 2, 3, 4, 1],
    seed: 1.7
  },
  {
    file: 'neon.wav',
    bpm: 100,
    chords: [
      [freq('D', 3), freq('F', 3), freq('A', 3), freq('C', 4)],
      [freq('A#', 2), freq('D', 3), freq('F', 3), freq('A', 3)],
      [freq('F', 3), freq('A', 3), freq('C', 4), freq('E', 4)],
      [freq('C', 3), freq('E', 3), freq('G', 3), freq('B', 3)]
    ],
    arp: [0, 1, 2, 3, 4, 3, 2, 1],
    seed: 2.9
  }
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'demo')
for (const track of TRACKS) {
  const samples = render(track.chords, track.bpm, track.arp, track.seed)
  const path = join(root, track.file)
  writeWav(path, samples)
  console.log(`${track.file}: ${(statSync(path).size / 1024 / 1024).toFixed(2)} MB`)
}
