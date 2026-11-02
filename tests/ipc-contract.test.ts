/**
 * IPC 契约护栏。
 *
 * 新增一个通道要在四处对齐：`shared/ipc.ts` 定义 → `main/ipc.ts` 注册 → `preload` 暴露
 * → `shared/api.ts` 声明。漏任何一处编译器都不会报错——渲染层拿到的只是 `undefined`，
 * 表现为「点了没反应」。这个测试做纯文本检查，不启动 Electron，跑一次几十毫秒。
 *
 * 四条断言：
 * 1. preload 引用的每个通道都在 `IPC` 表里（防拼错、防删了常量忘了改引用）；
 * 2. preload 引用的每个通道在主进程里也出现过（防只接了半边）；
 * 3. `IPC` 表里的值不重复（复制粘贴改一半会让两个通道静默合并成一个）；
 * 4. 主进程与 preload 里没有裸通道字符串（`send('xxx:yyy')` 改名不会被编译器发现）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

async function readSources(dir: string): Promise<Array<{ path: string; text: string }>> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: Array<{ path: string; text: string }> = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await readSources(full)))
    } else if (entry.name.endsWith('.ts')) {
      files.push({ path: full, text: await readFile(full, 'utf8') })
    }
  }
  return files
}

function keysIn(text: string): string[] {
  return [...text.matchAll(/IPC\.(\w+)/g)].map((match) => match[1])
}

test('IPC 通道表与主进程 / preload 引用保持一致', async () => {
  const ipcSource = await readFile(join(root, 'src/shared/ipc.ts'), 'utf8')
  const channels = new Map<string, string>()
  for (const match of ipcSource.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)) {
    channels.set(match[1], match[2])
  }
  // 正则失配时这里会是 0，后面全部断言都会「通过」——先钉住规模
  assert.ok(channels.size > 90, `只解析到 ${channels.size} 个通道，正则可能失效了`)

  const values = [...channels.values()]
  assert.equal(new Set(values).size, values.length, 'IPC 表里有重复的通道字符串')

  const preload = await readFile(join(root, 'src/preload/index.ts'), 'utf8')
  const preloadKeys = new Set(keysIn(preload))
  assert.ok(preloadKeys.size > 0, 'preload 里没解析到任何 IPC 引用')

  const mainSources = await readSources(join(root, 'src/main'))
  const mainKeys = new Set(mainSources.flatMap((file) => keysIn(file.text)))

  for (const key of preloadKeys) {
    assert.ok(channels.has(key), `preload 引用了 IPC.${key}，但 shared/ipc.ts 里没有这个键`)
    assert.ok(mainKeys.has(key), `preload 引用了 IPC.${key}，主进程里从未出现——通道只接了半边`)
  }

  // 裸字符串：正经用法只会写 IPC.xxx，出现带引号的通道值就是绕过常量表
  const bare: string[] = []
  for (const [key, value] of channels) {
    if (preload.includes(`'${value}'`)) bare.push(`preload/index.ts: ${key} (${value})`)
    for (const file of mainSources) {
      if (file.text.includes(`'${value}'`)) {
        bare.push(`${file.path.slice(root.length + 1)}: ${key} (${value})`)
      }
    }
  }
  assert.deepEqual(bare, [], `这些地方用了裸通道字符串，改成 IPC 常量：\n${bare.join('\n')}`)
})
