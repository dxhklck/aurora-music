#!/usr/bin/env python3
"""生成托盘图标 resources/icons/tray.png（32x32，深色圆底 + 白色播放三角）。

零第三方依赖：用 struct + zlib 手写 PNG，与 make_demo_audio.py 同一风格。
产物很小（约 300B），直接进仓库，构建时不依赖本脚本。
"""

import struct
import zlib
from pathlib import Path

SIZE = 32
CENTER = 15.5
RADIUS = 15.0

# 三角形顶点（播放符号），略向右偏移以视觉居中
TRI = ((12.0, 9.5), (12.0, 21.5), (23.5, 15.5))


def in_circle(x: float, y: float) -> bool:
    return (x - CENTER) ** 2 + (y - CENTER) ** 2 <= RADIUS**2


def in_triangle(x: float, y: float) -> bool:
    (ax, ay), (bx, by), (cx, cy) = TRI

    def sign(px, py, qx, qy, rx, ry):
        return (px - rx) * (qy - ry) - (qx - rx) * (py - ry)

    d1 = sign(x, y, ax, ay, bx, by)
    d2 = sign(x, y, bx, by, cx, cy)
    d3 = sign(x, y, cx, cy, ax, ay)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def pixel(x: int, y: int):
    # 中心到边缘：#3f8cff → #7b5cff 的径向渐变（与 Aurora 主色系一致）
    dist = ((x - CENTER) ** 2 + (y - CENTER) ** 2) / (RADIUS**2)
    t = min(1.0, max(0.0, dist))
    r = round(0x3F + (0x7B - 0x3F) * t)
    g = round(0x8C + (0x5C - 0x8C) * t)
    b = round(0xFF + (0xFF - 0xFF) * t)
    if in_triangle(x, y):
        return (250, 250, 252, 255)
    return (r, g, b, 255)


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    )


def build_png() -> bytes:
    # 每行前置 filter 字节 0
    raw = b"".join(
        b"\x00" + bytes(v for x in range(SIZE) for v in pixel(x, y)) for y in range(SIZE)
    )
    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)  # 8bit RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main() -> None:
    out = Path(__file__).resolve().parent.parent / "resources" / "icons" / "tray.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(build_png())
    print(f"[tray-icon] {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
