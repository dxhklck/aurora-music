import { writeFile, rename } from 'node:fs/promises'

/**
 * 原子写 + 串行队列。
 *
 * `tmp + rename` 只解决「写到一半掉电留下坏文件」，**不解决并发**：
 * 两次写同一路径会抢同一个 `.tmp` 文件，先完成的 rename 把后一个的临时文件
 * 移走，后者 rename 直接 ENOENT（settings.ts 里踩过，现在曲库/歌单/下载也走这里）。
 *
 * 用法：同一个目标文件只建一个队列，所有落盘都从它排队。
 */

export type EnqueueWrite = (task: () => Promise<void>) => Promise<void>

export function createWriteQueue(): EnqueueWrite {
  let tail: Promise<void> = Promise.resolve()
  return (task) => {
    const run = tail.then(task)
    // 队列本身要吃掉失败，否则一次写盘错误会让后续所有写入连带 reject
    tail = run.catch(() => undefined)
    return run
  }
}

/** 先写 `.tmp` 再 rename，目标文件要么是旧内容、要么是完整的新内容 */
export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}
