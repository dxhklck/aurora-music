/**
 * weapi 加密的纯 TS 实现（仅移动端桥使用）。
 *
 * 桌面版在主进程用 node:crypto（qrlogin-util.ts）；WebView 里没有
 * node:crypto，这里用 WebCrypto（AES-CBC）+ jsbn（RSA 裸加密）+
 * 自带 md5 等价实现，保证移动端也能走网易云手机号登录。
 * 算法与桌面版逐位一致（同一套 preset key / IV / 公钥）。
 *
 * 注意：RSA 必须用 jsbn（纯 ES5）而非 BigInt——BigInt 要 Chromium 67+，
 * vivo V1831A 等老 WebView（Chromium 66）解析到 BigInt 字面量直接
 * SyntaxError，整个模块报废，登录按钮「没反应」的真凶。
 */

import { BigInteger } from 'jsbn'

const AES_PRESET_KEY = '0CoJUm6Qyw8W8jud'
const AES_IV = '0102030405060708'
const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

// 网易云 web 版 RSA 公钥模数（与 qrlogin-util.ts 里 SPKI 同钥）
const RSA_N_HEX =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
const RSA_E_HEX = '10001'

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

async function aesEncrypt(text: string, key: string): Promise<string> {
  const rawKey = new TextEncoder().encode(key)
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, [
    'encrypt'
  ])
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new TextEncoder().encode(AES_IV) },
    cryptoKey,
    new TextEncoder().encode(text)
  )
  return bytesToBase64(new Uint8Array(encrypted))
}

/** RSA 裸加密（无填充，报文右对齐到 128 字节）→ 256 位 hex，与 node RSA_NO_PADDING 等价 */
function rsaNoPaddingHex(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const block = new Uint8Array(128)
  block.set(bytes, 128 - bytes.length)
  const hex = Array.from(block, (b) => b.toString(16).padStart(2, '0')).join('')
  const n = new BigInteger(RSA_N_HEX, 16)
  const e = new BigInteger(RSA_E_HEX, 16)
  const m = new BigInteger(hex, 16)
  return m.modPow(e, n).toString(16).padStart(256, '0')
}

/** weapi 请求体：params 双重 AES（第二轮用随机密钥倒序），encSecKey 为随机密钥的 RSA */
export async function wapiBody(data: unknown): Promise<{ params: string; encSecKey: string }> {
  let secret = ''
  for (let i = 0; i < 16; i++) {
    secret += B62[Math.floor(Math.random() * B62.length)]
  }
  const reversed = [...secret].reverse().join('')
  const params = await aesEncrypt(await aesEncrypt(JSON.stringify(data), AES_PRESET_KEY), reversed)
  return { params, encSecKey: rsaNoPaddingHex(secret) }
}

/* ---------------- md5（密码登录用，自实现避免再引库） ---------------- */

function toHexBytes(words: number[]): string {
  let out = ''
  for (const word of words) {
    for (let byte = 0; byte < 4; byte++) {
      out += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, '0')
    }
  }
  return out
}

export function md5Hex(text: string): string {
  // RFC 1321：小端字数组 + 标准 K/S 表
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ]
  const K = new Array<number>(64)
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296)
  }

  const bytes = new TextEncoder().encode(text)
  const bitLen = bytes.length * 8
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = new Array<number>(16)
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true)
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let i = 0; i < 64; i++) {
      let F: number
      let g: number
      if (i < 16) {
        F = (B & C) | (~B & D)
        g = i
      } else if (i < 32) {
        F = (D & B) | (~D & C)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        F = B ^ C ^ D
        g = (3 * i + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * i) % 16
      }
      F = (F + A + K[i] + M[g]) | 0
      A = D
      D = C
      C = B
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0
    }
    a0 = (a0 + A) | 0
    b0 = (b0 + B) | 0
    c0 = (c0 + C) | 0
    d0 = (d0 + D) | 0
  }
  return toHexBytes([a0, b0, c0, d0])
}
