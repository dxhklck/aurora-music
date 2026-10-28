/**
 * Buffer 垫片（仅移动端桥加载）。
 *
 * 音源适配器（netease/qq/qrc）从 Electron 主进程搬进 WebView 时还带着
 * Node Buffer 用法：字节魔数探测（latin1）、base64/hex 解码、字节拼接。
 * 这里提供覆盖这些场景的最小实现——真实 Uint8Array 打上 toString 补丁，
 * 不引整包 polyfill，也不跟 lib.dom 的 Uint8Array 静态签名冲突。
 *
 * 不支持写入语义（用不到）；node:crypto 的加解密调用在 WebView 里
 * 由 __vite-browser-external 桩抛错，调用点均包了 try/catch 并有兜底。
 */

type Encoding = 'utf8' | 'utf-8' | 'latin1' | 'binary' | 'ascii' | 'base64' | 'hex'

interface MiniBuffer extends Uint8Array {
  toString(encoding?: Encoding): string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function bufToString(this: Uint8Array, encoding: Encoding = 'utf8'): string {
  const bytes = this
  if (encoding === 'base64') return bytesToBase64(bytes)
  if (encoding === 'hex') {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }
  if (encoding === 'latin1' || encoding === 'binary' || encoding === 'ascii') {
    return new TextDecoder('latin1').decode(bytes)
  }
  return new TextDecoder('utf-8').decode(bytes)
}

function wrap(bytes: Uint8Array): MiniBuffer {
  const buf = bytes as MiniBuffer
  buf.toString = bufToString
  return buf
}

function fromString(text: string, encoding: Encoding): MiniBuffer {
  if (encoding === 'base64') {
    const binary = atob(text)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return wrap(out)
  }
  if (encoding === 'hex') {
    const clean = text.replace(/[^0-9a-fA-F]/g, '')
    const out = new Uint8Array(Math.floor(clean.length / 2))
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
    }
    return wrap(out)
  }
  // utf8 / latin1 / ascii 统一走 TextEncoder（latin1 源串里只可能是 ASCII 魔数）
  return wrap(new TextEncoder().encode(text))
}

const BufferShim = {
  from(input: ArrayBuffer | ArrayBufferView | string, encoding: Encoding = 'utf8'): MiniBuffer {
    if (typeof input === 'string') return fromString(input, encoding)
    const bytes =
      input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array((input as ArrayBufferView).buffer, (input as ArrayBufferView).byteOffset, (input as ArrayBufferView).byteLength)
    return wrap(bytes)
  },
  alloc(size: number): MiniBuffer {
    return wrap(new Uint8Array(Math.max(0, Math.trunc(size))))
  },
  concat(list: ArrayLike<number>[]): MiniBuffer {
    let total = 0
    for (const item of list) total += item.length
    const out = new Uint8Array(total)
    let offset = 0
    for (const item of list) {
      out.set(item, offset)
      offset += item.length
    }
    return wrap(out)
  }
}

const target = globalThis as unknown as Record<string, unknown>
if (typeof target.Buffer === 'undefined') {
  target.Buffer = BufferShim
}

export {}
