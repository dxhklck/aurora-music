/**
 * TS 引擎 CLI：给对拍脚本用，输出一行 JSON。
 * 用法：run.ts <source> <keyword> <size>
 */
import { createSource } from '../../src/main/engine/ts/sources'

async function main(): Promise<void> {
  const [key, keyword, sizeRaw] = process.argv.slice(2)
  if (!key || !keyword) throw new Error('用法：run.ts <source> <keyword> <size>')
  const source = createSource(key)
  if (!source) throw new Error(`未知音源：${key}`)
  const started = Date.now()
  const partials: number[] = []
  const items = await source.search({
    keyword,
    size: Number(sizeRaw ?? 10),
    onItem: () => partials.push(Date.now() - started)
  })
  const output = {
    ok: true,
    source: key,
    elapsedMs: Date.now() - started,
    firstPartialMs: partials[0] ?? -1,
    partialBatches: partials.length,
    items: items.map((item) => ({
      id: item.identifier,
      name: item.songName,
      singers: item.singers,
      album: item.album,
      ext: item.ext,
      durationS: item.durationS,
      sizeBytes: item.fileSizeBytes,
      bitrate: item.bitrate,
      codec: item.codec,
      protocol: item.protocol,
      hasUrl: Boolean(item.downloadUrl),
      hasLyric: Boolean(item.lyric),
      coverUrl: item.coverUrl,
      downloadUrl: item.downloadUrl
    }))
  }
  process.stdout.write(JSON.stringify(output) + '\n')
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + '\n')
  process.exit(0)
})
