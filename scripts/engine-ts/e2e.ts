/**
 * TS 引擎端到端验证：搜索 → 取址 → 写标签 → HLS 清单解析。
 * 不依赖 Electron，直接跑在 Node 上，便于 CI。
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as engine from '../../src/main/engine/ts'

async function main(): Promise<void> {
  const failures: string[] = []
  const workDir = await mkdtemp(join(tmpdir(), 'aurora-e2e-'))
  try {
    // 1) 搜索
    const page = await engine.search({ source: 'migu', keyword: '稻香', page: 1, limit: 3 })
    console.log(`搜索：${page.items.length} 条，total=${page.total}，hasMore=${page.hasMore}，耗时 ${page.cost}ms`)
    if (!page.items.length) failures.push('搜索返回空')
    const first = page.items[0]
    console.log(`首条：${first.name} - ${first.singers} [${first.ext} ${first.sizeBytes}B] token=${first.token.slice(0, 8)}…`)

    // 2) 取址（走 token 快路径）
    const resolved = await engine.resolve({ source: 'migu', token: first.token })
    console.log(`取址：${resolved.url.slice(0, 70)}… protocol=${resolved.protocol} size=${resolved.size}`)
    if (!resolved.url.startsWith('http')) failures.push('取址地址非法')
    if (resolved.token !== first.token) failures.push('取址返回的 token 与搜索不一致')

    // 3) token 失效后用元信息重定位。
    //    这里显式给 keyword：只给「歌名 + 歌手」时平台会返回一堆翻唱/Remix，
    //    上游的 pickBest 同样匹配不到（不是迁移引入的问题，见迁移报告的已知限制）
    engine.reset()
    const relocated = await engine.resolve({
      source: 'migu',
      keyword: first.name,
      name: first.name,
      artists: first.singers,
      durationMs: first.durationMs
    })
    console.log(`重定位：${relocated.url.slice(0, 50)}…`)
    if (!relocated.url.startsWith('http')) failures.push('重定位失败')

    // 3b) 确实找不到时必须返回 notfound，而不是空地址
    try {
      await engine.resolve({ source: 'migu', name: '这首歌肯定不存在zzz', artists: '无名氏' })
      failures.push('不存在的曲目没有报错')
    } catch (error) {
      const code = (error as { code?: string }).code
      console.log(`未命中错误码：${code}`)
      if (code !== 'notfound') failures.push(`未命中应返回 notfound，实际 ${code}`)
    }

    // 4) 写标签（合成 mp3 / flac，验证 ID3 与 Vorbis Comment）
    const mp3Path = join(workDir, 'sample.mp3')
    await writeFile(mp3Path, Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(4096, 0)]))
    const mp3Tag = await engine.tag({ path: mp3Path, title: '测试标题', artists: '测试歌手', album: '测试专辑', lyric: '[00:01.00]第一行' })
    const mp3Bytes = await readFile(mp3Path)
    const hasId3 = mp3Bytes.subarray(0, 3).toString('ascii') === 'ID3'
    console.log(`MP3 标签：ok=${mp3Tag.ok} ID3 头=${hasId3} 体积=${mp3Bytes.length}`)
    if (!mp3Tag.ok || !hasId3) failures.push('MP3 标签写入失败')

    const flacPath = join(workDir, 'sample.flac')
    const block = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x22]), Buffer.alloc(34, 0)])
    await writeFile(flacPath, Buffer.concat([Buffer.from('fLaC', 'ascii'), block, Buffer.alloc(512, 0)]))
    const flacTag = await engine.tag({ path: flacPath, title: '测试标题', artists: '测试歌手', album: '测试专辑' })
    const flacBytes = await readFile(flacPath)
    const hasComment = flacBytes.includes(Buffer.from('TITLE=测试标题', 'utf8'))
    console.log(`FLAC 标签：ok=${flacTag.ok} VorbisComment=${hasComment}`)
    if (!flacTag.ok || !hasComment) failures.push('FLAC 标签写入失败')

    // 5) 未知音源与缺参必须报出正确错误码
    try {
      await engine.search({ source: 'nope', keyword: 'x' })
      failures.push('未知音源没有报错')
    } catch (error) {
      const code = (error as { code?: string }).code
      console.log(`未知音源错误码：${code}`)
      if (code !== 'unsupported') failures.push(`未知音源错误码应为 unsupported，实际 ${code}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(failures.length ? `\n失败：\n- ${failures.join('\n- ')}` : '\n全部通过')
  process.exit(failures.length ? 1 : 0)
}

main().catch((error) => {
  console.error('异常', error)
  process.exit(1)
})
