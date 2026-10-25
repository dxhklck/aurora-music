/**
 * 扫码登录的纯函数层：零本地依赖（只用 node:crypto），可被单测直接引用。
 * 具体的网络流程在 qrlogin.ts。
 */

import { constants, createCipheriv, publicEncrypt, randomInt } from 'node:crypto'

/**
 * QQ ptqrtoken 算法（hash33）：与网页版登录 JS 一致。
 * h = (h << 5) + h + c，最后取低 31 位。
 */
export function hash33(input: string, seed = 0): number {
  let h = seed | 0
  for (const char of input) {
    h = ((h << 5) + h + char.charCodeAt(0)) | 0
  }
  return 2147483647 & h
}

export interface PtuiCBResult {
  code: string
  args: string[]
}

/** 解析 ptuiCB('66','0','','0','二维码未失效。', '') 形式的响应 */
export function parsePtuiCB(text: string): PtuiCBResult | null {
  const match = /ptuiCB\(([\s\S]*?)\)/.exec(text)
  if (!match) return null
  const args = [...match[1].matchAll(/'((?:\\.|[^'])*)'/g)].map((item) => item[1])
  if (!args.length || !/^\d+$/.test(args[0])) return null
  return { code: args[0], args }
}

/** 从 Set-Cookie 头列表里取指定名字的值 */
export function cookieFromHeader(setCookies: string[], name: string): string {
  const lower = name.toLowerCase()
  for (const raw of setCookies) {
    const pair = raw.split(';')[0] ?? ''
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    if (pair.slice(0, idx).trim().toLowerCase() === lower) {
      return pair.slice(idx + 1).trim()
    }
  }
  return ''
}

/** 拼装 y.qq.com web 端可用的 QQ Cookie（musicid/musickey 来自 CGI 登录凭据） */
export function composeQQCookie(musicid: string | number, musickey: string): string {
  return `uin=o${musicid}; qm_keyst=${musickey}; qqmusic_key=${musickey}; tmeLoginType=1`
}

/* ---------------- 网易云 weapi 加密（网页版同款） ---------------- */

const WAPI_IV = Buffer.from('0102030405060708', 'utf8')
const WAPI_PRESET_KEY = '0CoJUm6Qyw8W8jud'
const WAPI_PUB_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`
const WAPI_B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** AES-128-CBC（PKCS7）→ base64；Node crypto 自带，无需三方库 */
export function wapiAes(text: string, key: string): string {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), WAPI_IV)
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64')
}

/** weapi 请求体：params 双重 AES（第二轮用随机密钥的倒序），encSecKey 为随机密钥的 RSA */
export function wapiBody(data: unknown): { params: string; encSecKey: string } {
  const secret = Array.from({ length: 16 }, () => WAPI_B62[randomInt(62)]).join('')
  const reversed = [...secret].reverse().join('')
  const params = wapiAes(wapiAes(JSON.stringify(data), WAPI_PRESET_KEY), reversed)
  const buffer = Buffer.alloc(128)
  buffer.write(secret, 128 - secret.length, 'utf8')
  const encSecKey = publicEncrypt(
    { key: WAPI_PUB_KEY, padding: constants.RSA_NO_PADDING },
    buffer
  ).toString('hex')
  return { params, encSecKey }
}
