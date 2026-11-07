<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { RecognitionResult } from '@shared/types'
import { clipboardKeyword } from '@shared/clipboard-text'
import { externalSearchLinks, searchKeywords, trackLabel } from '@shared/recognize-text'
import Icon from './Icon.vue'
import { useSearchStore } from '../stores/search'
import { useAppStore } from '../stores/app'
import { clearRecognizeOrigin, setRecognizeOrigin } from '../core/recognize-origin'

/**
 * 听歌识曲。
 *
 * 录 20 秒音频 → 主进程用 fpcalc 算 Chromaprint 指纹 → AcoustID 查元数据。
 * 为什么是 20 秒：官方建议 ≥10 秒，但实测 12 秒在 AcoustID 上 8 档时长全查不到，
 * 20 秒稳定命中（同一首 25 秒 score 0.93、20 秒 0.93）。再长就纯粹是让用户干等。
 *
 * 失败是常态（实测全库 127 首命中 43%，OST / 翻唱 / 网络歌手都查不到），
 * 所以弹窗的重点不是「怎么提高命中率」（那是 AcoustID 的库决定的，代码改不动），
 * 而是**失败和半失败时都有路可走**：
 *   - 认出来了但音源没版权 → 一键去 QQ 音乐 / 酷狗 / 哔哩哔哩；
 *   - 没认出来 → 用剪贴板里的歌名或歌词继续搜。
 */
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const search = useSearchStore()
const app = useAppStore()

const RECORD_MS = 20000
/** 系统声音靠 Chromium 的 loopback（WASAPI），只有 Windows 有 */
const isWin = window.api.platform === 'win32'

type Phase = 'idle' | 'recording' | 'recognizing' | 'done' | 'error'
type Source = 'mic' | 'system'
const phase = ref<Phase>('idle')
const source = ref<Source>('mic')
const progress = ref(0)
const result = ref<RecognitionResult | null>(null)
const errorMsg = ref('')
/** 搜索进行中：按钮要显示进度，避免用户连点发出多次请求 */
const searching = ref(false)
/** 等待 getUserMedia / getDisplayMedia 授权：此时按钮不能再点，否则会起两路录音 */
const requesting = ref(false)
const copied = ref(false)
let copiedTimer = 0

let stream: MediaStream | null = null
let captureCtx: AudioContext | null = null
let processor: ScriptProcessorNode | null = null
let captureRate = 48000
let timer = 0
let ticker = 0
let cancelled = false
let unmounted = false
/**
 * 代次：授权窗口是异步的，等它 resolve 时用户可能已经关了弹窗、或是又点了一次。
 * 每次 reset / close / 卸载都 +1，旧流程拿到的 gen 落后就必须自行收摊，
 * 否则弹窗关了麦克风还亮着，甚至两路 AudioContext 同时往 pcmChunks 里写。
 */
let generation = 0
/** 录到的 PCM 片段（单声道 Float32），停止时拼成 WAV */
let pcmChunks: Float32Array[] = []

const remaining = computed(() => Math.max(0, Math.ceil((RECORD_MS * (1 - progress.value)) / 1000)))

const hit = computed(() => (result.value?.ok ? result.value : null))
/** 复制 / 外链用的关键词，和搜索结果保持一致 */
const hitLabel = computed(() => (hit.value ? trackLabel(hit.value.title, hit.value.artist) : ''))
const altLinks = computed(() =>
  hit.value ? externalSearchLinks(hit.value.title, hit.value.artist) : []
)
/** 低于 0.9 的命中要打个问号：实测真命中普遍 ≥0.96，中间值多半是硬凑 */
const lowScore = computed(() => (hit.value ? hit.value.score < 0.9 : false))
/** 有歌手才有「只搜歌名」这一档；没有歌手时两个候选是同一个 */
const canLoosen = computed(() =>
  hit.value ? searchKeywords(hit.value.title, hit.value.artist).length > 1 : false
)
const errorReason = computed(() =>
  result.value && !result.value.ok ? result.value.reason : ''
)

function cleanup(): void {
  if (ticker) {
    clearInterval(ticker)
    ticker = 0
  }
  if (timer) {
    clearTimeout(timer)
    timer = 0
  }
  if (processor) {
    processor.onaudioprocess = null
    try {
      processor.disconnect()
    } catch {
      /* 已经断开 */
    }
    processor = null
  }
  if (captureCtx) {
    void captureCtx.close().catch(() => undefined)
    captureCtx = null
  }
  if (stream) {
    for (const track of stream.getTracks()) track.stop()
  }
  stream = null
  pcmChunks = []
}

function reset(): void {
  cancelled = true
  generation += 1
  void window.api.cancelRecognize()
  cleanup()
  requesting.value = false
  phase.value = 'idle'
  progress.value = 0
  result.value = null
  errorMsg.value = ''
  copied.value = false
}

function close(): void {
  cancelled = true
  generation += 1
  void window.api.cancelRecognize()
  cleanup()
  emit('close')
}

async function openMic(): Promise<MediaStream> {
  // 三个处理全关：回声消除会切掉伴奏里的高频，降噪会把安静段压平，
  // 自动增益把动态范围压死——都会让指纹失真，直接拉低命中率。
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  })
}

/**
 * 系统输出（loopback）。比麦克风干净得多：没有环境噪音、没有音箱二次失真，
 * 用户想识别的往往就是浏览器/播放器里正在放的那首。
 */
async function openSystemAudio(): Promise<MediaStream> {
  let captured: MediaStream
  try {
    captured = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
  } catch (error) {
    // 用户点「取消」/ 权限被拒时别再弹一次选择器（原来无条件重试，得连取消两次）。
    // 只有「这个 Chromium 要求带 video」这类参数不支持才值得用 video:true 重试。
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    if (name === 'NotAllowedError' || name === 'AbortError' || name === 'SecurityError') throw error
    if (name !== 'TypeError' && name !== 'NotSupportedError' && !/video/i.test(message)) throw error
    captured = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  }
  // 拿到后立刻掐掉画面轨（重试分支才有，主路径本身就是纯音频）
  for (const track of captured.getVideoTracks()) {
    track.stop()
    captured.removeTrack(track)
  }
  if (!captured.getAudioTracks().length) throw new Error('NO_AUDIO_TRACK')
  return captured
}

/** 16-bit PCM 加 WAV 头 */
function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buf)
  const text = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // 单声道
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  new Int16Array(buf, 44).set(samples)
  return buf
}

function floatToWav(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const pcm = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    pcm.set(chunk, offset)
    offset += chunk.length
  }
  const int16 = new Int16Array(total)
  for (let i = 0; i < total; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]))
    int16[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return new Uint8Array(encodeWav(int16, sampleRate))
}

async function startRecord(kind: Source): Promise<void> {
  reset()
  const gen = generation
  cancelled = false
  source.value = kind
  errorMsg.value = ''
  requesting.value = true
  try {
    stream = kind === 'system' ? await openSystemAudio() : await openMic()
  } catch (e) {
    requesting.value = false
    if (cancelled || unmounted || gen !== generation) return
    const name = e instanceof Error ? e.name : ''
    phase.value = 'error'
    errorMsg.value =
      name === 'NotAllowedError' || name === 'AbortError'
        ? '已取消授权。想再试一次，点下面的「再试一次」。'
        : kind === 'system'
          ? '没抓到系统声音。确认有程序正在播放音频，并且 Windows 设置里允许了本应用抓取。也可以改用麦克风录外放。'
          : '拿不到麦克风。检查系统隐私设置里是否允许本应用使用麦克风，或换成「选择音频文件」。'
    return
  }
  requesting.value = false
  // 授权是异步的：期间可能已关窗、已卸载、或又点了一次。不检查就往下走，
  // 会在组件卸载后继续创建 AudioContext 和 20 秒定时器，麦克风/屏幕共享一直不释放。
  if (cancelled || unmounted || gen !== generation) {
    for (const track of stream.getTracks()) track.stop()
    stream = null
    return
  }

  // 直接采 PCM 自己封 WAV，不用 MediaRecorder：
  // 它产出的 webm 是流式的、没有回填时长，fpcalc 解析后时间轴会错一倍
  //（实测 15 秒片段算出的指纹长度，等于整首 281 秒的 1/9 而不是 1/19），
  // 指纹与帧时间错位，AcoustID 必然匹配不上。
  captureCtx = new AudioContext()
  await captureCtx.resume().catch(() => undefined)
  captureRate = captureCtx.sampleRate
  const node = captureCtx.createMediaStreamSource(stream)
  processor = captureCtx.createScriptProcessor(4096, 1, 1)
  pcmChunks = []
  processor.onaudioprocess = (event) => {
    pcmChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  // ScriptProcessor 必须一路连到 destination 才会持续回调；中间插 0 增益，
  // 否则采到的声音会被再放一遍（麦克风直接啸叫）
  const mute = captureCtx.createGain()
  mute.gain.value = 0
  node.connect(processor)
  processor.connect(mute)
  mute.connect(captureCtx.destination)

  phase.value = 'recording'
  progress.value = 0
  const startedAt = Date.now()
  ticker = window.setInterval(() => {
    progress.value = Math.min(1, (Date.now() - startedAt) / RECORD_MS)
  }, 100)
  timer = window.setTimeout(() => {
    void finishRecord()
  }, RECORD_MS)
}

/** 结束采集并把 PCM 拼成 WAV 去识别 */
async function finishRecord(): Promise<void> {
  if (phase.value !== 'recording') return
  const gen = generation
  const rate = captureRate
  const chunks = pcmChunks
  pcmChunks = []
  cleanup()
  if (cancelled) return
  await identify(floatToWav(chunks, rate), gen)
}

function stopEarly(): void {
  void finishRecord()
}

/** 主进程结果落到 UI；弹窗已关 / 代次已变时丢弃过期结果 */
function applyResult(res: RecognitionResult, gen: number): void {
  if (cancelled || unmounted || gen !== generation) return
  result.value = res
  phase.value = res.ok ? 'done' : 'error'
  if (!res.ok) errorMsg.value = res.message
}

/** 只给「录音」用：bytes 是 44 字节头 + 16bit 单声道 PCM */
async function identify(bytes: Uint8Array, gen: number): Promise<void> {
  // 阈值按实际采样率算：48kHz 下 1 秒约 96KB，旧的 32000 是按 16kHz 写死的，
  // 只相当于 0.33 秒，过短录音会被当有效、白跑 8 档 AcoustID 查询。
  if (bytes.length < 44 + captureRate * 2) {
    if (cancelled || unmounted || gen !== generation) return
    phase.value = 'error'
    errorMsg.value = '录到的音频太短，没取到有效声音。再试一次，让声音更清楚些。'
    return
  }
  if (cancelled || unmounted || gen !== generation) return
  phase.value = 'recognizing'
  try {
    applyResult(await window.api.recognizeAudio(bytes), gen)
  } catch (e) {
    if (cancelled || unmounted || gen !== generation) return
    phase.value = 'error'
    errorMsg.value = `识别请求失败：${e instanceof Error ? e.message : String(e)}`
  }
}

async function pickFile(): Promise<void> {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*,.mp3,.flac,.m4a,.ogg,.wav,.aac,.opus'
  input.onchange = async () => {
    const file = input.files?.[0]
    // 文件对话框期间用户可能已经关掉弹窗
    if (!file || unmounted) return
    reset()
    const gen = generation
    cancelled = false
    phase.value = 'recognizing'
    try {
      // 走真实路径，别把几十 MB 的 flac 经 IPC 克隆两遍、再伪装成 query.wav
      applyResult(await window.api.recognizePickedFile(file), gen)
    } catch (e) {
      if (cancelled || unmounted || gen !== generation) return
      phase.value = 'error'
      errorMsg.value = `识别请求失败：${e instanceof Error ? e.message : String(e)}`
    }
  }
  input.click()
}

/**
 * 去音源里搜。
 *
 * 为什么不做「搜不到就自动换关键词」：实测网易云对乱码关键词也会返回 300 条模糊结果
 * （服务端兜底召回），结果为空几乎不会发生，自动降级等于永远不触发。
 * 改成用户手动按「只搜歌名」——真正会失败的情况是歌手名对不上
 *（AcoustID 会给「Echo 艾歌」这种写法，或把多歌手拼成「A, B」），歌名通常是对的。
 */
async function searchIt(titleOnly = false): Promise<void> {
  const res = hit.value
  if (!res || searching.value) return
  const candidates = searchKeywords(res.title, res.artist)
  const keyword = titleOnly ? candidates[candidates.length - 1] : candidates[0]
  if (!keyword) {
    // AcoustID 偶尔只给歌手不给歌名，这时候不能让按钮「点了没反应」
    app.toast('这条识别结果没有可用歌名，可以复制歌手名或去别的平台搜', 'info')
    return
  }
  searching.value = true
  try {
    search.keyword = keyword
    await search.run(keyword)
    // 弹窗马上会被卸载，出口要跟着搜索结果走一段，交给搜索页继续展示
    setRecognizeOrigin({ title: res.title, artist: res.artist, keyword })
    close()
    await router.push('/search')
  } catch (e) {
    app.toast(`搜索失败：${e instanceof Error ? e.message : String(e)}`, 'error')
  } finally {
    searching.value = false
  }
}

function copyTitle(): void {
  if (!hitLabel.value) return
  void window.api.copyText(hitLabel.value)
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
    copiedTimer = 0
  }, 1500)
}

/** 外链走系统浏览器：主窗口的 setWindowOpenHandler 已经这么接管了 */
function openLink(url: string): void {
  window.open(url, '_blank')
}

/**
 * 没认出来时的出口：用户往往知道歌词，或者已经把歌名复制在剪贴板里。
 * 这里复用标题栏那颗按钮的同一套取词规则，不另造一套。
 */
async function searchClipboard(): Promise<void> {
  const keyword = clipboardKeyword(await window.api.readClipboard())
  if (!keyword) {
    app.toast('剪贴板里没有可搜的文字，先复制歌名或歌词', 'info')
    return
  }
  clearRecognizeOrigin()
  close()
  search.keyword = keyword
  await router.push('/search')
  await search.run(keyword)
}

/** 待机页「直接去搜索」：光关弹窗不会把用户送到搜索页 */
function goSearchDirectly(): void {
  clearRecognizeOrigin()
  close()
  void router.push('/search')
}

onBeforeUnmount(() => {
  unmounted = true
  cancelled = true
  generation += 1
  void window.api.cancelRecognize()
  if (copiedTimer) clearTimeout(copiedTimer)
  cleanup()
})
</script>

<template>
  <div class="mask" @click.self="close">
    <div class="dialog">
      <header>
        <div class="head-text">
          <strong>听歌识曲</strong>
          <small>{{
            phase === 'recording'
              ? source === 'system'
                ? '正在录系统声音，确认有程序在放音频'
                : '正在收音，把设备靠近声源'
              : '录一段音乐，识别是什么歌'
          }}</small>
        </div>
        <button class="icon-btn" title="关闭" @click="close"><Icon name="close" :size="16" /></button>
      </header>

      <!-- 待机 -->
      <div v-if="phase === 'idle'" class="body idle">
        <div class="sources" :class="{ solo: !isWin }">
          <button
            class="src-btn"
            :disabled="requesting"
            title="用麦克风录周围的声音"
            @click="startRecord('mic')"
          >
            <span class="src-ico"><Icon name="mic" :size="30" /></span>
            <strong>麦克风</strong>
            <small>录周围的声音</small>
          </button>
          <button
            v-if="isWin"
            class="src-btn"
            :disabled="requesting"
            title="直接抓系统输出，比麦克风干净"
            @click="startRecord('system')"
          >
            <span class="src-ico"><Icon name="speaker" :size="30" /></span>
            <strong>系统声音</strong>
            <small>浏览器 / 播放器正在放的</small>
          </button>
        </div>
        <p class="tip">
          {{ requesting ? '正在等待系统授权…' : '点一下开始，录 20 秒自动识别' }}
        </p>
        <div class="alts">
          <button class="link" @click="pickFile">选择音频文件</button>
          <span>·</span>
          <button class="link" @click="goSearchDirectly">直接去搜索</button>
        </div>
      </div>

      <!-- 收音中 -->
      <div v-else-if="phase === 'recording'" class="body recording">
        <div class="ring">
          <svg viewBox="0 0 120 120">
            <circle class="track" cx="60" cy="60" r="52" />
            <circle
              class="bar"
              cx="60"
              cy="60"
              r="52"
              :style="{ '--p': progress }"
            />
          </svg>
          <div class="count">{{ remaining }}<small>s</small></div>
        </div>
        <p class="tip">保持安静，让音乐清楚一点</p>
        <button class="btn" @click="stopEarly">现在就开始识别</button>
      </div>

      <!-- 识别中 -->
      <div v-else-if="phase === 'recognizing'" class="body recognizing">
        <div class="spinner" />
        <p class="tip">正在比对指纹，需要几秒…</p>
      </div>

      <!-- 成功 -->
      <div v-else-if="phase === 'done' && result?.ok" class="body done">
        <div class="hit">
          <strong class="title">{{ result.title || '未知曲目' }}</strong>
          <span v-if="result.artist" class="artist">{{ result.artist }}</span>
          <span v-if="result.album" class="album">{{ result.album }}</span>
        </div>
        <div class="actions">
          <button class="btn primary" :disabled="searching" @click="searchIt()">
            <Icon name="search" :size="14" /> {{ searching ? '正在搜索…' : '在音源中搜索' }}
          </button>
          <button class="btn" @click="copyTitle">{{ copied ? '已复制' : '复制歌名' }}</button>
          <button class="btn" @click="reset">再识一次</button>
        </div>

        <!-- 认出来了但音源里没有（周杰伦这类版权缺失）：
             出口常驻，别等搜完再给——用户想直接去别处，不该先看一屏无关结果 -->
        <div v-if="altLinks.length" class="elsewhere">
          <span class="elsewhere-label">音源里没有？去别处找：</span>
          <div class="alt-links">
            <template v-for="(link, index) in altLinks" :key="link.id">
              <span v-if="index" class="dot">·</span>
              <button
                class="link"
                :title="`在浏览器中打开${link.label}搜索`"
                @click="openLink(link.url)"
              >
                {{ link.label }}
              </button>
            </template>
          </div>
        </div>

        <p v-if="canLoosen" class="loosen">
          带上歌手搜不到？
          <button class="link" @click="searchIt(true)">只搜歌名</button>
        </p>

        <p class="meta">
          AcoustID 置信度 {{ Math.round(result.score * 100) }}%
          <span v-if="lowScore" class="warn">· 偏低，可能不是这首</span>
        </p>
      </div>

      <!-- 失败 -->
      <div v-else class="body error">
        <div class="fail-icon"><Icon name="mic" :size="26" /></div>
        <p class="fail-msg">{{ errorMsg }}</p>
        <div class="actions">
          <!-- 缺组件是装包问题，重试没有意义，别给假按钮 -->
          <template v-if="errorReason !== 'binary-missing'">
            <button class="btn primary" @click="reset">再试一次</button>
            <button class="btn" @click="pickFile">选择音频文件</button>
          </template>
          <button class="btn" @click="searchClipboard">用剪贴板文字搜</button>
        </div>
        <p class="hint">
          <template v-if="errorReason === 'binary-missing'">
            这个安装包里没有识别组件（指纹计算程序没随包分发），暂时用不了。复制歌名或歌词，用搜索框找即可。
          </template>
          <template v-else>
            AcoustID 只收正式发行的录音，OST、翻唱、网络歌手通常查不到。知道歌名或歌词的话，复制后点「用剪贴板文字搜」更快。
          </template>
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(8px);
}

.dialog {
  width: 400px;
  max-width: calc(100vw - 40px);
  padding: 18px 20px 20px;
  border-radius: 18px;
  border: 1px solid var(--overlay-border);
  background: var(--overlay-bg);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}

header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 16px;
}

.head-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.head-text strong {
  font-size: 15px;
  color: var(--text);
}

.head-text small {
  font-size: 12px;
  color: var(--text-3);
}

.body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 6px 0 2px;
}

/* 待机：两个音源入口 */
.sources {
  display: flex;
  gap: 12px;
}
.sources.solo {
  justify-content: center;
}
.src-btn {
  width: 152px;
  padding: 14px 8px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  transition:
    transform 0.18s var(--ease),
    border-color 0.18s var(--ease),
    background 0.18s var(--ease);
}
.src-btn:hover {
  transform: translateY(-2px);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}
.src-btn:disabled {
  opacity: 0.6;
  cursor: default;
  transform: none;
  border-color: var(--border);
  background: rgba(255, 255, 255, 0.04);
}
.src-ico {
  width: 52px;
  height: 52px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.src-btn strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.src-btn small {
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
  color: var(--text-3);
}

.tip {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}

.alts {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-3);
}

.link {
  border: 0;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.link:hover {
  color: var(--accent);
}

/* 收音中：进度环 */
.ring {
  position: relative;
  width: 132px;
  height: 132px;
}
.ring svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring circle {
  fill: none;
  stroke-width: 5;
}
.ring .track {
  stroke: color-mix(in srgb, var(--text) 12%, transparent);
}
.ring .bar {
  stroke: var(--accent);
  stroke-linecap: round;
  stroke-dasharray: 327;
  stroke-dashoffset: calc(327 - 327 * var(--p, 0));
  transition: stroke-dashoffset 0.12s linear;
}
.count {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 30px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.count small {
  font-size: 13px;
  margin-left: 2px;
  color: var(--text-3);
}

/* 识别中 */
.spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid color-mix(in srgb, var(--text) 14%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 成功 */
.hit {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  text-align: center;
}
.hit .title {
  font-size: 19px;
  line-height: 1.35;
  color: var(--text);
}
.hit .artist {
  font-size: 13.5px;
  color: var(--text-2);
}
.hit .album {
  font-size: 12px;
  color: var(--text-3);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 2px;
}

.meta {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.meta .warn {
  color: color-mix(in srgb, #f0a04b 78%, var(--text-3));
}

/* 认出来但音源里没有：常驻的外链出口 */
.elsewhere {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
  transition: all 0.2s var(--ease);
}
.elsewhere-label {
  color: var(--text-3);
}
.alt-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.dot {
  color: var(--text-3);
  opacity: 0.6;
}

.loosen {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-3);
}
.loosen .link {
  font-size: 11.5px;
}

.actions .btn:disabled {
  opacity: 0.6;
  cursor: default;
}

/* 失败 */
.fail-icon {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text) 7%, transparent);
  color: var(--text-3);
}
.fail-msg {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  color: var(--text-2);
}
.hint {
  margin: 4px 0 0;
  font-size: 11.5px;
  line-height: 1.65;
  text-align: center;
  color: var(--text-3);
}
</style>
