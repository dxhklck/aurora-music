/**
 * 落盘串行队列的单测。
 *
 * 这个队列存在的唯一理由是防「两次写抢同一个 .tmp」：先完成的 rename 会把
 * 后一个的临时文件移走，后者 rename 直接 ENOENT。这个错误只在并发时出现，
 * 手工点击几乎复现不到，所以必须由测试兜住。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createWriteQueue, writeAtomic } from '../src/main/services/atomic-write.ts'

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aurora-atomic-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('并发写同一个文件不报错，且最终内容是最后一次的', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'items.json')
    const queue = createWriteQueue()
    // 20 次并发：不加队列时必然有一批 rename 撞上 ENOENT
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => queue(() => writeAtomic(target, JSON.stringify({ round: index }))))
    )
    const content = JSON.parse(await readFile(target, 'utf8')) as { round: number }
    assert.equal(content.round, 19, '最后入队的那次必须生效')
  })
})

test('队列跑完不留 .tmp 残留', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'items.json')
    const queue = createWriteQueue()
    await Promise.all(Array.from({ length: 8 }, (_, i) => queue(() => writeAtomic(target, `v${i}`))))
    const left = await readdir(dir)
    assert.deepEqual(left, ['items.json'], `目录里不应有临时文件，实际: ${left.join(', ')}`)
  })
})

test('一次写失败不会卡死后续写入', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'items.json')
    const queue = createWriteQueue()

    // 第一个任务故意失败（写到不存在的子目录）
    await assert.rejects(queue(() => writeAtomic(join(dir, 'no-such-dir', 'x.json'), 'boom')))

    // 队列必须还能继续工作，而且调用方仍能拿到失败信号
    await queue(() => writeAtomic(target, 'after-failure'))
    assert.equal(await readFile(target, 'utf8'), 'after-failure')
  })
})

test('失败会抛给调用方（落盘失败不能被静默吞掉）', async () => {
  await withTempDir(async (dir) => {
    const queue = createWriteQueue()
    await assert.rejects(queue(() => writeAtomic(join(dir, 'missing', 'a.json'), 'x')))
  })
})

test('读-改-写的串行顺序与入队顺序一致', async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, 'counter.json')
    const queue = createWriteQueue()
    await writeAtomic(target, '0')

    // 模拟「读当前值 → 加一 → 写回」：串行化后必须一条不丢
    const bump = async (): Promise<void> => {
      const current = Number(await readFile(target, 'utf8'))
      await writeAtomic(target, String(current + 1))
    }
    // 注意 bump 内部自己读写，这里靠队列串行保证不重叠
    for (let i = 0; i < 10; i++) await queue(bump)

    assert.equal(await readFile(target, 'utf8'), '10')
  })
})
