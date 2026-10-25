import { existsSync } from 'node:fs'
import { app } from 'electron'
import { bridgeScript, musicdlDirs } from '../paths'
import { engine, EngineCallError, type EngineEvent } from './python'
import type { EngineStatus } from './types'

/** 引擎侧一首歌的原始形态（对应 musicdl SongInfo 的裁剪视图） */
export interface EngineSong {
  /** 源内稳定 id（musicdl identifier 或元信息 md5） */
  id: string
  /** 进程内句柄，用于跳过重新搜索直接取地址 */
  token: string
  name: string
  singers: string
  album: string
  ext: string
  durationMs: number
  sizeBytes: number
  bitrate: number
  codec: string
  coverUrl: string
  hasUrl: boolean
  protocol: string
}

export interface EngineSearchResult {
  items: EngineSong[]
  total: number
  page: number
  hasMore: boolean
  cost?: number
}

export interface EngineResolveResult {
  url: string
  headers: Record<string, string>
  cookies: Record<string, string>
  ext: string
  size: number
  bitrate: number
  codec: string
  /** HTTP | HLS */
  protocol: string
  token: string
  lyric: string
  coverUrl: string
}

export interface EngineTagPayload {
  path: string
  title: string
  artists: string
  album: string
  lyric?: string
}

export interface ResolveQuery {
  source: string
  token?: string
  name?: string
  artists?: string
  durationMs?: number
  keyword?: string
}

/**
 * musicdl 引擎的类型化门面。
 *
 * 只做三件事：参数整形、错误归一化、把「引擎没装」翻译成用户能懂的提示。
 * 业务判断（换源、缓存、落库）仍然在 services 层，避免引擎细节外溢。
 */
class MusicdlEngine {
  async search(source: string, keyword: string, page = 1, limit = 20): Promise<EngineSearchResult> {
    return engine.call<EngineSearchResult>('search', { source, keyword, page, limit }, 60_000)
  }

  /** 流式搜索：每解析出一首就回调一次，全部结束后返回完整结果 */
  async searchStream(
    source: string,
    keyword: string,
    page: number,
    limit: number,
    onItems: (items: EngineSong[]) => void
  ): Promise<EngineSearchResult> {
    return engine.callStream<EngineSearchResult>(
      'search',
      { source, keyword, page, limit },
      (items) => onItems(items as EngineSong[]),
      60_000
    )
  }

  async resolve(query: ResolveQuery): Promise<EngineResolveResult> {
    return engine.call<EngineResolveResult>(
      'resolve',
      {
        source: query.source,
        token: query.token,
        name: query.name,
        artists: query.artists,
        durationMs: query.durationMs,
        keyword: query.keyword
      },
      60_000
    )
  }

  async lyric(query: ResolveQuery): Promise<{ lyric: string; source: string }> {
    return engine.call<{ lyric: string; source: string }>('lyric', { ...query }, 60_000)
  }

  /** HLS 只能交给引擎合并分片；HTTP 直链走主进程自己的下载器 */
  async downloadHls(
    query: ResolveQuery,
    path: string,
    taskId: string,
    onProgress: (received: number, total: number) => void
  ): Promise<{ path: string; size: number }> {
    const off = engine.onEvent((event: EngineEvent) => {
      if (event.event !== 'progress' || event.taskId !== taskId) return
      onProgress(event.received ?? 0, event.total ?? 0)
    })
    try {
      return await engine.call<{ path: string; size: number }>(
        'download',
        { ...query, path, taskId },
        30 * 60_000
      )
    } finally {
      off()
    }
  }

  async tag(payload: EngineTagPayload): Promise<{ ok: boolean; skipped?: string; error?: string }> {
    return engine.call('tag', { ...payload }, 20_000)
  }

  status(): EngineStatus {
    const base = engine.status()
    const bridgeFound = existsSync(bridgeScript())
    const musicdlFound = musicdlDirs().length > 0
    return { ...base, bridgeFound, musicdlFound, packaged: app.isPackaged }
  }

  /** 设置页的「检测引擎」按钮：强制重启并回报结果 */
  async restart(): Promise<EngineStatus> {
    await engine.stop()
    try {
      await engine.ensure()
    } catch {
      /* 错误已记录在 status().error */
    }
    return this.status()
  }
}

export const musicdl = new MusicdlEngine()
export { EngineCallError }
