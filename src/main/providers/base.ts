import type { StreamInfo } from '@shared/types'
import { ProviderError, type MusicProvider, type SearchArgs } from './types'
import type { ChartSummary, Lyric, ProviderInfo, Quality, SearchPage, Song } from '@shared/types'
import { sleep } from '../utils'

export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'

/**
 * 过滤「假的最终地址」。
 *
 * 移动端 CapacitorHttp 接管 window.fetch 后，重定向后的 response.url 会变成
 * http://localhost/_capacitor_http_xxx（本地缓存/拦截地址），把它当最终地址
 * 再送进媒体代理，Audio 必然 NotSupportedError（真机实锤：登录后所有走
 * probe 的网易云歌曲都播不了）。这里只接受真正的外网 http(s) 地址。
 */
function sanitizeFinalUrl(candidate: string | undefined, fallback: string): string {
  if (!candidate || !/^https?:\/\//i.test(candidate)) return fallback
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(candidate)) return fallback
  return candidate
}

export interface ProbeResult {
  ok: boolean
  status: number
  contentType: string
  size: number
  finalUrl: string
}

/**
 * 适配器基类。把「重试、超时、探测、错误归一化」这些与平台无关的能力收在一处，
 * 子类只需要实现 search / charts / chartDetail / resolveStream / lyric。
 * 对应 musicdl BaseMusicClient 的模板方法 + get/post 重试逻辑。
 */
export abstract class BaseProvider implements MusicProvider {
  abstract readonly info: ProviderInfo

  protected abstract baseHeaders(): Record<string, string>

  protected timeoutMs = 12_000
  protected retries = 2

  async search(_args: SearchArgs): Promise<SearchPage> {
    throw new ProviderError('unsupported', `${this.info.name} 暂不支持搜索`, this.info.id)
  }

  async charts(): Promise<ChartSummary[]> {
    return []
  }

  async chartDetail(_args: { id: string; page: number; limit: number }): Promise<SearchPage> {
    throw new ProviderError('unsupported', `${this.info.name} 暂不支持榜单`, this.info.id)
  }

  async resolveStream(_song: Song, _quality: Quality): Promise<StreamInfo> {
    throw new ProviderError('unsupported', `${this.info.name} 不提供播放`, this.info.id)
  }

  async lyric(_song: Song): Promise<Lyric | null> {
    return null
  }

  /** 带指数退避的请求；4xx 不重试，5xx/网络错误重试 */
  protected async request(
    url: string,
    init: RequestInit = {},
    retries = this.retries
  ): Promise<Response> {
    const headers = { ...this.baseHeaders(), ...((init.headers as Record<string, string>) ?? {}) }
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs)
        })
        if (response.status >= 500 && attempt < retries) {
          lastError = new ProviderError('network', `HTTP ${response.status}`, this.info.id)
          await sleep(350 * (attempt + 1))
          continue
        }
        if (!response.ok) {
          throw new ProviderError(
            response.status === 403 || response.status === 401 ? 'blocked' : 'network',
            `HTTP ${response.status}`,
            this.info.id
          )
        }
        return response
      } catch (error) {
        lastError = error
        if (error instanceof ProviderError && error.code === 'blocked') throw error
        if (attempt < retries) await sleep(350 * (attempt + 1))
      }
    }
    if (lastError instanceof ProviderError) throw lastError
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new ProviderError('network', `${this.info.name} 请求失败：${message}`, this.info.id)
  }

  protected async text(url: string, init: RequestInit = {}, retries = this.retries): Promise<string> {
    const response = await this.request(url, init, retries)
    return response.text()
  }

  protected async json<T>(url: string, init: RequestInit = {}, retries = this.retries): Promise<T> {
    const raw = await this.text(url, init, retries)
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new ProviderError('parse', `${this.info.name} 返回了无法解析的数据`, this.info.id)
    }
  }

  protected async form<T>(
    url: string,
    data: Record<string, string | number>,
    referer?: string,
    retries = this.retries
  ): Promise<T> {
    return this.json<T>(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(referer ? { Referer: referer } : {})
        },
        body: new URLSearchParams(
          Object.entries(data).map(([k, v]) => [k, String(v)])
        ).toString()
      },
      retries
    )
  }

  /**
   * 实测媒体地址是否真的可播。很多平台会在「取地址」这一步返回 200，
   * 但实际是 404 页面或 JSON 错误体，musicdl 用 AudioLinkTester 做同样的事。
   *
   * `extraHeaders` 用于引擎音源：酷狗/咪咕的直链要带上引擎算出来的 Cookie 才能过校验。
   */
  protected async probe(
    url: string,
    referer?: string,
    extraHeaders?: Record<string, string>
  ): Promise<ProbeResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          ...this.baseHeaders(),
          ...(extraHeaders ?? {}),
          Range: 'bytes=0-1',
          ...(referer ? { Referer: referer } : {})
        },
        redirect: 'follow',
        signal: controller.signal
      })
      const contentType = response.headers.get('content-type') ?? ''
      const length = Number(response.headers.get('content-range')?.split('/')[1] ?? 0)
      const isAudio =
        contentType.startsWith('audio/') ||
        contentType.includes('octet-stream') ||
        contentType.includes('video/mp4') ||
        contentType.includes('application/vnd.apple.mpegurl')
      const ok = (response.status === 200 || response.status === 206) && isAudio && !contentType.includes('text/html')
      // 及时释放 body，避免连接悬挂
      try {
        await response.body?.cancel()
      } catch {
        /* ignore */
      }
      return { ok, status: response.status, contentType, size: length, finalUrl: sanitizeFinalUrl(response.url, url) }
    } catch {
      return { ok: false, status: 0, contentType: '', size: 0, finalUrl: url }
    } finally {
      clearTimeout(timer)
    }
  }
}
