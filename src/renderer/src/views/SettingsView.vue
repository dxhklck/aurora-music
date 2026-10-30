<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../components/Icon.vue'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'
import { useLibraryStore } from '../stores/library'
import { formatBytes } from '@shared/lyric'
import type { EngineStatusView, SourceHealthView, UpdateStatusView } from '@shared/api'
import { type QrLoginPlatform, type QrLoginState } from '@shared/types'
import type { NeteaseAccountInfo } from '@shared/types'
import type { Quality } from '@shared/types'

const app = useAppStore()
const download = useDownloadStore()
const library = useLibraryStore()
const router = useRouter()

const engine = ref<EngineStatusView | null>(null)
const probing = ref(false)
const dir = ref('')

const settings = computed(() => app.settings)

const qqDraft = ref('')
const neteaseDraft = ref('')
const qqTip = ref(false)
const neteaseTip = ref(false)

const qualities: Array<{ value: Quality; label: string; hint: string }> = [
  { value: 'standard', label: '标准', hint: '128k，最省流量' },
  { value: 'high', label: '较高', hint: '320k，日常推荐' },
  { value: 'lossless', label: '无损', hint: 'FLAC/WAV，看平台资源' }
]

const engineSources = computed(() => app.providers.filter((item) => item.id.startsWith('mdl-')))

/**
 * 上游健康巡检：15 个源全是爬取实现，上游一改版就静默失效，表现是「这个源什么都搜不到」。
 * 用户分不清「没这首歌」还是「源挂了」，所以主进程定期给每个源发一次最小搜索，这里按源显色。
 */
const health = ref<SourceHealthView | null>(null)

const healthText = computed(() => {
  const s = health.value
  if (!s) return '尚未巡检'
  if (s.running) return '巡检中…'
  if (!s.checkedAt) return '尚未巡检（启动 20 秒后自动开始）'
  const good = s.items.filter((item) => item.state === 'ok').length
  const empty = s.items.filter((item) => item.state === 'empty').length
  const bad = s.items.filter((item) => item.state === 'fail').length
  const parts = [`${good}/${s.items.length} 正常`]
  if (empty) parts.push(`${empty} 个搜不到`)
  if (bad) parts.push(`${bad} 个失败`)
  return `${parts.join(' · ')} · ${agoText(s.checkedAt)}`
})

function agoText(at: number): string {
  if (!at) return '从未'
  const minutes = Math.round((Date.now() - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function healthTip(item: SourceHealthView['items'][number]): string {
  const when = item.checkedAt ? agoText(item.checkedAt) : '未巡检'
  if (item.state === 'fail') return `${item.label} · ${when}失败：${item.error}`
  if (item.state === 'empty') return `${item.label} · ${when}能连通，但搜索没有结果`
  if (item.state === 'ok') return `${item.label} · ${when}正常（${item.ms}ms）`
  return `${item.label} · 尚未巡检`
}

/* ---------- 自动更新 ---------- */
const update = ref<UpdateStatusView | null>(null)
let offUpdateStatus: (() => void) | null = null
const checkingUpdate = ref(false)

const updateText = computed(() => {
  const s = update.value
  if (!s) return ''
  switch (s.state) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return s.version ? `发现新版本 v${s.version}，正在自动下载…` : '发现新版本，正在自动下载…'
    case 'downloading':
      return `正在下载更新… ${s.percent ?? 0}%`
    case 'ready':
      return s.version ? `v${s.version} 已就绪，重启后安装` : '更新已就绪，重启后安装'
    case 'error':
      // 失败可能发生在「检查」也可能发生在「下载」，不要一律写成检查失败
      return s.message ?? '更新失败，请稍后重试'
    default:
      return '已是最新版本'
  }
})

async function checkUpdate(): Promise<void> {
  checkingUpdate.value = true
  try {
    update.value = await window.api.checkForUpdate()
  } finally {
    checkingUpdate.value = false
  }
}

function installUpdateNow(): void {
  window.api.installUpdate()
}

/** 自动更新走不通时的兜底：直接打开 Releases 页，用户自己下安装包 */
function openManualDownload(): void {
  if (update.value?.manualUrl) window.open(update.value.manualUrl)
}

onMounted(() => {
  offUpdateStatus = window.api.onUpdateStatus((status) => {
    update.value = status
  })
  // 静默拿一次当前状态（不主动发起网络检查；检查由主进程启动后半分钟做）
  update.value = { supported: true, state: 'idle', currentVersion: '' }
  void window.api.checkForUpdate().then((s) => (update.value = s)).catch(() => undefined)
})
onBeforeUnmount(() => offUpdateStatus?.())

async function patch(patchValue: Parameters<typeof app.patchSettings>[0]): Promise<void> {
  await app.patchSettings(patchValue)
  if ('engineEnabled' in patchValue) {
    await app.reloadProviders()
    await probe()
  }
}

async function probe(): Promise<void> {
  probing.value = true
  try {
    engine.value = await window.api.engineStatus()
    health.value = await window.api.sourceHealth()
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), 'error')
  } finally {
    probing.value = false
  }
}

async function restartEngine(): Promise<void> {
  probing.value = true
  try {
    engine.value = await window.api.engineRestart()
    if (engine.value?.ready) app.toast('引擎已就绪，开始巡检上游…', 'success')
    else app.toast(engine.value?.error || '引擎未就绪', 'error')
  } finally {
    probing.value = false
  }
  await refreshHealth()
}

/** 手动巡检：15 个源串行错开跑，可能要等 20-60 秒，期间按钮禁用 */
async function refreshHealth(): Promise<void> {
  health.value = health.value ? { ...health.value, running: true } : { checkedAt: 0, running: true, items: [] }
  try {
    health.value = await window.api.sourceHealthRefresh()
    const bad = health.value.items.filter((item) => item.state === 'fail')
    if (!bad.length) app.toast('全部音源正常', 'success')
    else app.toast(`${bad.length} 个音源请求失败：${bad.map((item) => item.label).join('、')}`, 'error')
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), 'error')
  }
}

async function chooseDir(): Promise<void> {
  dir.value = await window.api.chooseDownloadDir()
  app.toast(`下载目录：${dir.value}`, 'info')
}

async function saveCookie(platform: 'qq' | 'netease'): Promise<void> {
  const value = (platform === 'qq' ? qqDraft.value : neteaseDraft.value)
    .replace(/[\r\n]+/g, ' ')
    .trim()
  await patch(platform === 'qq' ? { qqCookie: value } : { neteaseCookie: value })
  app.toast(value ? 'Cookie 已保存，立即生效' : 'Cookie 已清除', value ? 'success' : 'info')
}

async function clearCookie(platform: 'qq' | 'netease'): Promise<void> {
  if (platform === 'qq') qqDraft.value = ''
  else neteaseDraft.value = ''
  await patch(
    platform === 'qq' ? { qqCookie: '' } : { neteaseCookie: '', neteaseAccount: null }
  )
  app.toast('已退出登录态', 'info')
}

/* ---------------- 手机号登录（网易云，移动端主登录方式） ---------------- */

const neteaseAccount = computed<NeteaseAccountInfo | null>(() => settings.value?.neteaseAccount ?? null)

const phoneVisible = ref(false)
const phoneMode = ref<'captcha' | 'password'>('captcha')
const phoneValue = ref('')
const phoneCode = ref('')
const phonePassword = ref('')
const phoneBusy = ref(false)
const phoneError = ref('')
const captchaCountdown = ref(0)
let captchaTimer = 0

const phoneValid = computed(() => /^1\d{10}$/.test(phoneValue.value.trim()))
const canSendCaptcha = computed(
  () => phoneValid.value && captchaCountdown.value === 0 && !phoneBusy.value
)
const canSubmit = computed(
  () =>
    phoneValid.value &&
    !phoneBusy.value &&
    (phoneMode.value === 'password'
      ? phonePassword.value.length >= 6
      : /^\d{4,6}$/.test(phoneCode.value.trim()))
)

function openPhoneLogin(): void {
  phoneError.value = ''
  phoneCode.value = ''
  phonePassword.value = ''
  phoneVisible.value = true
}

function closePhoneLogin(): void {
  phoneVisible.value = false
  if (captchaTimer) window.clearInterval(captchaTimer)
  captchaTimer = 0
  captchaCountdown.value = 0
}

async function sendCaptcha(): Promise<void> {
  if (!canSendCaptcha.value) return
  phoneBusy.value = true
  phoneError.value = ''
  try {
    const result = await window.api.sendSmsCaptcha(phoneValue.value.trim())
    if (result.ok) {
      app.toast(result.message, 'success')
      captchaCountdown.value = 60
      captchaTimer = window.setInterval(() => {
        captchaCountdown.value = Math.max(0, captchaCountdown.value - 1)
        if (captchaCountdown.value === 0 && captchaTimer) {
          window.clearInterval(captchaTimer)
          captchaTimer = 0
        }
      }, 1000)
    } else {
      phoneError.value = result.message
    }
  } catch (error) {
    phoneError.value = error instanceof Error ? error.message : String(error)
  } finally {
    phoneBusy.value = false
  }
}

async function submitPhoneLogin(): Promise<void> {
  if (!canSubmit.value) return
  phoneBusy.value = true
  phoneError.value = ''
  try {
    const result = await window.api.cellphoneLogin({
      phone: phoneValue.value.trim(),
      captcha: phoneMode.value === 'captcha' ? phoneCode.value.trim() : undefined,
      password: phoneMode.value === 'password' ? phonePassword.value : undefined
    })
    if (result.ok && result.account) {
      closePhoneLogin()
      app.toast(`${result.account.nickname || '网易云'}登录成功，立即生效`, 'success')
    } else {
      phoneError.value = result.message ?? '登录失败，请稍后重试'
    }
  } catch (error) {
    phoneError.value = error instanceof Error ? error.message : String(error)
  } finally {
    phoneBusy.value = false
  }
}

onBeforeUnmount(() => {
  if (captchaTimer) window.clearInterval(captchaTimer)
})

/* ---------------- 扫码登录 ---------------- */

const qrVisible = ref(false)
const qrPlatform = ref<QrLoginPlatform>('qq')
const qrState = ref<QrLoginState | null>(null)
const qrCountdown = ref(0)
let qrPollTimer = 0
let qrTickTimer = 0

const qrLoading = computed(() => qrVisible.value && !qrState.value?.qrImage)
const qrExpired = computed(() => qrState.value?.phase === 'expired')

function qrCountdownText(): string {
  const total = Math.max(0, Math.floor(qrCountdown.value))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function stopQrTimers(): void {
  if (qrPollTimer) window.clearInterval(qrPollTimer)
  if (qrTickTimer) window.clearInterval(qrTickTimer)
  qrPollTimer = 0
  qrTickTimer = 0
}

async function pollQrOnce(): Promise<void> {
  const state = await window.api.pollQrLogin()
  if (!qrVisible.value) return
  qrState.value = state
  qrCountdown.value = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000))
  if (state.phase === 'success') {
    stopQrTimers()
    app.toast(`${qrPlatform.value === 'qq' ? 'QQ 音乐' : '网易云音乐'}登录成功，立即生效`, 'success')
    window.setTimeout(() => {
      qrVisible.value = false
      qrState.value = null
    }, 800)
    return
  }
  if (state.phase === 'error' || state.phase === 'expired') {
    stopQrTimers()
  }
}

async function openQrLogin(platform: QrLoginPlatform): Promise<void> {
  qrPlatform.value = platform
  qrState.value = null
  qrVisible.value = true
  stopQrTimers()
  try {
    const state = await window.api.startQrLogin(platform)
    qrState.value = state
    qrCountdown.value = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000))
  } catch (error) {
    app.toast(error instanceof Error ? error.message : String(error), 'error')
    qrVisible.value = false
    return
  }
  qrPollTimer = window.setInterval(() => void pollQrOnce(), 2500)
  qrTickTimer = window.setInterval(() => {
    qrCountdown.value = Math.max(0, qrCountdown.value - 1)
  }, 1000)
}

function refreshQr(): void {
  void openQrLogin(qrPlatform.value)
}

function closeQrLogin(): void {
  stopQrTimers()
  qrVisible.value = false
  qrState.value = null
  window.api.cancelQrLogin()
}

/* ---------------- 浏览器内登录 ---------------- */

async function openBrowserLogin(platform: QrLoginPlatform): Promise<void> {
  try {
    await window.api.openLoginWindow(platform)
    // 移动端（android）：webLogin 返回即登录完成（Cookie 已抓取落库）；
    // 桌面端只是打开了登录窗口，登录结果走 onLoginWindowResult 事件
    if (window.api.platform === 'android') app.toast('登录成功，立即生效', 'success')
    else app.toast('已打开登录窗口，在里面像平时一样登录即可', 'info')
  } catch (error) {
    app.toast(error instanceof Error ? error.message : '登录未完成', 'info')
  }
}

/** 设计者 B 站主页直达：window.open 会被主进程转交系统浏览器（setWindowOpenHandler） */
function openBilibili(): void {
  window.open('https://space.bilibili.com/477558144')
}

/**
 * 导出诊断信息：系统与运行时信息 + 脱敏后的设置 + 音源巡检 + 最近日志，
 * 保存成一个 txt。遇到「没声音 / 白屏 / 某个源搜不到」时先让用户导这个。
 */
const exportingDiag = ref(false)

async function exportDiagnostics(): Promise<void> {
  if (exportingDiag.value) return
  exportingDiag.value = true
  try {
    const path = await window.api.exportDiagnostics()
    if (path) app.toast('诊断信息已导出，可直接发给开发者', 'success')
  } catch (error) {
    app.toast(error instanceof Error ? error.message : '导出失败', 'error')
  } finally {
    exportingDiag.value = false
  }
}

let offLoginResult: (() => void) | null = null

onBeforeUnmount(() => {
  stopQrTimers()
  window.api.cancelQrLogin()
})

onMounted(async () => {
  qqDraft.value = settings.value?.qqCookie ?? ''
  neteaseDraft.value = settings.value?.neteaseCookie ?? ''
  offLoginResult = window.api.onLoginWindowResult((result) => {
    if (result.ok) {
      app.toast(`${result.platform === 'qq' ? 'QQ 音乐' : '网易云音乐'}登录成功，立即生效`, 'success')
      if (result.platform === 'qq') qqDraft.value = settings.value?.qqCookie ?? ''
      else neteaseDraft.value = settings.value?.neteaseCookie ?? ''
    } else if (result.message !== '登录窗口已关闭') {
      app.toast(result.message, 'error')
    }
  })
  await Promise.all([probe(), library.load()])
  dir.value = await window.api.downloadDir()
})

onBeforeUnmount(() => {
  offLoginResult?.()
  offLoginResult = null
})
</script>

<template>
  <div class="settings">
    <header class="head">
      <div>
        <h1>设置</h1>
        <p>音质、下载策略与 musicdl 引擎，改动即时生效并落盘</p>
      </div>
      <span class="tag">v{{ update?.currentVersion || '…' }}</span>
    </header>

    <!-- 窗口行为 -->
    <section class="card block">
      <div class="block-head">
        <span class="ico"><Icon name="minimize" :size="15" /></span>
        <div>
          <strong>窗口行为</strong>
          <small>托盘不可用（如部分 Linux）时关闭按钮始终为退出</small>
        </div>
      </div>

      <div class="row">
        <label>关闭窗口时最小化到系统托盘（后台继续播放）</label>
        <button class="switch" :class="{ on: settings?.closeToTray }" @click="patch({ closeToTray: !settings?.closeToTray })">
          <i />
        </button>
      </div>
    </section>

    <!-- 播放 -->
    <section class="card block">
      <div class="block-head">
        <span class="ico"><Icon name="play" :size="15" /></span>
        <div>
          <strong>播放</strong>
          <small>音质决定取址时的回退梯度，失败会逐档降级</small>
        </div>
      </div>

      <div class="row">
        <label>音质偏好</label>
        <div class="seg">
          <button
            v-for="item in qualities"
            :key="item.value"
            :class="{ on: settings?.quality === item.value }"
            :title="item.hint"
            @click="patch({ quality: item.value })"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <div class="row">
        <label>播放失败时自动换源</label>
        <button class="switch" :class="{ on: settings?.autoSwitchSource }" @click="patch({ autoSwitchSource: !settings?.autoSwitchSource })">
          <i />
        </button>
      </div>

      <div class="row">
        <label>每次搜索条数</label>
        <input
          class="num"
          type="number"
          min="10"
          max="50"
          :value="settings?.searchLimit"
          @change="patch({ searchLimit: Number(($event.target as HTMLInputElement).value) })"
        />
      </div>
    </section>

    <!-- 下载 -->
    <section class="card block">
      <div class="block-head">
        <span class="ico"><Icon name="download" :size="15" /></span>
        <div>
          <strong>下载</strong>
          <small>直连流式落盘 · 断点续传 · 完成后写歌词与标签</small>
        </div>
      </div>

      <div class="row">
        <label>保存目录</label>
        <div class="path">
          <span class="truncate">{{ dir || settings?.downloadDir }}</span>
          <button class="btn" @click="chooseDir"><Icon name="folder" :size="13" /> 更改</button>
        </div>
      </div>

      <div class="row">
        <label>同时下载任务数</label>
        <div class="seg">
          <button
            v-for="n in [1, 2, 3, 4]"
            :key="n"
            :class="{ on: settings?.downloadConcurrency === n }"
            @click="patch({ downloadConcurrency: n })"
          >
            {{ n }}
          </button>
        </div>
      </div>

      <div class="row">
        <label>单任务最大尝试次数</label>
        <div class="seg">
          <button
            v-for="n in [1, 2, 3, 4, 5]"
            :key="n"
            :class="{ on: settings?.downloadRetries === n }"
            @click="patch({ downloadRetries: n })"
          >
            {{ n }}
          </button>
        </div>
      </div>

      <div class="row">
        <label>写入音频标签（标题/歌手/专辑/歌词）</label>
        <button class="switch" :class="{ on: settings?.writeTags }" @click="patch({ writeTags: !settings?.writeTags })">
          <i />
        </button>
      </div>

      <p class="hint">
        已下载 {{ download.finished.length }} 首 · 本地库 {{ library.items.length }} 首 ·
        {{ formatBytes(library.totalSize) }}
      </p>
    </section>

    <!-- 账号 -->
    <section class="card block">
      <div class="block-head">
        <span class="ico"><Icon name="lock" :size="15" /></span>
        <div>
          <strong>账号登录</strong>
          <small>推荐浏览器登录（应用内打开官网，像平时一样登录即可），也可扫码或手动粘贴 Cookie；只存本机</small>
        </div>
      </div>

      <div class="account">
        <div class="account-head">
          <strong>QQ 音乐</strong>
          <span class="state" :class="settings?.qqCookie ? 'ok' : 'bad'">
            {{ settings?.qqCookie ? '已登录' : '未登录' }}
          </span>
        </div>
        <div class="account-actions">
          <button class="btn" @click="openQrLogin('qq')">
            <Icon name="qrcode" :size="14" /> 扫码登录
          </button>
          <button class="btn" @click="openBrowserLogin('qq')">
            <Icon name="monitor" :size="14" /> 浏览器登录
          </button>
        </div>
        <details class="adv">
          <summary>高级 · 粘贴 Cookie</summary>
          <textarea
            v-model="qqDraft"
            class="cookie"
            rows="3"
            spellcheck="false"
            placeholder="整段 Cookie，例如：uin=o0123456789; qm_keyst=…; qqmusic_key=…"
          ></textarea>
          <div class="account-actions">
            <button class="btn ghost" :disabled="!qqDraft.trim()" @click="saveCookie('qq')">保存</button>
            <button class="btn ghost" :disabled="!settings?.qqCookie" @click="clearCookie('qq')">清除</button>
            <button class="btn ghost" @click="qqTip = !qqTip">
              {{ qqTip ? '收起' : '怎么拿 Cookie？' }}
            </button>
          </div>
          <div v-if="qqTip" class="tip">
            <ol>
              <li>浏览器打开 <code>y.qq.com</code>，登录你的账号（VIP 权益随之生效）</li>
              <li>按 <kbd>F12</kbd> 打开开发者工具，切到「网络 / Network」面板</li>
              <li>刷新页面，点任意一条发往 <code>y.qq.com</code> 的请求</li>
              <li>在「请求头 / Request Headers」里找到 <code>Cookie</code>，整段复制粘贴到上面</li>
            </ol>
            <p class="tiny">Cookie 会过期，失效后重新拿一次即可；点「清除」随时退出登录态。</p>
          </div>
        </details>
      </div>

      <div class="account">
        <div class="account-head">
          <strong>网易云音乐</strong>
          <span class="state" :class="neteaseAccount ? 'ok' : 'bad'">
            {{ neteaseAccount ? '已登录' : '未登录' }}
          </span>
        </div>

        <!-- 账号卡片：登录后展示 -->
        <div v-if="neteaseAccount" class="profile-card">
          <img
            v-if="neteaseAccount.avatarUrl"
            :src="neteaseAccount.avatarUrl"
            class="avatar"
            referrerpolicy="no-referrer"
            alt=""
          />
          <span v-else class="avatar letter">{{ (neteaseAccount.nickname || '网').slice(0, 1) }}</span>
          <div class="profile-meta">
            <strong class="truncate">{{ neteaseAccount.nickname || `用户 ${neteaseAccount.userId}` }}</strong>
            <small>{{ neteaseAccount.vipType > 0 ? 'VIP 会员 · 登录态生效中' : '登录态生效中 · VIP 曲目按平台规则解锁' }}</small>
          </div>
          <button class="btn ghost" @click="clearCookie('netease')">退出登录</button>
        </div>

        <!-- 未登录：登录入口 -->
        <template v-else>
          <div class="account-actions">
            <button class="btn primary" @click="openPhoneLogin">
              <Icon name="lock" :size="14" /> 手机号登录
            </button>
            <button class="btn" @click="openQrLogin('netease')">
              <Icon name="qrcode" :size="14" /> 扫码
            </button>
            <button class="btn" @click="openBrowserLogin('netease')">
              <Icon name="monitor" :size="14" /> 浏览器登录
            </button>
          </div>
          <details class="adv">
            <summary>高级 · 粘贴 Cookie</summary>
            <textarea
              v-model="neteaseDraft"
              class="cookie"
              rows="3"
              spellcheck="false"
              placeholder="整段 Cookie，例如：MUSIC_U=…; __remember_me=true"
            ></textarea>
            <div class="account-actions">
              <button class="btn ghost" :disabled="!neteaseDraft.trim()" @click="saveCookie('netease')">保存</button>
              <button class="btn ghost" :disabled="!settings?.neteaseCookie" @click="clearCookie('netease')">清除</button>
              <button class="btn ghost" @click="neteaseTip = !neteaseTip">
                {{ neteaseTip ? '收起' : '怎么拿 Cookie？' }}
              </button>
            </div>
            <div v-if="neteaseTip" class="tip">
              <ol>
                <li>浏览器打开 <code>music.163.com</code>，登录你的账号</li>
                <li>按 <kbd>F12</kbd> 打开开发者工具，切到「网络 / Network」面板</li>
                <li>刷新页面，点任意一条请求（如 <code>music.163.com/weapi/…</code>）</li>
                <li>复制请求头里的 <code>Cookie</code> 整段粘贴到上面</li>
              </ol>
              <p class="tiny">用于解锁无损 / Hi-Res 音质与 VIP 曲目；同样只保存在本机。</p>
            </div>
          </details>
        </template>
      </div>

      <p class="hint">
        不内置任何账号。手机号登录、扫码与粘贴 Cookie 等价——都是把你自己的登录态交给本机使用，
        仅用于以你自己的权限访问各平台公开接口，随时可以退出。
      </p>
      <p class="hint">
        其余平台暂无登录入口：酷我搜索与取址走免 token 接口，匿名即可完整使用；
        引擎音源（酷狗 / 咪咕 / 千千等）暂不支持注入登录态。
      </p>
    </section>

    <!-- 扫码登录弹层 -->
    <div v-if="qrVisible" class="qr-mask" @click.self="closeQrLogin">
      <div class="qr-card" :class="qrState?.phase">
        <header class="qr-head">
          <strong>{{ qrPlatform === 'qq' ? 'QQ 音乐' : '网易云音乐' }}扫码登录</strong>
          <button class="icon-btn" aria-label="关闭" @click="closeQrLogin">
            <Icon name="close" :size="13" />
          </button>
        </header>
        <div class="qr-body">
          <div class="qr-frame">
            <img v-if="qrState?.qrImage" :src="qrState.qrImage" alt="登录二维码" />
            <span v-else class="qr-loading">生成中…</span>
            <div v-if="qrState?.phase === 'expired'" class="qr-expired">
              <button class="btn" @click="refreshQr">已过期，点击刷新</button>
            </div>
          </div>
          <p class="qr-status">
            <span v-if="qrLoading">正在获取二维码…</span>
            <template v-else-if="qrState">
              <span v-if="qrState.phase === 'success'" class="ok">登录成功</span>
              <span v-else-if="qrState.phase === 'error'">{{ qrState.message }}</span>
              <span v-else-if="qrState.phase === 'expired'">二维码已过期</span>
              <span v-else>{{ qrState.message }}</span>
              <small v-if="qrState.phase !== 'success' && qrCountdown > 0 && !qrExpired">
                有效期 {{ qrCountdownText() }}
              </small>
            </template>
          </p>
          <p class="qr-tip">
            用手机
            {{ qrPlatform === 'qq' ? 'QQ' : '网易云音乐' }} App
            扫描上方二维码，并在手机上确认登录
          </p>
        </div>
        <footer class="qr-foot">
          <button class="btn ghost" @click="closeQrLogin">取消</button>
        </footer>
      </div>
    </div>

    <!-- 手机号登录弹层（网易云） -->
    <div v-if="phoneVisible" class="qr-mask" @click.self="closePhoneLogin">
      <div class="qr-card phone-card">
        <header class="qr-head">
          <strong>网易云音乐 · 手机号登录</strong>
          <button class="icon-btn" aria-label="关闭" @click="closePhoneLogin">
            <Icon name="close" :size="13" />
          </button>
        </header>
        <div class="phone-body">
          <div class="seg mode">
            <button :class="{ on: phoneMode === 'captcha' }" @click="phoneMode = 'captcha'">
              验证码登录
            </button>
            <button :class="{ on: phoneMode === 'password' }" @click="phoneMode = 'password'">
              密码登录
            </button>
          </div>
          <input
            v-model="phoneValue"
            class="phone-input"
            type="tel"
            inputmode="numeric"
            autocomplete="tel"
            maxlength="11"
            placeholder="手机号"
            @keydown.enter="submitPhoneLogin"
          />
          <div v-if="phoneMode === 'captcha'" class="code-row">
            <input
              v-model="phoneCode"
              class="phone-input grow"
              type="text"
              inputmode="numeric"
              autocomplete="one-time-code"
              maxlength="6"
              placeholder="验证码"
              @keydown.enter="submitPhoneLogin"
            />
            <button class="btn send" :disabled="!canSendCaptcha" @click="sendCaptcha">
              {{ captchaCountdown > 0 ? `${captchaCountdown}s 后重发` : '发送验证码' }}
            </button>
          </div>
          <input
            v-else
            v-model="phonePassword"
            class="phone-input"
            type="password"
            autocomplete="current-password"
            placeholder="登录密码"
            @keydown.enter="submitPhoneLogin"
          />
          <p v-if="phoneError" class="phone-error">{{ phoneError }}</p>
          <button class="btn primary submit" :disabled="!canSubmit" @click="submitPhoneLogin">
            {{ phoneBusy ? '登录中…' : '登录' }}
          </button>
          <p class="tiny">
            验证码 / 密码只发往网易云官方接口，换取你本人的登录态；凭据只存本机，随时可退出。
          </p>
        </div>
      </div>
    </div>

    <!-- 音源引擎 -->
    <section class="card block">
      <div class="block-head">
        <span class="ico"><Icon name="search" :size="15" /></span>
        <div>
          <strong>音源引擎</strong>
          <small>进程内 TypeScript 实现，内置 15 个长尾音源、直链解析与标签写入，无需额外运行时</small>
        </div>
        <span class="state" :class="engine?.ready ? 'ok' : 'bad'">
          {{ engine?.ready ? '已就绪' : '未就绪' }}
        </span>
      </div>

      <div class="row">
        <label>启用引擎音源</label>
        <button class="switch" :class="{ on: settings?.engineEnabled }" @click="patch({ engineEnabled: !settings?.engineEnabled })">
          <i />
        </button>
      </div>

      <div v-if="engine" class="engine">
        <div class="kv">
          <span>运行时</span>
          <em>{{ engine.runtime?.label ?? '未找到' }}</em>
        </div>
        <div class="kv">
          <span>版本</span>
          <em class="mono truncate">{{ engine.runtime?.version ?? '—' }}</em>
        </div>
        <div class="kv">
          <span>音源</span>
          <em>{{ engine.runtime?.sources ?? 0 }} 个</em>
        </div>
        <div class="kv">
          <span>上游巡检</span>
          <em>{{ healthText }}</em>
        </div>
        <div v-if="engine.error" class="err">{{ engine.error }}</div>

        <!-- 按源显色：红=请求失败、黄=能通但搜不到、灰=还没巡检过 -->
        <div v-if="health?.items.length" class="health-grid">
          <span
            v-for="item in health.items"
            :key="item.key"
            class="src"
            :class="item.state"
            :title="healthTip(item)"
          >
            <i />{{ item.label }}
          </span>
        </div>

        <div class="engine-actions">
          <button class="btn" :disabled="probing" @click="restartEngine">
            <Icon name="refresh" :size="13" /> {{ probing ? '检测中…' : '重新检测' }}
          </button>
        </div>
      </div>

      <p v-if="engineSources.length" class="hint">
        当前已注册 {{ engineSources.length }} 个引擎音源：{{ engineSources.map((item) => item.name).join(' · ') }}
      </p>
    </section>

    <!-- 关于（含软件更新） -->
    <section class="card block about">
      <div class="block-head">
        <span class="ico"><Icon name="heart" :size="15" /></span>
        <div>
          <strong>关于</strong>
          <small>Aurora Music · Electron + Vue 3 + TypeScript</small>
        </div>
      </div>

      <div class="author">
        <span class="avatar">练</span>
        <div class="author-info">
          <strong>设计与开发 · 信息科技练老师</strong>
          <p>B 站知识分享 UP 主 · 零基础教学与效率工具教程</p>
        </div>
        <div class="author-actions">
          <button class="btn" @click="openBilibili">
            <Icon name="play_circle" :size="14" /> 去 B 站找我
          </button>
          <button class="btn" @click="router.push('/guide')">
            <Icon name="info" :size="14" /> 使用指南
          </button>
          <button class="btn" :disabled="checkingUpdate" @click="checkUpdate">
            <Icon name="download" :size="14" /> {{ checkingUpdate ? '检查中…' : '检查更新' }}
          </button>
          <button class="btn" :disabled="exportingDiag" @click="exportDiagnostics">
            <Icon name="folder" :size="14" /> {{ exportingDiag ? '导出中…' : '导出诊断' }}
          </button>
          <button v-if="update?.state === 'ready'" class="btn primary" @click="installUpdateNow">
            重启并安装
          </button>
          <button v-if="update?.manualUrl" class="btn primary" @click="openManualDownload">
            <Icon name="download" :size="14" /> 手动下载新版
          </button>
        </div>
      </div>

      <p v-if="update && !update.supported" class="hint update-hint">
        此环境不支持应用内更新，请到 GitHub Releases 下载：github.com/dxhklck/aurora-music/releases
      </p>
      <p v-else-if="updateText" class="hint update-hint" :class="{ error: update?.state === 'error' }">
        {{ updateText }}
      </p>

      <p class="hint">
        本项目仅用于学习与技术研究：只访问各平台公开可访问的端点，不内置账号。
        设置里的 Cookie 由你主动粘贴自己的登录态，等同官方客户端的权限，可随时清除。
        不托管、不分发任何版权内容，请通过官方渠道获取付费/会员内容，并遵守各平台服务条款。
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings {
  padding-bottom: 40px;
  max-width: 860px;
}

.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin: 10px 0 18px;
  gap: 20px;
}
.head h1 {
  margin: 0 0 6px;
  font-size: 28px;
  font-weight: 750;
}
.head p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}
.tag {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--text-3);
  border: 1px solid var(--border);
}

.block {
  padding: 16px 18px;
  margin-bottom: 12px;
}
.block:hover {
  transform: none;
}
.block-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.block-head strong {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
}
.block-head small {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-3);
}
.ico {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
}
.state {
  margin-left: auto;
  font-size: 10.5px;
  padding: 3px 9px;
  border-radius: 999px;
}
.state.ok {
  color: #3ddc97;
  background: rgba(61, 220, 151, 0.12);
  border: 1px solid rgba(61, 220, 151, 0.28);
}
.state.bad {
  color: #ffb3c1;
  background: rgba(255, 92, 124, 0.12);
  border: 1px solid rgba(255, 92, 124, 0.28);
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.row:last-of-type {
  border-bottom: none;
}
.row > label {
  font-size: 12.5px;
  color: var(--text-2);
}

.seg {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.045);
  border: 1px solid var(--border);
}
.seg button {
  min-width: 38px;
  padding: 5px 11px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-3);
  font-size: 11.5px;
  cursor: pointer;
  transition: all 0.18s var(--ease);
}
.seg button:hover {
  color: var(--text);
}
.seg button.on {
  color: #fff;
  background: color-mix(in srgb, var(--accent) 32%, transparent);
  box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 30%, transparent);
}

.switch {
  width: 40px;
  height: 22px;
  padding: 2px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: all 0.2s var(--ease);
}
.switch i {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  transition: transform 0.2s var(--ease), background 0.2s;
}
.switch.on {
  background: color-mix(in srgb, var(--accent) 42%, transparent);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.switch.on i {
  transform: translateX(18px);
  background: #fff;
}

.num {
  width: 72px;
  padding: 6px 9px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
  font-size: 12px;
  text-align: center;
}

.path {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 62%;
  font-size: 11.5px;
  color: var(--text-3);
}
.path span {
  min-width: 0;
}

.account {
  padding: 11px 0;
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.account:last-of-type {
  border-bottom: none;
}
.account-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.account-head strong {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
.cookie {
  width: 100%;
  box-sizing: border-box;
  padding: 9px 11px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text-2);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
  line-height: 1.6;
  resize: vertical;
  word-break: break-all;
}
.cookie:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.cookie::placeholder {
  color: var(--text-3);
  opacity: 0.6;
}
.account-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.account-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* Cookie / 说明折叠区：把桌面式操作收进"高级"，移动端主界面保持干净 */
.adv {
  margin-top: 10px;
}
.adv summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-3);
  padding: 6px 0;
  user-select: none;
}
.adv summary:hover {
  color: var(--text-2);
}
.adv[open] summary {
  color: var(--text-2);
}
.adv .cookie {
  margin-top: 4px;
}

/* 账号卡片：登录态展示（头像 / 昵称 / VIP / 退出） */
.profile-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.035);
}
.avatar {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--panel-strong);
}
.avatar.letter {
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #ec4141, #8b1a1a);
}
.profile-meta {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.profile-meta strong {
  font-size: 13px;
}
.profile-meta small {
  font-size: 11px;
  color: var(--text-3);
}

/* 手机号登录面板 */
.phone-card {
  width: min(92vw, 380px);
}
.phone-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 0 4px;
}
.phone-body .seg.mode button {
  flex: 1;
  height: 36px;
}
.phone-input {
  width: 100%;
  box-sizing: border-box;
  height: 46px;
  padding: 0 14px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(0, 0, 0, 0.25);
  color: var(--text);
  font-size: 15px;
  transition: border-color 0.15s var(--ease);
}
.phone-input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
}
.phone-input::placeholder {
  color: var(--text-3);
  opacity: 0.7;
}
.code-row {
  display: flex;
  gap: 8px;
}
.phone-input.grow {
  flex: 1;
  min-width: 0;
}
.code-row .send {
  flex: none;
  height: 46px;
  padding: 0 14px;
  font-size: 12px;
  white-space: nowrap;
}
.phone-error {
  margin: 0;
  font-size: 12px;
  color: #ff7b81;
}
.phone-body .submit {
  height: 46px;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 600;
}
.phone-body .tiny {
  margin: 2px 0 0;
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.6;
}

/* 移动端触控适配：面板变底部卡片、按钮加大 */
@media (max-width: 640px) {
  .qr-mask {
    align-items: flex-end;
  }
  .phone-card,
  .qr-card {
    width: 100%;
    max-width: none;
    border-radius: 20px 20px 0 0;
    padding-bottom: max(18px, env(safe-area-inset-bottom));
  }
  .account-actions {
    flex-wrap: wrap;
  }
  .account-actions .btn {
    height: 40px;
    padding: 0 14px;
  }
  .profile-card .btn {
    height: 36px;
  }
}

/* 扫码登录弹层 */
.qr-mask {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(4, 4, 8, 0.66);
  backdrop-filter: blur(6px);
}
.qr-card {
  width: 300px;
  padding: 18px;
  border-radius: var(--radius);
  background: var(--bg-soft);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
}
.qr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13.5px;
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--panel-strong);
  color: var(--text);
}
.qr-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 14px 0 4px;
}
.qr-frame {
  position: relative;
  width: 224px;
  height: 224px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  background: #fff;
  overflow: hidden;
}
.qr-frame img {
  width: 220px;
  height: 220px;
  image-rendering: pixelated;
}
.qr-loading {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.qr-expired {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.92);
}
.qr-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 18px;
  margin: 0;
  font-size: 12.5px;
  color: var(--text-2);
}
.qr-status small {
  color: var(--text-3);
}
.qr-status .ok {
  color: #4ade80;
}
.qr-tip {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
  line-height: 1.7;
}
.qr-foot {
  display: flex;
  justify-content: center;
  padding-top: 8px;
}
.tip {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.8;
}
.tip ol {
  margin: 0;
  padding-left: 18px;
}
.tip code,
.tip kbd {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10.5px;
}

.engine {
  margin-top: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
}
.kv {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  padding: 4px 0;
  font-size: 11.5px;
}
.kv span {
  color: var(--text-3);
  flex-shrink: 0;
}
.kv em {
  font-style: normal;
  color: var(--text-2);
  min-width: 0;
  text-align: right;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px;
}
.err {
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 9px;
  font-size: 11px;
  color: #ffc2cc;
  background: rgba(255, 92, 124, 0.1);
  border: 1px solid rgba(255, 92, 124, 0.22);
  word-break: break-all;
}
.engine-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
/* 上游巡检：每个源一个色点，红=请求失败、黄=能通但搜不到、灰=没巡检过 */
.health-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.src {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  color: var(--text-3);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--border);
  cursor: default;
}
.src i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-3);
}
.src.ok i {
  background: #4ad295;
}
.src.empty i {
  background: #f0b732;
}
.src.fail {
  color: #ffc2cc;
  border-color: rgba(255, 92, 124, 0.3);
}
.src.fail i {
  background: #ff5c7c;
}
.btn.ghost {
  background: transparent;
}
.log {
  margin: 10px 0 0;
  padding: 10px;
  max-height: 180px;
  overflow: auto;
  border-radius: 9px;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border);
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-3);
  white-space: pre-wrap;
  word-break: break-all;
}
.install {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
  font-size: 11.5px;
  color: var(--text-2);
}
.install strong {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
}
.install p {
  margin: 6px 0;
  color: var(--text-3);
}
.install code {
  padding: 1px 5px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 10.5px;
}
.install .cmd {
  display: inline-block;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--accent);
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border);
}
.tiny {
  font-size: 10.5px !important;
  line-height: 1.6;
}

.hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-3);
}

.hint.error {
  color: #ff7a7a;
}
.about .hint {
  margin-top: 8px;
}
.about .update-hint {
  margin-top: 10px;
}

/* 设计者署名 */
.author {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.avatar {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 50%;
  font-size: 17px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #fb7299, #e11d74);
  box-shadow: 0 4px 14px rgba(251, 114, 153, 0.35);
}
.author-info {
  flex: 1;
  min-width: 0;
}
.author-info strong {
  display: block;
  font-size: 13px;
  font-weight: 600;
}
.author-info p {
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--text-3);
}
.author .btn {
  flex: none;
  white-space: nowrap;
}
.author-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
/* 窄屏：按钮组换行，避免挤压作者信息 */
@media (max-width: 720px) {
  .author {
    flex-wrap: wrap;
  }
  .author-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
