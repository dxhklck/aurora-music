/**
 * 扫码登录服务。
 *
 * 设计约束（与手动粘贴 Cookie 同一条合规底线）：
 * - Aurora 不内置任何账号；二维码由用户本人用手机 App 扫描授权，
 *   拿到的 Cookie 就是用户自己的登录态，与在浏览器里 F12 复制等价。
 * - 本文件不 import electron：广播通过 onLoginSuccess 回调由 ipc 层注入，
 *   这样纯函数部分可以在 node 环境下直接单测。
 *
 * 支持的平台：
 * - QQ 音乐：ptqrshow 二维码 + ptqrlogin 轮询 + check_sig/authorize 换 CGI 凭据
 *   （参照 QQ 音乐网页版登录流程；ptuiCB 事件码 66 等待 / 67 已扫 / 65 过期 / 0 成功）
 * - 网易云音乐：weapi 加密取 unikey + client/login 轮询
 *   （事件码 800 过期 / 801 等待 / 802 待确认 / 803 成功）
 *
 * 其余内置平台没有登录增益或没有公开登录流程：
 * - 酷我：搜索/取址走免 token 老接口，匿名即可完整使用；
 * - 引擎音源（酷狗/咪咕/千千等）：musicdl bridge 不支持注入 Cookie，暂不接入。
 */

import { randomUUID } from 'node:crypto'
import { toDataURL } from 'qrcode'
import { settings } from './settings'
import {
  composeQQCookie,
  cookieFromHeader,
  hash33,
  parsePtuiCB,
  wapiBody
} from './qrlogin-util'
import type { QrLoginPlatform, QrLoginPhase, QrLoginState } from '@shared/types'

const UA_PC =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const UA_QQ = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQMusic/20.0'

/** 二维码有效期（秒）：平台自己的过期码（65/800）才是权威，这里只是前端倒计时 */
const QQ_QR_TTL = 170
const NETEASE_QR_TTL = 240

/* ------------------------------------------------------------------ *
 * 平台适配器
 * ------------------------------------------------------------------ */

interface QrAdapter {
  /** 创建二维码：返回图片 dataURL 与过期时刻 */
  create(): Promise<{ qrImage: string; expiresAt: number }>
  /** 轮询一次状态；成功时内部完成 Cookie 落库 */
  check(): Promise<{ phase: QrLoginPhase; message: string }>
}

class QqQrAdapter implements QrAdapter {
  private qrsig = ''

  async create(): Promise<{ qrImage: string; expiresAt: number }> {
    const res = await fetch(
      'https://ssl.ptlogin2.qq.com/ptqrshow?' +
        new URLSearchParams({
          appid: '716027609',
          e: '2',
          l: 'M',
          s: '3',
          d: '72',
          v: '4',
          t: String(Math.random()),
          daid: '383',
          pt_3rd_aid: '100497308'
        }),
      { headers: { Referer: 'https://xui.ptlogin2.qq.com/', 'User-Agent': UA_QQ } }
    )
    const qrsig = res.headers
      .getSetCookie()
      .map((item) => item.split(';')[0] ?? '')
      .find((item) => item.startsWith('qrsig='))
      ?.slice('qrsig='.length)
    if (!res.ok || !qrsig) throw new Error('获取 QQ 二维码失败')
    this.qrsig = qrsig
    const png = Buffer.from(await res.arrayBuffer())
    return {
      qrImage: `data:image/png;base64,${png.toString('base64')}`,
      expiresAt: Date.now() + QQ_QR_TTL * 1000
    }
  }

  async check(): Promise<{ phase: QrLoginPhase; message: string }> {
    if (!this.qrsig) return { phase: 'error', message: '会话已失效，请刷新二维码' }
    const params = new URLSearchParams({
      u1: 'https://graph.qq.com/oauth2.0/login_jump',
      ptqrtoken: String(hash33(this.qrsig)),
      ptredirect: '0',
      h: '1',
      t: '1',
      g: '1',
      from_ui: '1',
      ptlang: '2052',
      action: `0-0-${Date.now()}`,
      js_ver: '20102616',
      js_type: '1',
      pt_uistyle: '40',
      aid: '716027609',
      daid: '383',
      pt_3rd_aid: '100497308',
      has_onekey: '1'
    })
    const res = await fetch(`https://ssl.ptlogin2.qq.com/ptqrlogin?${params}`, {
      headers: {
        Referer: 'https://xui.ptlogin2.qq.com/',
        'User-Agent': UA_QQ,
        Cookie: `qrsig=${this.qrsig}`
      }
    })
    const parsed = parsePtuiCB(await res.text())
    if (!parsed) return { phase: 'error', message: '无法解析登录状态' }
    switch (parsed.code) {
      case '0':
        break
      case '65':
        return { phase: 'expired', message: '二维码已过期，请刷新' }
      case '66':
        return { phase: 'pending', message: '等待扫码' }
      case '67':
        return { phase: 'scanned', message: '已扫描，请在手机上确认' }
      case '68':
        return { phase: 'error', message: '你拒绝了本次登录' }
      default:
        return { phase: 'error', message: `未知状态：${parsed.code}` }
    }
    // 登录成功：args[2] 是带 ptsigx 与 uin 的跳转地址
    const jumpUrl = parsed.args[2] ?? ''
    const sigx = /(?:\?|&)ptsigx=(.+?)&s_url/.exec(jumpUrl)?.[1]
    const uin = /(?:\?|&)uin=(.+?)&service/.exec(jumpUrl)?.[1]
    if (!sigx || !uin) return { phase: 'error', message: '登录成功但凭据解析失败' }
    try {
      const cookie = await this.authorize(uin, sigx)
      if (!cookie) return { phase: 'error', message: '授权失败，请重试' }
      await settings.set({ qqCookie: cookie })
      notifyLoginSuccess('qq', cookie)
      return { phase: 'success', message: '登录成功' }
    } catch {
      return { phase: 'error', message: '授权过程网络异常，请重试' }
    }
  }

  /** check_sig 拿 p_skey → authorize 拿 code → CGI 换 musicid/musickey → 拼 web Cookie */
  private async authorize(uin: string, sigx: string): Promise<string> {
    const sig = await fetch(
      'https://ssl.ptlogin2.graph.qq.com/check_sig?' +
        new URLSearchParams({
          uin,
          pttype: '1',
          service: 'ptqrlogin',
          nodirect: '0',
          ptsigx: sigx,
          s_url: 'https://graph.qq.com/oauth2.0/login_jump',
          ptlang: '2052',
          ptredirect: '100',
          aid: '716027609',
          daid: '383',
          j_later: '0',
          low_login_hour: '0',
          regmaster: '0',
          pt_login_type: '3',
          pt_aid: '0',
          pt_aaid: '16',
          pt_light: '0',
          pt_3rd_aid: '100497308'
        }),
      {
        headers: { Referer: 'https://xui.ptlogin2.qq.com/', 'User-Agent': UA_QQ },
        redirect: 'manual'
      }
    )
    const sigCookies = sig.headers.getSetCookie()
    const pSkey = cookieFromHeader(sigCookies, 'p_skey')
    if (!pSkey) return ''

    const auth = await fetch('https://graph.qq.com/oauth2.0/authorize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA_QQ,
        Cookie: sigCookies.map((item) => item.split(';')[0]).join('; ')
      },
      body: new URLSearchParams({
        response_type: 'code',
        client_id: '100497308',
        redirect_uri:
          'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
        scope: 'get_user_info,get_app_friends',
        state: 'state',
        switch: '',
        from_ptlogin: '1',
        src: '1',
        update_auth: '1',
        openapi: '1010_1030',
        g_tk: String(hash33(pSkey, 5381)),
        auth_time: String(Date.now()),
        ui: randomUUID()
      }),
      redirect: 'manual'
    })
    const location = auth.headers.get('location') ?? ''
    const code = /(?<=code=)(.+?)(?=&)/.exec(location)?.[1]
    if (!code) return ''

    const body = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': UA_QQ },
      body: JSON.stringify({
        req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } },
        comm: { tmeLoginType: 2, ct: 24, cv: 0, format: 'json' }
      })
    })
      .then((r) => r.json())
      .catch(() => null)
    const data = (body as { req?: { data?: Record<string, unknown> } } | null)?.req?.data
    const musicid = data?.musicid
    const musickey = typeof data?.musickey === 'string' ? data.musickey : ''
    if (!musicid || !musickey) return ''
    return composeQQCookie(musicid as string | number, musickey)
  }
}

class NeteaseQrAdapter implements QrAdapter {
  private unikey = ''

  async create(): Promise<{ qrImage: string; expiresAt: number }> {
    const res = await fetch('https://music.163.com/weapi/login/qrcode/unikey', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com/',
        'User-Agent': UA_PC
      },
      body: new URLSearchParams(wapiBody({ type: 1 })).toString()
    })
    const json = (await res.json().catch(() => null)) as { unikey?: string } | null
    if (!json?.unikey) throw new Error('获取网易云二维码失败')
    this.unikey = json.unikey
    const qrImage = await toDataURL(`https://music.163.com/login?codekey=${this.unikey}`, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M'
    })
    return { qrImage, expiresAt: Date.now() + NETEASE_QR_TTL * 1000 }
  }

  async check(): Promise<{ phase: QrLoginPhase; message: string }> {
    if (!this.unikey) return { phase: 'error', message: '会话已失效，请刷新二维码' }
    const res = await fetch('https://music.163.com/weapi/login/qrcode/client/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com/',
        'User-Agent': UA_PC
      },
      body: new URLSearchParams(
        wapiBody({ key: this.unikey, timestamp: Date.now(), type: 1 })
      ).toString()
    })
    const setCookies = res.headers.getSetCookie()
    const json = (await res.json().catch(() => null)) as {
      code?: number
      cookie?: string
      message?: string
    } | null
    const code = json?.code ?? -1
    if (code === 803) {
      // 优先用 Set-Cookie（干净），退回响应体里的 cookie 字符串
      const musicU = cookieFromHeader(setCookies, 'MUSIC_U')
      const csrf = cookieFromHeader(setCookies, '__csrf')
      const remember = cookieFromHeader(setCookies, '__remember_me')
      const parts: string[] = []
      if (musicU) parts.push(`MUSIC_U=${musicU}`)
      if (csrf) parts.push(`__csrf=${csrf}`)
      parts.push(`__remember_me=${remember || 'true'}`)
      const cookie = musicU ? parts.join('; ') : (json?.cookie ?? '')
      if (!cookie) return { phase: 'error', message: '登录成功但未拿到 Cookie' }
      await settings.set({ neteaseCookie: cookie })
      notifyLoginSuccess('netease', cookie)
      return { phase: 'success', message: '登录成功' }
    }
    if (code === 800) return { phase: 'expired', message: '二维码已过期，请刷新' }
    if (code === 801) return { phase: 'pending', message: '等待扫码' }
    if (code === 802) return { phase: 'scanned', message: '已扫描，请在手机上确认' }
    return { phase: 'error', message: json?.message ?? `未知状态：${code}` }
  }
}

/* ------------------------------------------------------------------ *
 * 会话管理
 * ------------------------------------------------------------------ */

const adapters: Record<QrLoginPlatform, () => QrAdapter> = {
  qq: () => new QqQrAdapter(),
  netease: () => new NeteaseQrAdapter()
}

let current: { adapter: QrAdapter; state: QrLoginState } | null = null

/** 登录成功回调（由 ipc 层注入：刷新 provider 缓存 + 广播设置变更） */
type LoginSuccessHandler = (platform: QrLoginPlatform, cookie: string) => void
const successHandlers = new Set<LoginSuccessHandler>()

export function onLoginSuccess(handler: LoginSuccessHandler): () => void {
  successHandlers.add(handler)
  return () => successHandlers.delete(handler)
}

/** 广播登录成功（扫码与浏览器内登录共用） */
export function notifyLoginSuccess(platform: QrLoginPlatform, cookie: string): void {
  for (const handler of successHandlers) handler(platform, cookie)
}

/** 发起登录：返回当前会话状态（含二维码图片） */
export async function startQrLogin(platform: QrLoginPlatform): Promise<QrLoginState> {
  const adapter = adapters[platform]()
  const { qrImage, expiresAt } = await adapter.create()
  current = {
    adapter,
    state: {
      platform,
      phase: 'pending',
      qrImage,
      message: '等待扫码',
      expiresAt
    }
  }
  return { ...current.state }
}

/** 轮询一次；没有进行中的会话时返回 idle */
export async function pollQrLogin(): Promise<QrLoginState> {
  if (!current) {
    return { platform: 'qq', phase: 'idle', qrImage: '', message: '', expiresAt: 0 }
  }
  const result = await current.adapter.check()
  const next: QrLoginState = {
    ...current.state,
    phase: result.phase,
    message: result.message
  }
  // 成功后会话即结束（前端凭 success 状态关闭弹层）；错误/过期态保留适配器以便刷新
  if (result.phase === 'success') current = null
  return next
}

/** 取消登录（关闭弹层时调用） */
export function cancelQrLogin(): void {
  current = null
}
