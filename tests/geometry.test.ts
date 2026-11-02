/**
 * 窗口位置纠正的纯函数单测。
 *
 * 这里算错的后果不是抛异常，而是窗口跑到屏幕外面：用户只会说「窗口不见了」，
 * 现场很难复现（依赖显示器尺寸与缩放）。核心场景是「窗口比工作区还宽」——
 * 1366×768 的笔记本配上默认 1320 宽的主窗，一夹就成负数。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clampTopLeft, restoreRect } from '../src/main/geometry.ts'

/** 1366×768 笔记本，扣掉任务栏后的工作区 */
const narrowWorkArea = { x: 0, y: 0, width: 1366, height: 728 }

test('窗口比工作区还宽时，左上角钳到工作区左边而不是算成负数', () => {
  const pos = clampTopLeft({ x: 200, y: 100, width: 1600, height: 700 }, narrowWorkArea)
  assert.equal(pos.x, 0, '不能是负数，否则窗口整体跑到屏幕左侧之外')
  assert.ok(pos.x >= narrowWorkArea.x)
})

test('窗口比工作区还高时，上边缘钳到工作区顶部', () => {
  const pos = clampTopLeft({ x: 100, y: 300, width: 900, height: 900 }, narrowWorkArea)
  assert.equal(pos.y, 0)
})

test('正常尺寸的窗口贴着右下角时被拉回可视区', () => {
  const pos = clampTopLeft({ x: 1200, y: 700, width: 800, height: 600 }, narrowWorkArea)
  assert.equal(pos.x, narrowWorkArea.width - 800)
  assert.equal(pos.y, narrowWorkArea.height - 600)
})

test('窗口已经在工作区内时原样返回', () => {
  const pos = clampTopLeft({ x: 120, y: 80, width: 800, height: 600 }, narrowWorkArea)
  assert.deepEqual(pos, { x: 120, y: 80 })
})

test('副屏在主屏右侧时，坐标按副屏的原点算（不能钳回 0）', () => {
  const secondScreen = { x: 1920, y: 0, width: 1920, height: 1040 }
  const pos = clampTopLeft({ x: 100, y: 50, width: 800, height: 600 }, secondScreen)
  assert.equal(pos.x, 1920, '副屏上的窗口必须留在副屏，不能被拉回主屏原点')
  assert.equal(pos.y, 50)
})

test('副屏在主屏左侧时（负坐标工作区）同样成立', () => {
  const leftScreen = { x: -1920, y: 0, width: 1920, height: 1040 }
  const pos = clampTopLeft({ x: -1800, y: 40, width: 800, height: 600 }, leftScreen)
  assert.equal(pos.x, -1800)
  assert.equal(pos.y, 40)
})

test('迷你条尺寸（380×56）在任何工作区都不会被改动', () => {
  const pos = clampTopLeft({ x: 900, y: 600, width: 380, height: 56 }, narrowWorkArea)
  assert.deepEqual(pos, { x: 900, y: 600 })
})

/* ---------------- 从存档恢复窗口矩形 ---------------- */

/** 桌面歌词窗「大字」形态的尺寸约束 */
const lyricLimits = { minWidth: 480, minHeight: 118 }

test('存档合法时原样恢复', () => {
  const rect = restoreRect({ x: 300, y: 300, width: 920, height: 172 }, lyricLimits, narrowWorkArea)
  assert.deepEqual(rect, { x: 300, y: 300, width: 920, height: 172 })
})

test('存档字段不全或不合法时整条丢弃（返回 null 走默认值）', () => {
  assert.equal(restoreRect(null, lyricLimits, narrowWorkArea), null)
  assert.equal(restoreRect(undefined, lyricLimits, narrowWorkArea), null)
  assert.equal(restoreRect('oops', lyricLimits, narrowWorkArea), null)
  assert.equal(restoreRect({}, lyricLimits, narrowWorkArea), null)
  // 少一个字段
  assert.equal(restoreRect({ x: 1, y: 2, width: 900 }, lyricLimits, narrowWorkArea), null)
  // NaN / Infinity / 字符串混进来（手改坏的 JSON 长这样）
  assert.equal(restoreRect({ x: NaN, y: 2, width: 900, height: 170 }, lyricLimits, narrowWorkArea), null)
  assert.equal(restoreRect({ x: 1, y: 2, width: Infinity, height: 170 }, lyricLimits, narrowWorkArea), null)
  assert.equal(restoreRect({ x: '1', y: 2, width: 900, height: 170 }, lyricLimits, narrowWorkArea), null)
})

test('存档尺寸小于下限时抬到最小尺寸，而不是丢弃整条记录', () => {
  const rect = restoreRect({ x: 100, y: 100, width: 200, height: 40 }, lyricLimits, narrowWorkArea)
  assert.equal(rect?.width, 480)
  assert.equal(rect?.height, 118)
  // 位置仍然保留（抬尺寸后没有越界）
  assert.equal(rect?.x, 100)
})

test('存档来自更宽的屏幕时，尺寸夹到当前工作区', () => {
  const rect = restoreRect({ x: 0, y: 0, width: 3000, height: 2000 }, lyricLimits, narrowWorkArea)
  assert.equal(rect?.width, narrowWorkArea.width)
  assert.equal(rect?.height, narrowWorkArea.height)
})

test('存档位置在屏幕外时被拉回工作区', () => {
  const rect = restoreRect({ x: 5000, y: 5000, width: 920, height: 172 }, lyricLimits, narrowWorkArea)
  assert.ok((rect?.x ?? -1) + (rect?.width ?? 0) <= narrowWorkArea.width)
  assert.ok((rect?.y ?? -1) + (rect?.height ?? 0) <= narrowWorkArea.height)
})

test('副屏上的存档留在副屏，不会被拉回主屏原点', () => {
  const secondScreen = { x: 1920, y: 0, width: 1920, height: 1040 }
  const rect = restoreRect({ x: 2400, y: 400, width: 920, height: 172 }, lyricLimits, secondScreen)
  assert.equal(rect?.x, 2400)
  assert.equal(rect?.y, 400)
})

test('负坐标工作区（副屏在主屏左侧）同样能恢复', () => {
  const leftScreen = { x: -1920, y: 0, width: 1920, height: 1040 }
  const rect = restoreRect({ x: -1500, y: 200, width: 920, height: 172 }, lyricLimits, leftScreen)
  assert.equal(rect?.x, -1500)
})

test('工作区比最小尺寸还小时不会算出负数或越界', () => {
  const tiny = { x: 0, y: 0, width: 300, height: 100 }
  const rect = restoreRect({ x: 50, y: 20, width: 920, height: 172 }, lyricLimits, tiny)
  assert.equal(rect?.width, 300)
  assert.equal(rect?.height, 100)
  assert.equal(rect?.x, 0)
  assert.equal(rect?.y, 0)
})
