#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Aurora Music 应用图标生成器。

生成 3 个候选 logo（1024px master）+ 多尺寸预览图，供挑选：
  A  aurora-arc     深底 + 极光弧带 + 白色播放三角（延续托盘品牌基因）
  B  gradient-disc  深色圆角方 + 红橙渐变圆盘 + 白三角（托盘图标的放大版）
  C  twin-arcs      深底 + 双极光细弧 + 白三角

输出到 aurora/build-icons/：
  <name>.png        1024 master（带圆角透明边）
  <name>.ico        含 256/64/48/32/24/16
  preview.png       三变体在深/浅底上的多尺寸预览

用法：python scripts/make_app_icon.py
依赖：Pillow（本机 managed python 3.13 自带）
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "build-icons")
os.makedirs(OUT, exist_ok=True)

BASE = 1024
SS = 2  # 超采样倍数，抗锯齿
W = BASE * SS

CRIMSON = (229, 72, 77)
ROSE = (244, 63, 94)
AMBER = (245, 158, 11)
BG_TOP = (27, 18, 17)
BG_BOT = (42, 22, 20)


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def vgrad(size, top, bottom) -> Image.Image:
    g = Image.new("RGB", (1, size[1]))
    for y in range(size[1]):
        g.putpixel((0, y), lerp(top, bottom, y / (size[1] - 1)))
    return g.resize(size)


def rounded_mask(size, radius) -> Image.Image:
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def draw_triangle(d: ImageDraw.ImageDraw, cx: float, cy: float, r: float) -> None:
    """白色播放三角，右移 6% 做光学居中。"""
    cx += r * 0.06
    w, h = r * 0.62, r * 0.60
    d.polygon([(cx - w, cy - h), (cx - w, cy + h), (cx + w, cy)], fill=(255, 255, 255, 255))


def base_canvas() -> Image.Image:
    img = vgrad((W, W), BG_TOP, BG_BOT).convert("RGBA")
    return img


def soft_glow(img: Image.Image, cx: float, cy: float, r: float, color, alpha: int, blur: float) -> None:
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (alpha,))
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def ribbon(img: Image.Image, *, y_base: float, amp: float, thick: float, blur: float,
           alpha: int, x0: float = 0.10, x1: float = 0.90, power: float = 1.0) -> None:
    """一条左低右高的极光弧带，颜色沿走向 crimson→amber。"""
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    n = 160
    prev = None
    for i in range(n):
        t = i / (n - 1)
        x = W * (x0 + (x1 - x0) * t)
        y = W * (y_base - amp * math.sin(math.pi * t) ** power)
        width = max(2, int(W * thick * (0.25 + 0.75 * math.sin(math.pi * t))))
        a = int(alpha * (0.30 + 0.70 * math.sin(math.pi * t)))
        col = lerp(CRIMSON, AMBER, t) + (a,)
        if prev:
            d.line([prev, (x, y)], fill=col, width=width)
        prev = (x, y)
    img.alpha_composite(layer.filter(ImageFilter.GaussianBlur(blur)))


def finish(canvas: Image.Image, name: str) -> Image.Image:
    """缩回 1024、裁圆角、导出 png + ico。"""
    master = canvas.resize((BASE, BASE), Image.LANCZOS).convert("RGBA")
    master.putalpha(rounded_mask((BASE, BASE), int(BASE * 0.20)))
    png = os.path.join(OUT, f"{name}.png")
    master.save(png)
    ico = os.path.join(OUT, f"{name}.ico")
    master.save(ico, format="ICO", sizes=[(256, 256), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
    return master


# ---------------------------------------------------------------- 变体 A：极光弧
def variant_a() -> Image.Image:
    img = base_canvas()
    soft_glow(img, W * 0.50, W * 0.46, W * 0.36, CRIMSON, 110, W * 0.12)
    ribbon(img, y_base=0.82, amp=0.34, thick=0.100, blur=W * 0.020, alpha=255)
    ribbon(img, y_base=0.80, amp=0.33, thick=0.034, blur=W * 0.007, alpha=255)
    d = ImageDraw.Draw(img)
    draw_triangle(d, W * 0.50, W * 0.55, W * 0.26)
    return finish(img, "aurora-arc")


# ---------------------------------------------------------------- 变体 B：渐变圆盘
def variant_b() -> Image.Image:
    img = base_canvas()
    r = W * 0.36
    cx = cy = W * 0.50
    # 圆盘：左上 crimson → 右下 amber 的对角渐变
    grad = vgrad((W, W), CRIMSON, AMBER).convert("RGBA")
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    img.paste(grad, (0, 0), mask)
    # 盘面左上高光弧
    hl = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    ImageDraw.Draw(hl).arc([cx - r * 0.82, cy - r * 0.82, cx + r * 0.82, cy + r * 0.82],
                           start=200, end=300, fill=(255, 255, 255, 90), width=int(W * 0.018))
    img.alpha_composite(hl.filter(ImageFilter.GaussianBlur(W * 0.004)))
    d = ImageDraw.Draw(img)
    draw_triangle(d, cx, cy, r * 0.72)
    return finish(img, "gradient-disc")


# ---------------------------------------------------------------- 变体 C：双弧
def variant_c() -> Image.Image:
    img = base_canvas()
    soft_glow(img, W * 0.46, W * 0.52, W * 0.38, ROSE, 95, W * 0.13)
    ribbon(img, y_base=0.74, amp=0.26, thick=0.042, blur=W * 0.012, alpha=255)
    ribbon(img, y_base=0.86, amp=0.24, thick=0.030, blur=W * 0.012, alpha=230,
           x0=0.16, x1=0.96)
    d = ImageDraw.Draw(img)
    draw_triangle(d, W * 0.50, W * 0.55, W * 0.24)
    return finish(img, "twin-arcs")


# ---------------------------------------------------------------- 预览图
def preview(masters: dict[str, Image.Image]) -> None:
    sizes = [128, 48, 32, 16]
    gap = 22
    row_h = 168
    label_w = 150
    content_w = sum(sizes) + gap * (len(sizes) + 1)
    vw = label_w + content_w * len(masters) + 40
    vh = row_h * 2 * len(masters) + 40
    canvas = Image.new("RGB", (vw, vh), (24, 24, 24))
    d = ImageDraw.Draw(canvas)
    try:
        from PIL import ImageFont
        font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 20)
    except Exception:
        font = None
    y = 20
    for name, master in masters.items():
        for bg, label in (((18, 18, 18), "深色底"), ((240, 240, 240), "浅色底")):
            d.rectangle([0, y, vw, y + row_h - 12], fill=bg)
            d.text((18, y + row_h // 2 - 30), f"{name}\n{label}", fill=(200, 200, 200) if bg == (18, 18, 18) else (60, 60, 60), font=font)
            x = label_w + gap
            for s in sizes:
                icon = master.resize((s, s), Image.LANCZOS)
                canvas.paste(icon, (x, y + (row_h - 12 - s) // 2), icon)
                x += s + gap
            y += row_h
    canvas.save(os.path.join(OUT, "preview.png"))


def main() -> None:
    masters = {"A aurora-arc": variant_a(), "B gradient-disc": variant_b(), "C twin-arcs": variant_c()}
    preview(masters)
    for f in sorted(os.listdir(OUT)):
        print(f"{f}  {os.path.getsize(os.path.join(OUT, f)) // 1024}KB")


if __name__ == "__main__":
    main()
