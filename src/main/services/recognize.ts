/**
 * 听歌识曲：本地算音频指纹（Chromaprint / fpcalc），交给 AcoustID 查元数据。
 *
 * 为什么是 AcoustID 而不是 Shazam：
 * - Shazam 的客户端实现（node-shazam-api / SongRec）是 GPL，本项目是 MIT，链接即传染；
 * - AcoustID 用 Chromaprint（LGPL），以独立可执行文件调用，不是链接，不传染；
 * - 官方接口免费、非商业可用，限速 3 req/s。
 *
 * 已知边界（实测 27 首真实曲目，命中率约 37%）：
 * AcoustID 的库只收「正式发行到 MusicBrainz 的录音」。OST、翻唱改编、网络歌手、
 * 短视频热歌基本查不到。所以失败是常态，UI 必须给明确出口，不能只说「识别失败」。
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecognitionResult } from '@shared/types'

/** 内置 application key（在 acoustid.org/new-application 注册，非商业免费）。
 *  用户可在设置里填自己的 key 覆盖，留空即用这个。 */
const DEFAULT_CLIENT = '6VARNUwbxG'

/** 官方限速 3 req/s，我们压到 1 req/s，给同网络下的其它请求留余量 */
const MIN_INTERVAL_MS = 1000
let lastRequestAt = 0
/**
 * 「等待 + 登记发送时刻」必须串行化。
 *
 * 原来是 `读 lastRequestAt → sleep → 写 lastRequestAt` 的 check-then-act：
 * 批量补标签与弹窗识别并发时，两路会读到同一个旧值、睡同样久、然后同时发 POST，
 * 1 req/s 的节流等于没有，容易撞上 AcoustID 的 429。
 */
let gate: Promise<void> = Promise.resolve()
async function waitForSlot(): Promise<void> {
  const previous = gate
  let release!: () => void
  gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastRequestAt = Date.now()
  } finally {
    release()
  }
}

/**
 * fpcalc 的候选路径。
 *
 * 仓库里三平台二进制同名（`fpcalc`），所以按平台分子目录：
 * `resources/bin/darwin/fpcalc`（universal，x64/arm64 通用）、`resources/bin/linux-x64/fpcalc`，
 * Windows 保持老布局 `resources/bin/fpcalc.exe`（已发布版本用的就是这个路径）。
 *
 * 打包后 extraResources 把 resources/bin 整个放到 process.resourcesPath/bin；
 * 开发时 `electron out/main/index.js` 的 appPath 是 out/main，要再上溯两级才是项目根，
 * 所以这里按「存在的第一个」取，不要只算一条路径——appPath 在不同启动方式下不一样。
 */
function fpcalcCandidates(): string[] {
  const exe = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc'
  const appPath = app.getAppPath()
  const roots: string[] = []
  if (app.isPackaged) roots.push(join(process.resourcesPath, 'bin'))
  roots.push(
    join(appPath, 'resources', 'bin'),
    join(appPath, '..', '..', 'resources', 'bin'),
    join(process.cwd(), 'resources', 'bin')
  )
  const dirs = [`${process.platform}-${process.arch}`, process.platform]
  const list: string[] = []
  for (const root of roots) {
    for (const dir of dirs) list.push(join(root, dir, exe))
    list.push(join(root, exe))
  }
  return list
}

function fpcalcPath(): string {
  const list = fpcalcCandidates()
  return list.find((candidate) => existsSync(candidate)) ?? list[0]
}

function missingBinary(): RecognitionResult {
  return { ok: false, reason: 'binary-missing', message: `缺少 fpcalc 组件：${fpcalcPath()}` }
}

export function fpcalcAvailable(): boolean {
  return existsSync(fpcalcPath())
}

interface Fingerprint {
  duration: number
  fingerprint: string
}

interface FpcalcOutput {
  duration: number
  /** 默认是压缩流的 base64 字符串；带 -raw 时是逐帧 uint32 数字数组 */
  fingerprint: string | number[]
}

async function runFpcalc(filePath: string, extra: string[] = []): Promise<FpcalcOutput> {
  const bin = fpcalcPath()
  if (!existsSync(bin)) throw new Error('MISSING_BINARY')
  return await new Promise<FpcalcOutput>((resolve, reject) => {
    const child = spawn(bin, ['-json', ...extra, filePath], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('FPCALC_TIMEOUT'))
    }, 30000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`FPCALC_EXIT_${code}:${err.slice(0, 160)}`))
        return
      }
      try {
        const parsed = JSON.parse(out) as { duration?: number; fingerprint?: string | number[] }
        if (!parsed.fingerprint) {
          reject(new Error('NO_FINGERPRINT'))
          return
        }
        resolve({ duration: Math.round(parsed.duration ?? 0), fingerprint: parsed.fingerprint })
      } catch {
        reject(new Error('BAD_JSON'))
      }
    })
  })
}

/** 查 AcoustID 用的压缩指纹（base64 字符串），必须配 duration 一起发 */
async function fingerprint(filePath: string): Promise<Fingerprint> {
  const parsed = await runFpcalc(filePath)
  return { duration: parsed.duration, fingerprint: String(parsed.fingerprint) }
}

/**
 * 逐帧 uint32 指纹，只在本地比对「是不是同一段录音」时用。
 *
 * 必须带 `-raw`：默认输出是压缩流，按 base64 解成 uint32 做逐位比较是错的
 * （时间轴和帧数都对不上，实测会得出「不是同一首歌」的错误结论）。
 */
export async function fingerprintRaw(
  filePath: string
): Promise<{ duration: number; frames: Uint32Array }> {
  const parsed = await runFpcalc(filePath, ['-raw'])
  const frames = Array.isArray(parsed.fingerprint)
    ? Uint32Array.from(parsed.fingerprint)
    : new Uint32Array(0)
  return { duration: parsed.duration, frames }
}

interface AcoustIdRecording {
  id?: string
  title?: string
  duration?: number
  artists?: Array<{ name?: string }>
  releasegroups?: Array<{ title?: string; type?: string }>
}

interface AcoustIdResponse {
  status?: string
  error?: { message?: string }
  results?: Array<{ score?: number; recordings?: AcoustIdRecording[] }>
}

async function lookup(
  fp: Fingerprint,
  client: string,
  duration: number
): Promise<RecognitionResult> {
  await waitForSlot()

  const body = new URLSearchParams({
    client,
    // AcoustID 的 duration 是「**整首录音**的时长」，且容差只有 ±10 秒左右
    //（实测同一段指纹：传 280 命中 score 0.93，传 300 直接 0 结果）。
    // 所以录音场景必须由外面做阶梯扫描，猜整首有多长。
    duration: String(duration),
    fingerprint: fp.fingerprint,
    // 必须用空格分隔：URLSearchParams 会把字面 `+` 编成 %2B，
    // 服务端收到的是 `recordings+releasegroups` 字面量，于是只返回 track id、
    // 不带 MusicBrainz 元数据（表现为「有 score 没有歌名」）。空格会被编成 `+`，解码回来正好。
    meta: 'recordings releasegroups'
  })
  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch('https://api.acoustid.org/v2/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15000)
    })
  } catch (e) {
    return {
      ok: false,
      reason: 'failed',
      message: `连不上 AcoustID：${e instanceof Error ? e.message : String(e)}`
    }
  }
  // 非 2xx 常常是 HTML 错误页，直接 res.json() 只会抛「Unexpected token <」
  if (response.status === 429) {
    return { ok: false, reason: 'failed', message: 'AcoustID 请求太频繁，稍后再试' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'failed', message: `AcoustID 服务异常（HTTP ${response.status}）` }
  }
  let json: AcoustIdResponse
  try {
    json = (await response.json()) as AcoustIdResponse
  } catch {
    return { ok: false, reason: 'failed', message: 'AcoustID 返回的不是 JSON，稍后再试' }
  }

  if (json.error) {
    return { ok: false, reason: 'failed', message: json.error.message || 'AcoustID 拒绝了请求' }
  }

  const results = (json.results || []).filter((item) => (item.recordings || []).length > 0)
  if (!results.length) {
    // 时长太短是唯一「用户自己能修」的失败原因，单独给提示；其余归为库里没有
    const message =
      fp.duration < 10
        ? '这段音频不到 10 秒，取不到足够特征。再录长一点。'
        : 'AcoustID 库里没有这段音频'
    return { ok: false, reason: 'no-match', message }
  }

  // 分数最高的那条；同一 result 里多个 recording 时，取时长最接近的
  results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const best = results[0]
  const recordings = best.recordings || []
  recordings.sort(
    (a, b) => Math.abs((a.duration ?? 0) - duration) - Math.abs((b.duration ?? 0) - duration)
  )
  const rec = recordings[0]

  return {
    ok: true,
    title: rec.title || '',
    artist: (rec.artists || []).map((a) => a.name).filter(Boolean).join(', '),
    album: (rec.releasegroups || [])[0]?.title || '',
    score: best.score ?? 0,
    duration,
    source: 'acoustid'
  }
}

/**
 * 常见歌曲时长（秒），按「华语流行最可能的先试」排序。
 *
 * 为什么要猜：AcoustID 的 duration 是「整首录音时长」，容差只有 ±10 秒左右，
 * 而录音片段本身不知道整首多长。实测同一段指纹传 280 命中、传 300 就 0 结果。
 */
const DURATION_GUESSES = [240, 210, 270, 180, 300, 150, 330, 360]

/** 录音场景：不知道整首多长，按时长阶梯逐档试，命中即返回 */
async function lookupAnyDuration(
  fp: Fingerprint,
  client: string
): Promise<RecognitionResult> {
  let failure: RecognitionResult | null = null
  for (const guess of DURATION_GUESSES) {
    const result = await lookup(fp, client, guess)
    if (result.ok) return result
    // 中途的网络/鉴权错误要留住：后面几档可能只是「库里没有」，不能把它覆盖成 no-match
    if (result.reason === 'failed' && !failure) failure = result
  }
  if (failure) return failure
  return {
    ok: false,
    reason: 'no-match',
    message: 'AcoustID 库里没有这段音频（也可能是影视 OST / 翻唱 / 网络歌手未被收录）'
  }
}

/**
 * 识别一段音频。
 * @param buffer 音频字节（webm/opus 或任意 ffmpeg 能解的格式）
 * @param client API key；空串用内置
 */
export async function recognizeBuffer(
  buffer: Buffer,
  client = ''
): Promise<RecognitionResult> {
  if (!buffer.length) return { ok: false, reason: 'failed', message: '没有收到音频数据' }
  if (!fpcalcAvailable()) return missingBinary()

  let dir = ''
  try {
    dir = await mkdtemp(join(tmpdir(), 'aurora-recognize-'))
    const file = join(dir, 'query.wav')
    await writeFile(file, buffer)
    const fp = await fingerprint(file)
    // 「选择音频文件」传进来的是完整文件，fpcalc 给出的 duration 就是整首时长，
    // 直接用它查一次：省掉 7 档白跑，也能覆盖 >360 秒的长曲
    //（DURATION_GUESSES 最大 360，长曲逐档猜必然全落空）。
    // 只有 20 秒录音这类短片段才需要猜整首有多长。
    if (fp.duration >= 30) return await lookup(fp, client || DEFAULT_CLIENT, fp.duration)
    return await lookupAnyDuration(fp, client || DEFAULT_CLIENT)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (message === 'MISSING_BINARY') return missingBinary()
    if (message === 'NO_FINGERPRINT' || message === 'FPCALC_TIMEOUT') {
      return { ok: false, reason: 'no-match', message: '这段音频太安静或太短，取不到有效指纹' }
    }
    return { ok: false, reason: 'failed', message: `识别失败：${message.slice(0, 120)}` }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 识别磁盘上的音频文件（拖拽 / 从本地库选） */
export async function recognizeFile(
  filePath: string,
  client = ''
): Promise<RecognitionResult> {
  if (!existsSync(filePath)) {
    return { ok: false, reason: 'failed', message: `文件不存在：${filePath.slice(0, 120)}` }
  }
  if (!fpcalcAvailable()) return missingBinary()
  try {
    const fp = await fingerprint(filePath)
    // 文件是完整的，fpcalc 给出的 duration 就是整首时长，一次到位
    if (fp.duration >= 30) return await lookup(fp, client || DEFAULT_CLIENT, fp.duration)
    return await lookupAnyDuration(fp, client || DEFAULT_CLIENT)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: 'failed', message: `识别失败：${message.slice(0, 120)}` }
  }
}
