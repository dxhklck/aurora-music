import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { DownloadTask, Song, StreamInfo } from '@shared/types'
import { lyricToLrc } from '@shared/lyric'
import { catalog } from './catalog'
import { library } from './library'
import { settings } from './settings'
import { musicdl } from '../engine/musicdl'
import {
  ensureDir,
  fileSize,
  moveFile,
  safeUnlink,
  sanitizeFileName,
  sleep,
  uniqueFilePath
} from '../utils'

const EMIT_INTERVAL = 240
const PERSIST_DELAY = 600

interface InternalTask extends DownloadTask {
  partPath?: string
  controller?: AbortController
}

/**
 * 下载管理器（主进程）。
 *
 * - 生产者/消费者队列 + 可配置并发（settings.downloadConcurrency）；
 * - 单任务失败后指数退避重试，次数可配置（settings.downloadRetries）；
 * - `.part` 断点续传（服务端支持 Range 时）；
 * - 成功后写入 `.lrc` 与 `.meta.json` sidecar，登记到本地音乐库；
 * - 可选写入音频标签（ID3 / MP4 / Vorbis），复用引擎里的 mutagen；
 * - 队列落盘，重启后未完成的任务自动续跑。
 *
 * 关于地址：`StreamInfo.url` 是给渲染进程用的 muse:// 代理地址，Node 的 fetch
 * 不认识这个协议，所以下载必须用 `directUrl` 并补上音源给出的请求头（Referer/Cookie）。
 */
class DownloadManager extends EventEmitter {
  private tasks = new Map<string, InternalTask>()
  private queue: string[] = []
  private active = 0
  private emitTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private filePath = ''
  private restored = false

  configure(userDataDir: string): void {
    this.filePath = join(userDataDir, 'downloads.json')
  }

  /** 启动时恢复队列：进行中的回到 queued，已结束的保留记录 */
  async load(): Promise<void> {
    if (this.restored || !this.filePath || !existsSync(this.filePath)) {
      this.restored = true
      return
    }
    this.restored = true
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as DownloadTask[]
      if (!Array.isArray(parsed)) return
      for (const item of parsed) {
        if (!item?.id || !item.song) continue
        const task: InternalTask = { ...item }
        if (task.status === 'downloading' || task.status === 'queued') {
          task.status = 'queued'
          task.speed = 0
          task.progress = task.total ? Math.min(task.received / task.total, 0.99) : 0
          this.queue.push(task.id)
        }
        this.tasks.set(task.id, task)
      }
      this.scheduleEmit(true)
      this.pump()
    } catch {
      /* 记录损坏时从空队列开始，不影响启动 */
    }
  }

  enqueue(song: Song): DownloadTask {
    const id = `${song.platform}:${song.id}`
    const existing = this.tasks.get(id)
    if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
      return this.publicTask(existing)
    }
    if (existing && existing.status === 'done' && existing.filePath && existsSync(existing.filePath)) {
      return this.publicTask(existing)
    }

    const task: InternalTask = {
      id,
      song,
      status: 'queued',
      progress: 0,
      received: 0,
      total: 0,
      speed: 0,
      attempt: 0,
      createdAt: Date.now()
    }
    this.tasks.set(id, task)
    this.queue.push(id)
    this.pump()
    this.scheduleEmit(true)
    this.schedulePersist()
    return this.publicTask(task)
  }

  /** 批量入队：整张榜单/歌单/多选一次提交，返回实际新建的任务 */
  enqueueMany(songs: Song[]): DownloadTask[] {
    const created: DownloadTask[] = []
    const seen = new Set<string>()
    for (const song of songs) {
      const id = `${song.platform}:${song.id}`
      if (seen.has(id)) continue
      seen.add(id)
      const before = this.tasks.get(id)
      const task = this.enqueue(song)
      if (!before || before.status === 'error' || before.status === 'canceled') created.push(task)
    }
    return created
  }

  list(): DownloadTask[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((task) => this.publicTask(task))
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status === 'queued') {
      this.queue = this.queue.filter((item) => item !== id)
      task.status = 'canceled'
      this.scheduleEmit(true)
      this.schedulePersist()
      return
    }
    task.status = 'canceled'
    task.controller?.abort()
    this.scheduleEmit(true)
    this.schedulePersist()
  }

  retry(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    if (task.status !== 'error' && task.status !== 'canceled') return
    task.status = 'queued'
    task.error = undefined
    task.progress = 0
    task.received = 0
    task.speed = 0
    task.attempt = 0
    if (!this.queue.includes(id)) this.queue.push(id)
    this.pump()
    this.scheduleEmit(true)
    this.schedulePersist()
  }

  /** 一键重试所有失败/取消的任务 */
  retryFailed(): number {
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.status === 'error' || task.status === 'canceled') {
        this.retry(task.id)
        count += 1
      }
    }
    return count
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.status === 'done' || task.status === 'error' || task.status === 'canceled') {
        this.tasks.delete(id)
      }
    }
    this.scheduleEmit(true)
    this.schedulePersist()
  }

  remove(id: string): void {
    const task = this.tasks.get(id)
    if (task && (task.status === 'downloading' || task.status === 'queued')) this.cancel(id)
    this.tasks.delete(id)
    this.scheduleEmit(true)
    this.schedulePersist()
  }

  /** 按当前并发数推进队列；设置里改了并发后由 IPC 层主动调用 */
  pump(): void {
    const concurrency = Math.max(1, Math.min(settings.get().downloadConcurrency ?? 2, 4))
    while (this.active < concurrency && this.queue.length) {
      const id = this.queue.shift()!
      const task = this.tasks.get(id)
      if (!task || task.status !== 'queued') continue
      this.active += 1
      void this.run(task).finally(() => {
        this.active -= 1
        this.pump()
      })
    }
  }

  private async run(task: InternalTask): Promise<void> {
    const maxAttempts = Math.max(1, Math.min(settings.get().downloadRetries ?? 3, 5))
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (task.status === 'canceled') return
      task.attempt = attempt
      task.status = 'downloading'
      task.error = undefined
      this.scheduleEmit()
      try {
        await this.transfer(task)
        return
      } catch (error) {
        if ((task.status as string) === 'canceled') {
          await safeUnlink(task.partPath ?? '')
          this.scheduleEmit(true)
          this.schedulePersist()
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        task.error = message
        if (attempt < maxAttempts) {
          await sleep(600 * attempt)
          continue
        }
        task.status = 'error'
        task.speed = 0
        this.scheduleEmit(true)
        this.schedulePersist()
        return
      }
    }
  }

  private async transfer(task: InternalTask): Promise<void> {
    const config = settings.get()
    const resolved = await catalog.resolveTrack(task.song, config.autoSwitchSource)
    const song = resolved.song
    const stream = resolved.stream
    const ext = (stream.format || 'mp3').replace('.', '').toLowerCase()
    const dir = config.downloadDir
    await ensureDir(dir)

    const base = sanitizeFileName(`${song.artists.join(', ') || '未知歌手'} - ${song.name}`)
    const partPath = join(dir, `.${base}.${ext}.part`)
    task.partPath = partPath

    if (stream.url.startsWith('muse://local')) {
      task.transport = 'local'
      await this.copyLocal(stream.url, partPath, task)
    } else if (stream.protocol === 'hls') {
      task.transport = 'hls'
      await this.downloadHls(task, partPath, stream)
    } else {
      task.transport = 'http'
      await this.downloadHttp(stream, partPath, task)
    }

    if (task.status === 'canceled') {
      await safeUnlink(partPath)
      return
    }

    const finalPath = await uniqueFilePath(dir, base, ext)
    await moveFile(partPath, finalPath)

    // 歌词 sidecar
    let lyricPath: string | undefined
    let lyricText = ''
    try {
      const lyric = await catalog.lyric(song)
      if (lyric && (lyric.lines.length || lyric.plain)) {
        lyricText = lyric.lines.length ? lyricToLrc(lyric) : lyric.plain ?? ''
        const lrcPath = finalPath.replace(/\.[^.]+$/, '.lrc')
        await writeFile(lrcPath, lyricText, 'utf8')
        lyricPath = lrcPath
      }
    } catch {
      /* 歌词失败不影响下载结果 */
    }

    const size = await fileSize(finalPath)
    const metaPath = finalPath.replace(/\.[^.]+$/, '.meta.json')
    const payload = {
      song,
      sourcePlatform: song.platform,
      quality: stream.label,
      format: ext,
      size,
      downloadedAt: Date.now(),
      originalUrl: stream.directUrl ?? stream.url,
      transport: task.transport,
      engine: task.song.platform.startsWith('mdl-') ? 'musicdl' : 'native'
    }
    await writeFile(metaPath, JSON.stringify(payload, null, 2), 'utf8')

    task.tagged = await this.writeTags(finalPath, song, lyricText)

    await library.add({
      id: `${song.platform}:${song.id}`,
      song,
      filePath: finalPath,
      fileName: finalPath.split(/[\\/]/).pop() ?? base,
      size,
      ext,
      qualityLabel: stream.label,
      lyricPath,
      metaPath,
      downloadedAt: Date.now()
    })

    task.status = 'done'
    task.filePath = finalPath
    task.progress = 1
    task.received = size
    task.total = size
    task.speed = 0
    task.finishedAt = Date.now()
    this.scheduleEmit(true)
    this.schedulePersist()
  }

  /** 演示音源/本地文件：分块复制，同样有真实进度（不是假进度条） */
  private async copyLocal(url: string, partPath: string, task: InternalTask): Promise<void> {
    const sourcePath = decodeURIComponent(new URL(url).searchParams.get('p') ?? '')
    if (!sourcePath || !existsSync(sourcePath)) throw new Error('本地源文件不存在')
    const total = await fileSize(sourcePath)
    task.total = total
    task.received = 0

    let received = 0
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, callback) => {
        received += chunk.length
        task.received = received
        task.progress = total ? received / total : 0
        this.scheduleEmit()
        callback(null, chunk)
      }
    })
    await pipeline(createReadStream(sourcePath), counter, createWriteStream(partPath, { flags: 'w' }))
    task.progress = 1
  }

  private async downloadHttp(stream: StreamInfo, partPath: string, task: InternalTask): Promise<void> {
    const target = stream.directUrl ?? stream.url
    if (!/^https?:\/\//i.test(target)) {
      throw new Error(`下载地址不可用（${target.slice(0, 40)}）`)
    }

    const controller = new AbortController()
    task.controller = controller

    let start = await fileSize(partPath)
    const headers: Record<string, string> = { ...(stream.headers ?? {}) }
    if (start > 0) headers.Range = `bytes=${start}-`

    const response = await fetch(target, { headers, signal: controller.signal, redirect: 'follow' })
    if (!response.ok && response.status !== 206) {
      throw new Error(`下载失败：HTTP ${response.status}`)
    }
    // 服务端不支持断点续传时会返回 200，此时从头写
    if (response.status === 200 && start > 0) start = 0

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) {
      throw new Error('下载失败：返回的是网页而不是音频（链接可能已过期）')
    }

    const length = Number(response.headers.get('content-length') ?? 0)
    task.total = length > 0 ? start + length : 0
    task.received = start
    task.progress = task.total ? start / task.total : 0
    if (!response.body) throw new Error('下载失败：响应为空')

    let received = start
    let lastTick = Date.now()
    let lastBytes = received

    const counter = new Transform({
      transform: (chunk: Buffer, _enc, callback) => {
        received += chunk.length
        task.received = received
        task.progress = task.total ? Math.min(received / task.total, 0.999) : 0
        const now = Date.now()
        if (now - lastTick >= 400) {
          task.speed = Math.round(((received - lastBytes) * 1000) / (now - lastTick))
          lastTick = now
          lastBytes = received
        }
        this.scheduleEmit()
        callback(null, chunk)
      }
    })

    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(partPath, { flags: start > 0 ? 'a' : 'w' })
    )
    task.speed = 0
  }

  /**
   * HLS（m3u8）交给引擎合并分片：分片下载 + 解密 + remux 是 musicdl 已有的能力，
   * 在 Node 侧重写一遍不划算。代价是取消只能在完成后清理文件。
   */
  private async downloadHls(task: InternalTask, partPath: string, stream: StreamInfo): Promise<void> {
    const target = `${partPath}.hls`
    await musicdl.downloadHls(
      {
        source: String(task.song.extra?.engine ?? task.song.platform.replace(/^mdl-/, '')),
        token: typeof task.song.extra?.token === 'string' ? task.song.extra.token : undefined,
        name: task.song.name,
        artists: task.song.artists.join('/'),
        durationMs: task.song.duration
      },
      target,
      task.id,
      (received, total) => {
        task.received = received
        task.total = total
        task.progress = total ? Math.min(received / total, 0.999) : 0
        this.scheduleEmit()
      }
    )
    if (task.status === 'canceled') {
      await safeUnlink(target)
      return
    }
    await moveFile(target, partPath)
    void stream
  }

  /**
   * 写标签：复用引擎里的 mutagen（mp3/m4a/flac/ogg）。
   * 引擎不可用时静默跳过——标签是加分项，不能让一次成功的下载变成失败。
   */
  private async writeTags(filePath: string, song: Song, lyric: string): Promise<boolean> {
    if (!settings.get().writeTags) return false
    try {
      const result = await musicdl.tag({
        path: filePath,
        title: song.name,
        artists: song.artists.join(' / '),
        album: song.album,
        lyric: lyric || undefined
      })
      return result.ok === true && !result.skipped
    } catch {
      return false
    }
  }

  private publicTask(task: InternalTask): DownloadTask {
    const { partPath: _partPath, controller: _controller, ...rest } = task
    void _partPath
    void _controller
    return { ...rest }
  }

  private scheduleEmit(immediate = false): void {
    if (immediate) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer)
        this.emitTimer = null
      }
      this.emit('update', this.list())
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emit('update', this.list())
    }, EMIT_INTERVAL)
  }

  private schedulePersist(): void {
    if (!this.filePath || this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, PERSIST_DELAY)
  }

  private async persist(): Promise<void> {
    if (!this.filePath) return
    const snapshot = [...this.tasks.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 300)
      .map((task) => this.publicTask(task))
    try {
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
      await moveFile(tmp, this.filePath)
    } catch {
      /* 落盘失败不影响内存中的队列 */
    }
  }

  /** 退出前把当前状态刷盘 */
  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.persist()
  }
}

export const downloads = new DownloadManager()
