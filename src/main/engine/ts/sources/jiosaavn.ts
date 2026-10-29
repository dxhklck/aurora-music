import { createDecipheriv } from 'node:crypto'
import { BaseSource, makeSong, probeFirst, type SourceConfig } from '../base'
import { parseJsonLoose } from '../http'
import { decodeEntities, safeGet, toFloat, toInt } from '../text'
import type { SearchContext, SongInfo } from '../types'

/**
 * JioSaavn（印度 / 南亚曲库）。
 *
 * 有两个必须原样搬过来的脏活：
 * 1. **媒体地址是 DES-ECB 加密的**，密钥固定为 `38346591`，解出来还要去掉 PKCS5 填充；
 * 2. **码率藏在文件名里**（`_96.mp4`），换档位只能做字符串替换，没有参数化接口。
 */

const API_URL = 'https://www.jiosaavn.com/api.php'
const DES_KEY = Buffer.from('38346591', 'utf8')
/**
 * OpenSSL 3 默认关掉了单 DES（`des-ecb` 会抛 `digital envelope routines::unsupported`），
 * 而打包后的 Electron 不能依赖 `--openssl-legacy-provider` 启动参数。
 * 三重 DES 在 K1=K2=K3 时与单 DES 完全等价（E(D(E(x))) = E(x)），
 * 且 3DES 仍在默认 provider 里，因此用它做等价替代。
 */
const DES3_KEY = Buffer.concat([DES_KEY, DES_KEY, DES_KEY])
const QUALITIES = ['320', '160', '96', '48', '12']
const EXTENSIONS = ['mp4', 'mp3', 'm4a']

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Content-Type': 'application/json'
}

/** DES-ECB 解密（用 3DES 等价替代，见 DES3_KEY 注释）；填充非法时按上游语义裁掉尾部 0x00 */
function desDecrypt(encoded: string): string {
  try {
    const decipher = createDecipheriv('des-ede3', DES3_KEY, null)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encoded, 'base64')), decipher.final()])
    // PKCS5 去填充；非法填充时按上游语义裁掉尾部 0x00
    const padLength = decrypted[decrypted.length - 1]
    const unpadded =
      padLength > 0 && padLength <= 8 && decrypted.length >= padLength ? decrypted.subarray(0, decrypted.length - padLength) : decrypted
    return unpadded.toString('utf8').replace(/\u0000+$/, '').trim()
  } catch {
    return ''
  }
}

/** 把任意码率后缀替换成目标码率，例如 `_96.mp4` → `_320.mp4` */
function normalizeMediaUrl(url: string, quality: string): string {
  let output = url.replace(/http:\/\//g, 'https://')
  for (const ext of EXTENSIONS) {
    for (const source of QUALITIES) {
      output = output.split(`_${source}.${ext}`).join(`_${quality}.${ext}`)
    }
  }
  return output
}

function decodeUrl(encrypted: string): string {
  if (!encrypted || typeof encrypted !== 'string') return ''
  return desDecrypt(encrypted).replace(/http:\/\//g, 'https://')
}

export class JiosaavnSource extends BaseSource {
  constructor(config: Partial<SourceConfig> = {}) {
    super({
      key: 'jiosaavn',
      label: 'JioSaavn',
      pageSize: 3,
      headers: HEADERS,
      ...config
    })
  }

  protected buildUrls(keyword: string, perPage: number, size: number): string[] {
    const urls: string[] = []
    let count = 0
    while (size > count) {
      const params = new URLSearchParams({
        p: String(Math.floor(count / perPage) + 1),
        q: keyword,
        _format: 'json',
        _marker: '0',
        api_version: '4',
        ctx: 'web6dot0',
        n: String(perPage),
        __call: 'search.getResults'
      })
      urls.push(`${API_URL}?${params.toString()}`)
      count += perPage
    }
    return urls
  }

  protected async parsePage(url: string, ctx: SearchContext): Promise<void> {
    const response = await this.http.get(url)
    if (!response.ok) return
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    const results = safeGet(payload, ['results'], []) as Array<Record<string, unknown>>
    if (!Array.isArray(results)) return

    for (const result of results) {
      if (ctx.full) break
      try {
        const song = await this.parseOne(result)
        if (song && song.downloadUrl) ctx.push(song)
      } catch {
        /* 跳过单曲 */
      }
    }
  }

  private async parseOne(result: Record<string, unknown>): Promise<SongInfo | null> {
    const id = String(result.id ?? '')
    if (!id) return null

    const params = new URLSearchParams({
      __call: 'song.getDetails',
      cc: 'in',
      _format: 'json',
      _marker: '0',
      pids: id
    })
    const response = await this.http.get(`${API_URL}?${params.toString()}`)
    if (!response.ok) return null
    const download = parseJsonLoose<Record<string, unknown>>(response.text)
    const detail = (download[id] ?? {}) as Record<string, unknown>
    if (!detail || typeof detail !== 'object') return null

    const base =
      String(detail.media_url ?? '') ||
      decodeUrl(String(detail.encrypted_media_url ?? '')) ||
      decodeUrl(String(detail.encrypted_drm_media_url ?? '')) ||
      String(detail.media_preview_url ?? '')
    if (!base) return null

    for (const quality of QUALITIES) {
      const candidate = normalizeMediaUrl(base, quality)
      const probed = await probeFirst([candidate], { headers: this.playHeaders() })
      if (!probed) continue

      const durationS = toInt(toFloat(detail.duration))
      const lyric = await this.fetchLyric(id)
      return makeSong(this.key, {
        identifier: id,
        songName: detail.song,
        singers: detail.singers ?? detail.primary_artists,
        album: detail.album,
        ext: probed.ext,
        fileSizeBytes: probed.size,
        durationS,
        coverUrl: detail.image,
        downloadUrl: probed.url,
        headers: this.playHeaders(),
        protocol: probed.protocol,
        lyric,
        raw: { search: result, download }
      })
    }
    return null
  }

  private playHeaders(): Record<string, string> {
    return { 'User-Agent': HEADERS['User-Agent'] }
  }

  private async fetchLyric(id: string): Promise<string> {
    const params = new URLSearchParams({
      __call: 'lyrics.getLyrics',
      ctx: 'web6dot0',
      api_version: '4',
      _format: 'json',
      _marker: '0',
      lyrics_id: id
    })
    const response = await this.http.get(`${API_URL}?${params.toString()}`)
    if (!response.ok) return ''
    const payload = parseJsonLoose<Record<string, unknown>>(response.text)
    const html = String(payload.lyrics ?? '')
    if (!html) return ''
    return decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim()
  }
}
