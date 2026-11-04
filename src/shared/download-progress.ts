import type { DownloadTask } from './types'

/**
 * 任务栏进度条的取值（Windows / macOS / Linux 的 setProgressBar 都吃这一套）：
 *
 * - `0..1` — 按**字节加权**的总体进度。多个任务同时下载时不能取各自百分比的平均：
 *   一首 3 MB 的歌和一张 60 MB 的专辑平均之后，小文件下完显得进度条几乎没动。
 * - `2` — 不确定态（只在排队，或所有在下的任务都不知道总大小）。
 * - `-1` — 清除进度条。
 *
 * 抽成纯函数是为了能单测：里面有三个容易写错的边界（空队列、未知大小、超额进度）。
 */
export function taskbarProgress(tasks: DownloadTask[]): number {
  const active = tasks.filter((task) => task.status === 'downloading')
  if (!active.length) return tasks.some((task) => task.status === 'queued') ? 2 : -1

  let received = 0
  let total = 0
  for (const task of active) {
    if (task.total > 0) {
      received += task.received
      total += task.total
    }
  }
  if (total <= 0) return 2
  // 少数服务端会报比 Content-Length 更多的字节，进度条不能超过 100%
  return Math.min(received / total, 1)
}
