<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { useAppStore } from '../stores/app'
import { useDownloadStore } from '../stores/download'
import { useLibraryStore } from '../stores/library'
import { formatBytes } from '@shared/lyric'
import type { EngineStatusView } from '@shared/api'
import type { QrLoginPlatform, QrLoginState } from '@shared/types'
import type { Quality } from '@shared/types'

const app = useAppStore()
const download = useDownloadStore()
const library = useLibraryStore()

const engine = ref<EngineStatusView | null>(null)
const probing = ref(false)
const showLog = ref(false)
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
    if (engine.value?.ready) app.toast('引擎已就绪', 'success')
    else app.toast(engine.value?.error || '引擎未就绪', 'error')
  } finally {
    probing.value = false
  }
}

async function choosePython(): Promise<void> {
  probing.value = true
  try {
    engine.value = await window.api.engineChoosePython()
    if (engine.value?.ready) app.toast('引擎已就绪', 'success')
    else app.toast(engine.value?.error || '这个解释器不可用', 'error')
  } finally {
    probing.value = false
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
  await patch(platform === 'qq' ? { qqCookie: '' } : { neteaseCookie: '' })
  app.toast('已退出登录态', 'info')
}

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
  await window.api.openLoginWindow(platform)
  app.toast('已打开登录窗口，在里面像平时一样登录即可', 'info')
}

/** 设计者 B 站主页直达：window.open 会被主进程转交系统浏览器（setWindowOpenHandler） */
function openBilibili(): void {
  window.open('https://space.bilibili.com/477558144')
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
      <span class="tag">v{{ '1.0.0' }}</span>
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
            {{ settings?.qqCookie ? '已配置' : '未配置' }}
          </span>
        </div>
        <textarea
          v-model="qqDraft"
          class="cookie"
          rows="3"
          spellcheck="false"
          placeholder="整段 Cookie，例如：uin=o0123456789; qm_keyst=…; qqmusic_key=…"
        ></textarea>
        <div class="account-actions">
          <button class="btn" @click="openQrLogin('qq')">
            <Icon name="qrcode" :size="14" /> 扫码登录
          </button>
          <button class="btn" @click="openBrowserLogin('qq')">
            <Icon name="monitor" :size="14" /> 浏览器登录
          </button>
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
      </div>

      <div class="account">
        <div class="account-head">
          <strong>网易云音乐</strong>
          <span class="state" :class="settings?.neteaseCookie ? 'ok' : 'bad'">
            {{ settings?.neteaseCookie ? '已配置' : '未配置' }}
          </span>
        </div>
        <textarea
          v-model="neteaseDraft"
          class="cookie"
          rows="3"
          spellcheck="false"
          placeholder="整段 Cookie，例如：MUSIC_U=…; __remember_me=true"
        ></textarea>
        <div class="account-actions">
          <button class="btn" @click="openQrLogin('netease')">
            <Icon name="qrcode" :size="14" /> 扫码登录
          </button>
          <button class="btn" @click="openBrowserLogin('netease')">
            <Icon name="monitor" :size="14" /> 浏览器登录
          </button>
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
      </div>

      <p class="hint">
        不内置任何账号。扫码登录与粘贴 Cookie 等价——都是把你自己账号的登录态交给本机使用，
        仅用于以你自己的权限访问各平台公开接口，随时可以清除。
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

    <!-- 引擎 -->
    <section class="card block">
      <div class="block-head">
        <span class="ico"><Icon name="search" :size="15" /></span>
        <div>
          <strong>musicdl 引擎</strong>
          <small>通过独立 Python 进程复用 musicdl 的 15 个音源、直链解析与标签写入</small>
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
          <span>解释器</span>
          <em class="mono truncate">{{ engine.runtime?.command ?? '—' }}</em>
        </div>
        <div class="kv">
          <span>musicdl</span>
          <em>{{ engine.runtime?.version || '—' }} · {{ engine.runtime?.sources ?? 0 }} 个音源</em>
        </div>
        <div class="kv">
          <span>源码 / 脚本</span>
          <em>{{ engine.musicdlFound ? '已找到' : '缺失' }} / {{ engine.bridgeFound ? '已找到' : '缺失' }}</em>
        </div>
        <div v-if="engine.error" class="err">{{ engine.error }}</div>

        <div class="engine-actions">
          <button class="btn" :disabled="probing" @click="restartEngine">
            <Icon name="refresh" :size="13" /> {{ probing ? '检测中…' : '重新检测' }}
          </button>
          <button class="btn" :disabled="probing" @click="choosePython">
            <Icon name="folder" :size="13" /> 指定解释器
          </button>
          <button v-if="engine.log.length" class="btn ghost" @click="showLog = !showLog">
            {{ showLog ? '隐藏日志' : '查看日志' }}
          </button>
        </div>

        <pre v-if="showLog" class="log">{{ engine.log.join('\n') }}</pre>

        <div v-if="!engine.ready" class="install">
          <template v-if="engine.packaged">
            <strong>这个安装包需要本机有 Python 才能用引擎音源</strong>
            <p>
              装好 Python 3.10+ 后点上面的「指定解释器」选中它即可；解释器里还需要
              <code>musicdl</code> 的依赖（<code>pip install musicdl</code>）。
            </p>
            <p class="tiny">
              也可以把便携版运行时放到安装目录的 <code>resources/python</code>，
              或用环境变量 <code>AURORA_PYTHON</code> 指定，都会自动被识别。
            </p>
          </template>
          <template v-else>
            <strong>首次使用需要准备引擎环境</strong>
            <p>在项目根目录执行一次即可（会创建 <code>engine/.venv</code> 并安装依赖）：</p>
            <code class="cmd">npm run engine:setup</code>
            <p class="tiny">
              也可用环境变量 <code>AURORA_PYTHON</code> 指定解释器、<code>AURORA_MUSICDL_PATH</code> 指定 musicdl 源码目录，
              或在上面点「指定解释器」。
            </p>
          </template>
        </div>
      </div>

      <p v-if="engineSources.length" class="hint">
        当前已注册 {{ engineSources.length }} 个引擎音源：{{ engineSources.map((item) => item.name).join(' · ') }}
      </p>
    </section>

    <!-- 关于 -->
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
        <button class="btn" @click="openBilibili">
          <Icon name="play_circle" :size="14" /> 去 B 站找我
        </button>
      </div>

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

/* 扫码登录弹层 */
.qr-mask {
  position: fixed;
  inset: 0;
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
  inset: 0;
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
.about .hint {
  margin-top: 8px;
}

/* 设计者署名 */
.author {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.03);
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
}
</style>
