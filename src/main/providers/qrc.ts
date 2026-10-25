import { createDecipheriv } from 'node:crypto'
import { inflateSync } from 'node:zlib'

/**
 * QQ 音乐 QRC 逐字歌词解密。
 *
 * QRC 的构造（与 QQMusicApi / 各开源实现的结论一致）：
 *   1. 原始 XML（<Qrc><LyricContent>…[起始ms,时长ms]字(起始ms,时长ms,0)…</LyricContent></Qrc>）
 *   2. zlib 压缩（带 zlib 头，非裸 deflate）
 *   3. 3DES-ECB 加密，密钥 `!@#)(*$%123ZXC!@!@#)(NHL`（24 字节），无 PKCS 填充
 *      （musicu PlayLyricInfo 的 crypt=1 分支；另有旧式变体见下方注释）
 *   4. 输出 hex 文本
 *
 * Node 的 `des-ede3` 即 OpenSSL 的 3DES-EDE，与 Python Crypto 的 DES3.MODE_ECB 互通
 * （已用 Python 加密 → Node 解密交叉验证）。
 */

const QRC_KEY = Buffer.from('!@#)(*$%123ZXC!@!@#)(NHL')

export class QrcDecryptError extends Error {}

/** 解密 hex 文本，返回解压后的 XML 原文 */
export function decryptQrc(hex: string): string {
  const payload = Buffer.from(hex.trim(), 'hex')
  if (payload.length === 0 || payload.length % 8 !== 0) {
    throw new QrcDecryptError('QRC 长度不是 8 的倍数，可能不是加密歌词')
  }
  let decrypted: Buffer
  try {
    const decipher = createDecipheriv('des-ede3', QRC_KEY, null)
    decipher.setAutoPadding(false)
    decrypted = Buffer.concat([decipher.update(payload), decipher.final()])
  } catch {
    throw new QrcDecryptError('3DES 解密失败，密钥或数据不匹配')
  }
  // 解密结果 = zlib 流 + 尾部对齐空白；zlib 解压到流尾即停，尾部垃圾被忽略
  try {
    return inflateSync(decrypted).toString('utf8')
  } catch {
    throw new QrcDecryptError('zlib 解压失败')
  }
}

/** 取出 <LyricContent> 里的正文字本（含 [ti:]/[ar:] 元数据行，由 parseYrc 过滤） */
export function extractQrcLyric(xml: string): string {
  const match = xml.match(/<LyricContent>([\s\S]*?)<\/LyricContent>/i)
  const content = match ? match[1] : xml
  return decodeXmlEntities(content)
}

/** QRC 只转义这几个实体；还原后才能正确显示歌词文字 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
