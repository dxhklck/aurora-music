import * as tsEngine from './ts'
import type { EngineStatus } from './types'
import type { ResolveQuery } from './ts/types'
import type { TagPayload } from './ts/tag-types'

/**
 * 音源引擎门面。
 *
 * 实现全部在 `./ts`（进程内 TypeScript，无子进程、无外部运行时依赖）。
 * 这里只保留上层依赖的窄接口与状态视图；业务判断（换源、缓存、落库）仍在 services 层。
 */

export type { EngineSong, EngineSearchResult, EngineResolveResult } from './ts'
export type { ResolveQuery } from './ts/types'
export type EngineTagPayload = TagPayload

class MusicdlEngine {
  async search(
    source: string,
    keyword: string,
    page: number,
    limit: number
  ): Promise<tsEngine.EngineSearchResult> {
    return tsEngine.search({ source, keyword, page, limit })
  }

  /** 流式搜索：每解析出一首就回调一次，全部结束后返回完整结果 */
  async searchStream(
    source: string,
    keyword: string,
    page: number,
    limit: number,
    onItems: (items: tsEngine.EngineSong[]) => void
  ): Promise<tsEngine.EngineSearchResult> {
    return tsEngine.search({ source, keyword, page, limit }, onItems)
  }

  async resolve(query: ResolveQuery): Promise<tsEngine.EngineResolveResult> {
    return tsEngine.resolve(query)
  }

  async lyric(query: ResolveQuery): Promise<{ lyric: string; source: string }> {
    return tsEngine.lyric(query)
  }

  /** HLS 只能交给引擎合并分片；HTTP 直链走主进程自己的下载器 */
  async downloadHls(
    query: ResolveQuery,
    path: string,
    taskId: string,
    onProgress: (received: number, total: number) => void,
    signal?: AbortSignal
  ): Promise<{ path: string; size: number }> {
    return tsEngine.downloadHlsTo({ ...query, path, taskId, signal }, onProgress)
  }

  async tag(payload: TagPayload): Promise<{ ok: boolean; skipped?: string; error?: string }> {
    return tsEngine.tag(payload)
  }

  /** 进程内实现：导入成功即可用，不存在「运行时就绪」这一说 */
  status(): EngineStatus {
    return {
      ready: true,
      runtime: {
        command: 'node',
        label: '内置 TypeScript 引擎',
        version: process.versions.node,
        sources: tsEngine.sources().length
      },
      error: '',
      health: tsEngine.sourceHealth()
    }
  }

  /** 设置页的「重新检测」：清缓存后重新报告状态 */
  restart(): EngineStatus {
    tsEngine.reset()
    return this.status()
  }
}

export const musicdl = new MusicdlEngine()
