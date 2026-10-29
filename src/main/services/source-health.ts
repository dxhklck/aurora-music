import { app } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { musicdl } from '../engine/musicdl'
import type { SourceHealthView } from '@shared/api'

/**
 * 上游健康巡检。
 *
 * 15 个引擎音源全是爬取实现，上游一改版就静默失效，而失效的表现是「这个源什么都搜不到」——
 * 用户分不清是「没这首歌」还是「这个源挂了」。这里定期给每个源发一次最小搜索（limit=1），
 * 结果落盘，设置页按源显色。
 *
 * 三条纪律：
 * 1. **慢启动**：应用起来 20 秒后才开始，别和用户第一次搜索抢带宽；
 * 2. **不并发轰炸**：同时最多 3 个在飞，每个之间错开 400ms，避免触发平台风控；
 * 3. **不天天扫**：结果 12 小时内复用，只有过期或用户手动点「重新检测」才重扫。
 */

/**
 * 探测关键词。
 *
 * 单个关键词会让一批源产生假阴性：用「周杰伦」探 SoundCloud / FMA / ccMixter 这些
 * 英文曲库，必然一条都没有，显示成「空」会让用户以为源坏了。所以先用英文泛词，
 * 空了再补一个中文词——只有两次都空才判定 empty。多花的请求只落在「本来就空」的源上。
 */
const PROBE_KEYWORDS = ['love', '周杰伦']
const PROBE_TIMEOUT = 25_000
const PROBE_CONCURRENCY = 3
const PROBE_GAP = 400
/** 结果保鲜期：上游改版没这么频繁，天天扫纯属给对方送风控分 */
const FRESH_MS = 12 * 60 * 60_000
const STARTUP_DELAY = 20_000

interface StoredEntry {
  ok: boolean
  /** 空结果：没报错但一条也没搜到，介于「好」和「坏」之间 */
  empty: boolean
  ms: number
  error: string
  checkedAt: number
  /** 连续失败次数，跨启动累计 */
  streak: number
}

interface StoredFile {
  checkedAt: number
  items: Record<string, StoredEntry>
}

let cache: StoredFile = { checkedAt: 0, items: {} }
let filePath = ''
let running = false
let started = false

async function load(): Promise<void> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredFile>
    if (parsed && typeof parsed === 'object' && parsed.items) {
      cache = { checkedAt: Number(parsed.checkedAt) || 0, items: parsed.items }
    }
  } catch {
    /* 首次运行没有文件，或文件损坏——用空结果继续，下次巡检会覆盖 */
  }
}

async function save(): Promise<void> {
  const tmp = `${filePath}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(cache), 'utf8')
    await rename(tmp, filePath)
  } catch {
    /* 落盘失败不影响本次会话的展示 */
  }
}

/** 给单个源发最小搜索。超时/报错算失败；两个关键词都搜不到才算 empty */
async function probeOne(key: string): Promise<StoredEntry | null> {
  const started = Date.now()
  let lastEmpty = false
  try {
    for (const keyword of PROBE_KEYWORDS) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          musicdl.search(key, keyword, 1, 1),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`超时（>${PROBE_TIMEOUT / 1000}s）`)),
              PROBE_TIMEOUT
            )
          })
        ])
        if (result.items.length) {
          const ms = Date.now() - started
          return { ok: true, empty: false, ms, error: '', checkedAt: Date.now(), streak: 0 }
        }
        lastEmpty = true
      } finally {
        // race 赢的一方不会清掉输家的定时器，不手动清会白留一个待办
        if (timer) clearTimeout(timer)
      }
    }
    const ms = Date.now() - started
    return {
      ok: true,
      empty: true,
      ms,
      error: lastEmpty ? '两个关键词都搜不到结果' : '',
      checkedAt: Date.now(),
      streak: 0
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const previous = cache.items[key]
    return {
      ok: false,
      empty: false,
      ms: Date.now() - started,
      error: message.slice(0, 160),
      checkedAt: Date.now(),
      streak: (previous?.streak ?? 0) + 1
    }
  }
}

async function runProbe(): Promise<void> {
  if (running) return
  running = true
  try {
    const keys = musicdl.status().health.map((item) => item.key)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < keys.length) {
        const key = keys[cursor]
        cursor += 1
        const entry = await probeOne(key)
        if (entry) cache.items[key] = entry
        // 每个源之间错开一点，别让 15 个请求在同一秒内全打出去
        if (cursor < keys.length) await new Promise((resolve) => setTimeout(resolve, PROBE_GAP))
      }
    }
    await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, keys.length) }, worker))
    cache.checkedAt = Date.now()
    await save()
  } finally {
    running = false
  }
}

/** 组装给 UI 的视图：以引擎当前的源清单为准，没巡检过的补一条 unknown */
export function snapshot(): SourceHealthView {
  const items = musicdl.status().health.map((item) => {
    const entry = cache.items[item.key]
    return {
      key: item.key,
      label: item.label,
      state: !entry ? ('unknown' as const) : entry.ok && !entry.empty ? ('ok' as const) : entry.ok ? ('empty' as const) : ('fail' as const),
      ms: entry?.ms ?? 0,
      error: entry?.error ?? '',
      checkedAt: entry?.checkedAt ?? 0,
      streak: entry?.streak ?? 0
    }
  })
  return {
    checkedAt: cache.checkedAt,
    running,
    items
  }
}

/** 启动时调用：过期才巡检，且延后 20 秒，不打扰用户第一次搜索 */
export function initSourceHealth(enabled: boolean): void {
  if (started) return
  started = true
  if (!enabled) return
  filePath = join(app.getPath('userData'), 'source-health.json')
  void load().then(() => {
    if (Date.now() - cache.checkedAt < FRESH_MS) return
    // 后台任务必须自己吃掉异常：主进程里一个未处理的 rejection 会直接掀掉整个应用
    setTimeout(() => void runProbe().catch(() => undefined), STARTUP_DELAY)
  })
}

/** 设置页「重新检测」：忽略保鲜期立刻巡检，跑完返回最新快照 */
export async function refresh(): Promise<SourceHealthView> {
  if (!filePath) filePath = join(app.getPath('userData'), 'source-health.json')
  await load()
  await runProbe()
  return snapshot()
}
