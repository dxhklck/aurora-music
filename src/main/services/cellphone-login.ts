/**
 * 手机号登录服务（网易云音乐）。
 *
 * 与扫码登录同一条合规底线：Aurora 不内置任何账号，验证码/密码只发往
 * 网易云官方 weapi 接口，换取用户本人的登录态 Cookie，与用户在浏览器
 * 里自己登录完全等价。Cookie 落 settings.json（只存本机）。
 *
 * 复用 qrlogin-util 的 weapi 加密与 qrlogin 的成功广播，登录完成后
 * 音源适配器即时生效，设置页账号卡片随 settingsChanged 刷新。
 *
 * 移动端（Android 壳）说明：这是手机端的主登录方式——桌面上的
 * 「手机扫桌面二维码」在手机上不成立；QQ 音乐的手机端登录走应用内
 * WebView 抓 Cookie，属壳工程阶段工作，不在这里。
 */

import { createHash } from 'node:crypto'
import { cookieFromHeader, wapiBody } from './qrlogin-util'
import { notifyLoginSuccess } from './qrlogin'
import { settings } from './settings'
import type { CellphoneLoginArgs, CellphoneLoginResult, NeteaseAccountInfo } from '@shared/types'

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://music.163.com/'

/** weapi POST 公共封装：返回响应 JSON 与 Set-Cookie 头 */
async function wapiPost(
  path: string,
  data: Record<string, unknown>
): Promise<{ json: Record<string, unknown> | null; setCookies: string[] }> {
  const res = await fetch(`https://music.163.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: REFERER,
      'User-Agent': UA_PC
    },
    body: new URLSearchParams(wapiBody(data)).toString()
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { json, setCookies: res.headers.getSetCookie() }
}

/** 登录接口的报错文案：优先 message，兜底 data.msg（风控类错误常在这里） */
function pickError(json: Record<string, unknown> | null, fallback: string): string {
  if (!json) return fallback
  const message = typeof json.message === 'string' ? json.message : ''
  if (message) return message
  const data = json.data as { msg?: string } | undefined
  if (data?.msg) return data.msg
  return `操作失败（code ${String(json.code ?? '未知')}）`
}

/** 发送短信验证码 */
export async function sendCaptcha(
  phone: string,
  countrycode = '86'
): Promise<{ ok: boolean; message: string }> {
  if (!/^1\d{10}$/.test(phone.trim())) return { ok: false, message: '手机号格式不对' }
  // 注意是过去式 sent，/send 会返回「接口未找到」
  const { json } = await wapiPost('/weapi/sms/captcha/sent?csrf_token=', {
    cellphone: phone.trim(),
    ctcode: countrycode,
    captcha: ''
  })
  if (json?.code === 200) return { ok: true, message: '验证码已发送，注意查收短信' }
  return { ok: false, message: pickError(json, '验证码发送失败') }
}

/** 手机号登录：验证码或密码二选一。成功后 Cookie 与账号信息一并落库并广播。 */
export async function loginCellphone(args: CellphoneLoginArgs): Promise<CellphoneLoginResult> {
  const phone = args.phone.trim()
  const countrycode = args.countrycode || '86'
  if (!/^1\d{10}$/.test(phone)) return { ok: false, message: '手机号格式不对' }

  const byPassword = Boolean(args.password)
  if (!byPassword && !args.captcha) return { ok: false, message: '请输入验证码' }
  if (byPassword && (args.password ?? '').length < 6) return { ok: false, message: '密码太短' }

  // 验证码登录走 /w/login/cellphone，密码登录走 /login/cellphone（密码 md5）
  const path = byPassword ? '/weapi/login/cellphone' : '/weapi/w/login/cellphone'
  const data: Record<string, unknown> = { phone, countrycode, rememberLogin: 'true' }
  if (byPassword) data.password = createHash('md5').update(args.password ?? '').digest('hex')
  else data.captcha = args.captcha

  const { json, setCookies } = await wapiPost(path, data)
  if (json?.code !== 200) return { ok: false, message: pickError(json, '登录失败') }

  // Cookie 优先取 Set-Cookie（干净），退回响应体里的 cookie 字符串（与扫码登录同策略）
  const musicU = cookieFromHeader(setCookies, 'MUSIC_U')
  const csrf = cookieFromHeader(setCookies, '__csrf')
  let cookie = ''
  if (musicU) {
    const parts = [`MUSIC_U=${musicU}`]
    if (csrf) parts.push(`__csrf=${csrf}`)
    parts.push('__remember_me=true')
    cookie = parts.join('; ')
  } else if (typeof json.cookie === 'string' && json.cookie.includes('MUSIC_U=')) {
    cookie = json.cookie
  }
  if (!cookie) return { ok: false, message: '登录成功但未拿到登录态，请重试' }

  const profile = json.profile as Record<string, unknown> | undefined
  const account = json.account as { id?: number } | undefined
  const info: NeteaseAccountInfo = {
    userId: Number(account?.id ?? profile?.userId ?? 0),
    nickname: typeof profile?.nickname === 'string' ? profile.nickname : '',
    avatarUrl: typeof profile?.avatarUrl === 'string' ? profile.avatarUrl : '',
    vipType: Number(profile?.vipType ?? 0)
  }
  await settings.set({ neteaseCookie: cookie, neteaseAccount: info })
  notifyLoginSuccess('netease', cookie)
  return { ok: true, account: info }
}
