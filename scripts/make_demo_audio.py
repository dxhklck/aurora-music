"""
生成内置演示音源（离线可播放的合成器小品）。
纯标准库实现，40 秒 22050Hz 单声道 WAV，体积小且无版权问题。

用法： python scripts/make_demo_audio.py
"""

from __future__ import annotations

import math
import os
import struct
import wave

SR = 22050
DURATION = 40.0

NOTE_BASE = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}


def freq(note: str, octave: int) -> float:
    midi = 12 * (octave + 1) + NOTE_BASE[note]
    return 440.0 * (2 ** ((midi - 69) / 12))


def pluck(f: float, length: float, gain: float = 1.0) -> list[float]:
    n = int(length * SR)
    out = [0.0] * n
    attack = int(0.006 * SR)
    for i in range(n):
        t = i / SR
        env = math.exp(-3.2 * t) * (i / attack if i < attack else 1.0)
        # 基频 + 三次谐波，模拟电钢琴
        value = (
            math.sin(2 * math.pi * f * t)
            + 0.34 * math.sin(4 * math.pi * f * t)
            + 0.12 * math.sin(6 * math.pi * f * t)
        )
        out[i] = value * env * gain * 0.28
    return out


def pad_chord(freqs: list[float], length: float, gain: float = 1.0) -> list[float]:
    n = int(length * SR)
    out = [0.0] * n
    attack = int(0.55 * SR)
    release = int(0.75 * SR)
    for i in range(n):
        t = i / SR
        if i < attack:
            env = (i / attack) ** 1.6
        elif i > n - release:
            env = max(0.0, (n - i) / release)
        else:
            env = 1.0
        # 轻微 detune 让和弦更厚
        value = 0.0
        for index, f in enumerate(freqs):
            detune = 1.0 + (0.0016 if index % 2 else -0.0012)
            vib = 1.0 + 0.0015 * math.sin(2 * math.pi * 0.18 * t + index)
            value += math.sin(2 * math.pi * f * detune * vib * t)
            value += 0.18 * math.sin(2 * math.pi * f * 2 * t)
        out[i] = value * env * gain * 0.11
    return out


def kick(length: float = 0.3, gain: float = 1.0) -> list[float]:
    n = int(length * SR)
    out = [0.0] * n
    phase = 0.0
    for i in range(n):
        t = i / SR
        f = 118 * math.exp(-22 * t) + 42
        phase += 2 * math.pi * f / SR
        env = math.exp(-7.5 * t)
        out[i] = math.sin(phase) * env * gain * 0.5
    return out


def mix(target: list[float], source: list[float], offset: int) -> None:
    limit = min(len(target) - offset, len(source))
    if limit <= 0:
        return
    for i in range(limit):
        target[offset + i] += source[i]


def render(chords: list[list[float]], bpm: float, arp_pattern: list[int], seed: float) -> list[float]:
    total = int(DURATION * SR)
    buf = [0.0] * total
    bar = 4 * 60.0 / bpm
    step = bar / 8  # 八分音符

    # 鼓：一三拍轻低音，四拍收尾
    kick_buf = kick()
    for bar_index in range(int(DURATION / bar) + 1):
        base = int(bar_index * bar * SR)
        mix(buf, kick_buf, base)
        mix(buf, kick_buf, base + int(2 * 60.0 / bpm * SR))

    # 和弦铺底
    for bar_index in range(int(DURATION / bar) + 1):
        chord = chords[bar_index % len(chords)]
        pad = pad_chord(chord, bar * 1.02, gain=1.0)
        mix(buf, pad, int(bar_index * bar * SR))

    # 琶音
    eighth = 0
    while eighth * step < DURATION:
        chord = chords[int(eighth * step // bar) % len(chords)]
        pattern_index = arp_pattern[eighth % len(arp_pattern)]
        base_freq = chord[pattern_index % len(chord)]
        octave_up = 2.0 if (pattern_index >= len(chord)) else 1.0
        note = pluck(base_freq * octave_up, 0.95, gain=0.9)
        mix(buf, note, int(eighth * step * SR))
        # 每两拍加一个高八度点缀
        if eighth % 8 == 3:
            mix(buf, pluck(base_freq * 2.0, 0.6, gain=0.45), int((eighth + 0.5) * step * SR))
        eighth += 1

    # 空气感：极轻的高频正弦
    for i in range(total):
        t = i / SR
        buf[i] += 0.008 * math.sin(2 * math.pi * 1568 * t + seed) * (0.5 + 0.5 * math.sin(2 * math.pi * 0.07 * t))

    # 包络 + 软限幅
    fade_in = int(0.6 * SR)
    fade_out = int(1.8 * SR)
    for i in range(total):
        if i < fade_in:
            buf[i] *= i / fade_in
        if i > total - fade_out:
            buf[i] *= max(0.0, (total - i) / fade_out)
        buf[i] = math.tanh(buf[i] * 1.15) * 0.82

    return buf


def write_wav(path: str, samples: list[float]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(SR)
        frames = bytearray()
        for value in samples:
            clipped = max(-1.0, min(1.0, value))
            frames += struct.pack("<h", int(clipped * 32767))
        fh.writeframes(bytes(frames))


TRACKS = [
    {
        "file": "night-flight.wav",
        "bpm": 84,
        "chords": [
            [freq("A", 3), freq("C", 4), freq("E", 4), freq("G", 4)],
            [freq("F", 3), freq("A", 3), freq("C", 4), freq("E", 4)],
            [freq("C", 3), freq("E", 3), freq("G", 3), freq("B", 3)],
            [freq("G", 3), freq("B", 3), freq("D", 4), freq("E", 4)],
        ],
        "arp": [0, 2, 1, 3, 4, 2, 3, 1],
        "seed": 0.3,
    },
    {
        "file": "morning-mist.wav",
        "bpm": 72,
        "chords": [
            [freq("C", 3), freq("E", 3), freq("G", 3), freq("B", 3)],
            [freq("E", 3), freq("G", 3), freq("B", 3), freq("D", 4)],
            [freq("A", 3), freq("C", 4), freq("E", 4), freq("G", 4)],
            [freq("F", 3), freq("A", 3), freq("C", 4), freq("E", 4)],
        ],
        "arp": [0, 3, 2, 1, 2, 3, 4, 1],
        "seed": 1.7,
    },
    {
        "file": "neon.wav",
        "bpm": 100,
        "chords": [
            [freq("D", 3), freq("F", 3), freq("A", 3), freq("C", 4)],
            [freq("A#", 2), freq("D", 3), freq("F", 3), freq("A", 3)],
            [freq("F", 3), freq("A", 3), freq("C", 4), freq("E", 4)],
            [freq("C", 3), freq("E", 3), freq("G", 3), freq("B", 3)],
        ],
        "arp": [0, 1, 2, 3, 4, 3, 2, 1],
        "seed": 2.9,
    },
]


def main() -> None:
    root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "demo")
    for track in TRACKS:
        samples = render(track["chords"], track["bpm"], track["arp"], track["seed"])
        path = os.path.join(root, track["file"])
        write_wav(path, samples)
        print(f"{track['file']}: {os.path.getsize(path) / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    main()
