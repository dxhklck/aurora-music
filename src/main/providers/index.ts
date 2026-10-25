import type { MusicProvider } from './types'
import { ProviderError } from './types'
import { NeteaseProvider } from './netease'
import { QQProvider } from './qq'
import { KuwoProvider } from './kuwo'
import { DemoProvider } from './demo'
import { LocalProvider } from './local'
import { MUSICDL_SOURCES, MusicdlProvider } from './musicdl'

/**
 * 音源注册表 —— 运行时切换的唯一入口。
 *
 * 扩展点：新增平台 = 实现 MusicProvider 接口 → 在这里 register 一行。
 * UI 的能力（搜索/榜单/播放/歌词）全部来自 info.capabilities，
 * 所以新增平台不需要改任何组件。
 */
class ProviderRegistry {
  private providers = new Map<string, MusicProvider>()

  register(provider: MusicProvider): void {
    this.providers.set(provider.info.id, provider)
  }

  unregister(id: string): void {
    this.providers.delete(id)
  }

  get(id: string): MusicProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new ProviderError('unsupported', `未知音源：${id}`, id)
    return provider
  }

  has(id: string): boolean {
    return this.providers.has(id)
  }

  list(): MusicProvider[] {
    return [...this.providers.values()]
  }

  infos() {
    return this.list().map((provider) => provider.info)
  }

  /** 换源候选：排除自身，且必须支持播放 */
  streamCandidates(excludeId: string): MusicProvider[] {
    return this.list().filter(
      (provider) => provider.info.id !== excludeId && provider.info.capabilities.stream
    )
  }
}

export const providers = new ProviderRegistry()

/** 原生适配器（TS 实现，不依赖外部运行时） */
export function bootstrapProviders(demoDir: string): void {
  providers.register(new NeteaseProvider())
  providers.register(new QQProvider())
  providers.register(new KuwoProvider())
  providers.register(new DemoProvider(demoDir))
  providers.register(new LocalProvider())
}

/**
 * 注册 musicdl 引擎承载的音源。
 *
 * 这里不阻塞启动去探测 Python：注册是纯内存操作，真正的可用性由第一次调用暴露，
 * 设置页会显示引擎状态。引擎没装时这些音源会给出「引擎未就绪」的明确提示，
 * 而不是静默消失让用户以为搜索坏了。
 */
export function registerEngineProviders(): string[] {
  const registered: string[] = []
  for (const spec of MUSICDL_SOURCES) {
    const provider = new MusicdlProvider(spec)
    providers.register(provider)
    registered.push(provider.info.id)
  }
  return registered
}

/** 关掉引擎音源（设置里关闭引擎时调用） */
export function unregisterEngineProviders(): void {
  for (const spec of MUSICDL_SOURCES) {
    providers.unregister(`mdl-${spec.key}`)
  }
}
