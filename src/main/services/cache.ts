/**
 * 带 TTL + 容量上限的内存缓存，并做 in-flight 合并：
 * 同一个 key 的并发请求只会真正打一次上游（搜索页连点时很关键）。
 */
export class TtlCache<T> {
  private store = new Map<string, { value: T; expireAt: number }>()
  private inflight = new Map<string, Promise<T>>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expireAt < Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T, ttlMs = this.ttlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value
      if (oldest) this.store.delete(oldest)
    }
    this.store.set(key, { value, expireAt: Date.now() + ttlMs })
  }

  async wrap(key: string, factory: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
    const cached = this.get(key)
    if (cached !== undefined) return cached

    const running = this.inflight.get(key)
    if (running) return running

    const task = factory()
      .then((value) => {
        this.set(key, value, ttlMs)
        return value
      })
      .finally(() => {
        this.inflight.delete(key)
      })
    this.inflight.set(key, task)
    return task
  }

  clear(): void {
    this.store.clear()
    this.inflight.clear()
  }
}
