/**
 * 驾驶模式的 TTS 播报：切歌时用系统语音念「歌名，歌手」。
 *
 * 走 Web Speech API（Chromium 内置），Windows 下接 SAPI 本地语音——离线可用、
 * 不依赖网络语音服务。voice 列表是异步加载的：首次 getVoices() 常为空，
 * 监听 voiceschanged 补取一次并缓存。
 */
import type { Song } from '@shared/types'

let cachedVoice: SpeechSynthesisVoice | null | undefined

/** 选中文语音：优先 zh-CN，其次本地服务（不联网）。没有就返回 null（静默跳过） */
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined) return cachedVoice
  if (!('speechSynthesis' in window)) return null
  const voices = window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('zh'))
  if (!voices.length) {
    // 列表还没加载好：挂一次 voiceschanged 再取。拿到结果前本次播报静默跳过
    window.speechSynthesis.addEventListener(
      'voiceschanged',
      () => {
        cachedVoice = pickVoiceFrom(window.speechSynthesis.getVoices())
      },
      { once: true }
    )
    return null
  }
  return (cachedVoice = pickVoiceFrom(voices))
}

function pickVoiceFrom(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => v.lang.replace('_', '-').toLowerCase() === 'zh-cn' && v.localService) ??
    voices.find((v) => v.lang.replace('_', '-').toLowerCase() === 'zh-cn') ??
    voices.find((v) => v.localService) ??
    voices[0] ??
    null
  )
}

/** 播报当前曲目。enabled=false 或引擎缺失时是空操作；连跳时旧的播报被 cancel，只念最新 */
export function speakNowPlaying(song: Song | null, enabled: boolean): void {
  if (!enabled || !song || !('speechSynthesis' in window)) return
  cancelTts()
  const utter = new SpeechSynthesisUtterance(
    `${song.name}，${song.artists.length ? song.artists.join('、') : ''}`
  )
  const voice = pickVoice()
  if (voice) {
    utter.voice = voice
    utter.lang = voice.lang
  }
  // 语速稍快更像「报站」；音量独立于音乐音量，避免用户音乐开得小时播报也听不见
  utter.rate = 1.1
  utter.volume = 0.9
  try {
    window.speechSynthesis.speak(utter)
  } catch {
    /* 引擎不可用：静默跳过，播报失败不该打断驾驶模式 */
  }
}

export function cancelTts(): void {
  if (!('speechSynthesis' in window)) return
  try {
    window.speechSynthesis.cancel()
  } catch {
    /* ignore */
  }
}
