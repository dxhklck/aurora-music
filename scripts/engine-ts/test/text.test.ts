/**
 * 文本 / 数值 / 歌词工具的差分测试。
 *
 * 期望值固化在 `fixtures/parity-vectors.json` 里作为回归基线——
 * 断言的是「输出没有漂移」，不是「符合我的直觉」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bytesToMb,
  cleanLrc,
  cleanText,
  durationFromLrc,
  legalize,
  normalizeForMatch,
  secondsToHms,
  toFloat,
  toInt
} from '../../../src/main/engine/ts/text'
import { loadJson } from './helpers'

interface Case<T> {
  input: T
  out: unknown
}

const parity = loadJson<Record<string, Array<Case<never>>>>('parity.json')

function expectNoError(out: unknown): void {
  assert.ok(!(out && typeof out === 'object' && '__error__' in (out as object)), `基线向量标记为异常：${JSON.stringify(out)}`)
}

test('legalize 逐向量符合基线', () => {
  for (const item of parity.legalize) {
    expectNoError(item.out)
    assert.equal(legalize(item.input), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
})

test('cleanText：NULL/None/N/A 统一为空串', () => {
  for (const item of parity.clean) {
    expectNoError(item.out)
    assert.equal(cleanText(item.input), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
})

test('toInt：整串数字才算数，其余归默认值', () => {
  for (const item of parity.asInt) {
    expectNoError(item.out)
    assert.equal(toInt(item.input), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
  // 早期用 parseFloat 会把这些值解析成 12 / 3，属于必须防住的回归
  assert.equal(toInt('12abc'), 0)
  assert.equal(toInt('03:45'), 0)
  assert.equal(toInt('1e3'), 1000)
  assert.equal(toInt(' 42 '), 42)
})

test('toFloat 只接受完整数字串', () => {
  assert.equal(toFloat('223.9'), 223.9)
  assert.equal(toFloat('12abc'), 0)
  assert.equal(toFloat('03:45'), 0)
  assert.equal(toFloat('1e3'), 1000)
  assert.equal(toFloat(Number.NaN), 0)
})

test('normalizeForMatch：按 Unicode 字母数字判定，而非 ASCII 白名单', () => {
  for (const item of parity.norm) {
    expectNoError(item.out)
    assert.equal(normalizeForMatch(item.input), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
})

test('secondsToHms / bytesToMb 的输出格式', () => {
  for (const item of parity.seconds2hms) {
    expectNoError(item.out)
    assert.equal(secondsToHms(item.input), item.out, `seconds=${JSON.stringify(item.input)}`)
  }
  for (const item of parity.byte2mb) {
    expectNoError(item.out)
    assert.equal(bytesToMb(Number(item.input)), item.out, `bytes=${JSON.stringify(item.input)}`)
  }
})

test('cleanLrc 逐行清理歌词', () => {
  for (const item of parity.cleanlrc) {
    expectNoError(item.out)
    assert.equal(cleanLrc(item.input), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
})

test('durationFromLrc 从最后一行时间戳取时长', () => {
  for (const item of parity.durationFromLrc) {
    expectNoError(item.out)
    assert.equal(durationFromLrc(item.input), item.out, `输入 ${JSON.stringify(item.input)}`)
  }
})

test('legalize 的空值语义保留 NULL 字符串（上游依赖它做分支）', () => {
  assert.equal(legalize(''), 'NULL')
  assert.equal(legalize(null), 'NULL')
  assert.equal(legalize('   '), 'NULL')
  // 但 'NULL' 本身是合法文本，不能被二次归一化成空
  assert.equal(legalize('NULL'), 'NULL')
  assert.equal(legalize('None'), 'None')
})

test('legalize 保留全角空格以外的分隔符语义，删除 Zs 分隔符', () => {
  // U+3000 属不可打印分隔符；这里必须删掉而不是折叠成空格
  assert.equal(legalize('猴﹏子\u3000￡'), '猴﹏子￡')
  // 普通 ASCII 空格保留并折叠
  assert.equal(legalize('  a   b  '), 'a b')
})
