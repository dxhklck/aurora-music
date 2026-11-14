/** 屏幕/窗口矩形。不引 electron 类型，这样纯几何运算能直接单测 */
export type Rect = { x: number; y: number; width: number; height: number }

/**
 * 把窗口的左上角纠正到工作区内。
 *
 * 宽高必须先各自钳到工作区尺寸再算偏移，否则「窗口比屏幕还宽」时
 * `area.x + area.width - rect.width` 会算出一个小于 area.x 的值，Math.min 取到它，
 * 窗口被推到屏幕左侧之外。默认主窗 1320 宽，配 1366×768 的笔记本（含缩放）就会踩到。
 *
 * 只返回左上角：尺寸由调用方按自己的形态决定，这里不替它改。
 */
export function clampTopLeft(rect: Rect, area: Rect): { x: number; y: number } {
  const width = Math.min(rect.width, area.width)
  const height = Math.min(rect.height, area.height)
  return {
    x: Math.min(Math.max(rect.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(rect.y, area.y), area.y + area.height - height)
  }
}

/**
 * 从存档里恢复一个窗口矩形，并纠正到当前屏幕可用范围内。
 *
 * 存下来的值可能来自另一块更宽的屏，也可能是手改坏的 JSON。字段不全、
 * NaN、负尺寸都要整条丢弃（返回 null，让调用方走默认值），不能硬用——
 * 否则窗口会恢复到屏幕之外，用户看到的是「窗口不见了」。
 * 尺寸是夹取而不是丢弃：4K 屏上存的宽窗口换到 1080p，缩一下仍然可用。
 */
export function restoreRect(
  value: unknown,
  limits: { minWidth: number; minHeight: number },
  area: Rect
): Rect | null {
  if (!value || typeof value !== 'object') return null
  const { x, y, width, height } = value as Record<string, unknown>
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null

  // 最小尺寸本身也可能比工作区还大（极小屏 / 大缩放），先各自夹一次
  const minWidth = Math.min(limits.minWidth, area.width)
  const minHeight = Math.min(limits.minHeight, area.height)
  const w = Math.min(Math.max(width as number, minWidth), area.width)
  const h = Math.min(Math.max(height as number, minHeight), area.height)
  const pos = clampTopLeft({ x: x as number, y: y as number, width: w, height: h }, area)
  return { ...pos, width: w, height: h }
}

/**
 * 比例存档：窗口左上角在屏幕内的相对位置（0~1）。
 *
 * 借鉴移动版 PlayerBar/LyricOverlay 的做法——存比例不存像素。像素坐标在
 * 「换分辨率 / 换显示器 / 改缩放」后会落到错误的相对位置（4K 存的右下角
 * 浮窗到 1080p 屏上就出了屏幕），比例坐标在这些场景下保持视觉相对位置。
 * clamp 在恢复时做，存档原样保留用户摆放的意图。
 */
export function positionRatio(
  rect: { x: number; y: number },
  area: Rect
): { rx: number; ry: number } | null {
  const width = area.width
  const height = area.height
  if (width <= 0 || height <= 0) return null
  return {
    rx: clamp01((rect.x - area.x) / width),
    ry: clamp01((rect.y - area.y) / height)
  }
}

/**
 * 从比例存档恢复左上角坐标：按**当前**工作区尺寸还原，再夹进可视区域。
 * 比例不合法（NaN / 越界太多）返回 null，调用方退回像素存档或默认位置。
 */
export function positionFromRatio(
  rx: number,
  ry: number,
  size: { width: number; height: number },
  area: Rect
): { x: number; y: number } | null {
  if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx < -0.05 || ry < -0.05 || rx > 1.05 || ry > 1.05) {
    return null
  }
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  const pos = clampTopLeft(
    {
      x: area.x + clamp01(rx) * (area.width - width),
      y: area.y + clamp01(ry) * (area.height - height),
      width,
      height
    },
    area
  )
  return pos
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}
