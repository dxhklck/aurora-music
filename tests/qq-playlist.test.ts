/**
 * QQ 音乐 Web 接口的 CSRF token（g_tk）计算。
 *
 * g_tk 只看登录 Cookie 里的 skey 值；拿不到时返回匿名值 5381。
 * 算错不会报错，只会让接口返回空列表——所以用纯函数测试钉住取值来源与优先级。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qqGtk } from '../src/main/providers/cookies.ts'

test('qqGtk 匿名返回 5381', () => {
  assert.equal(qqGtk(''), 5381)
  assert.equal(qqGtk('uin=o12345678'), 5381)
})

test('p_skey 参与哈希且稳定', () => {
  const value = qqGtk('p_skey=abcdef')
  assert.notEqual(value, 5381)
  assert.equal(value, qqGtk('p_skey=abcdef'))
  assert.ok(value > 0 && value <= 0x7fffffff, 'g_tk 必须落在 31 位正整数内')
})

test('skey / qm_keyst 回退且 p_skey 优先', () => {
  // 只取 skey 值做哈希，Cookie 里的其它字段不影响结果
  assert.equal(qqGtk('skey=abcdef; uin=123'), qqGtk('p_skey=abcdef'))
  assert.equal(qqGtk('qm_keyst=abcdef'), qqGtk('p_skey=abcdef'))
  assert.equal(qqGtk('p_skey=abc; skey=def'), qqGtk('p_skey=abc'))
})
