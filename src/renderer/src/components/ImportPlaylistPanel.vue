<script setup lang="ts">
/**
 * 统一账号歌单导入：网易云 / QQ 共用一个面板。
 *
 * 只做「拉取」不做「回写」；同一平台 + 远端 id 由主进程原地更新。
 * 不解析分享链接，也不触发任何下载——导入结果只是本地歌单。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import CoverArt from './CoverArt.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import { friendlyError } from '../core/error'
import type { RemotePlaylistPlatform } from '@shared/api'
import type { RemoteSyncPlan } from '@shared/types'
import type { RemotePlaylistSummary } from '@shared/types'

const visible = defineModel<boolean>('visible', { default: false })

const app = useAppStore()
const playlists = usePlaylistStore()

const platform = ref<RemotePlaylistPlatform>('netease')
const loading = ref(false)
const error = ref('')
const lists = ref<RemotePlaylistSummary[]>([])
const busyId = ref('')
const pendingPlan = ref<{ item: RemotePlaylistSummary; songs: RemoteSyncPlan['added'] } | null>(null)

const platformName = computed(() => (platform.value === 'qq' ? 'QQ 音乐' : '网易云音乐'))
const loggedIn = computed(() =>
  platform.value === 'qq'
    ? Boolean(app.settings?.qqCookie)
    : Boolean(app.settings?.neteaseCookie)
)

function synced(remoteId: string): boolean {
  return playlists.items.some((item) =>
    platform.value === 'qq' ? item.qqId === remoteId : item.neteaseId === remoteId
  )
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  lists.value = []
  try {
    lists.value = await window.api.remotePlaylists(platform.value)
  } catch (err) {
    error.value = friendlyError(err)
  } finally {
    loading.value = false
  }
}

function switchPlatform(value: RemotePlaylistPlatform): void {
  if (platform.value === value) return
  platform.value = value
  error.value = ''
  lists.value = []
  if (visible.value && loggedIn.value) void load()
}

async function sync(item: RemotePlaylistSummary, deleteRemoteMissing = false): Promise<void> {
  if (busyId.value) return
  busyId.value = item.id
  try {
    const detail = await window.api.remotePlaylistDetail(platform.value, item.id)
    if (!detail.songs.length) {
      app.toast(`《${item.name}》没有可导入的歌曲`, 'info')
      return
    }
    const existed = synced(item.id)
    if (!deleteRemoteMissing) {
      const plan = await playlists.planRemoteSync(platform.value, detail.name, item.id, detail.songs)
      if (plan.missingCount) {
        pendingPlan.value = { item, songs: detail.songs }
        return
      }
    }
    const result = await playlists.applyRemoteSync(
      platform.value,
      detail.name,
      item.id,
      detail.songs,
      deleteRemoteMissing
    )
    const parts = [
      `已${existed ? '更新' : '导入'}《${result.playlist.name.replace(/^[^·]+·\s*/, '')}》`,
      `新增 ${result.added.length} 首`
    ]
    if (result.removed.length) parts.push(`移除 ${result.removed.length} 首`)
    app.toast(parts.join(' · '), 'success')
  } catch (err) {
    app.toast(friendlyError(err), 'error')
  } finally {
    busyId.value = ''
  }
}

async function confirmDeleteMissing(): Promise<void> {
  const pending = pendingPlan.value
  if (!pending) return
  pendingPlan.value = null
  await sync(pending.item, true)
}

function login(): void {
  if (platform.value === 'qq') {
    void window.api.openLoginWindow('qq')
    app.toast('已打开 QQ 音乐登录窗口，登录成功后会自动读取歌单', 'info')
  } else {
    app.toast('请到 设置 → 账号登录 → 网易云音乐 用手机号登录，成功后会自动读取歌单', 'info')
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) visible.value = false
}

watch(visible, (value) => {
  if (!value) return
  if (loggedIn.value) void load()
  else {
    lists.value = []
    error.value = ''
  }
})

watch(loggedIn, (value) => {
  if (value && visible.value) void load()
})

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="visible" class="backdrop" @click.self="visible = false">
        <div class="panel">
          <header>
            <div class="head-text">
              <strong>导入会员歌单</strong>
              <small>把账号里的歌单拉到本地；只读取，不会修改云端歌单</small>
            </div>
            <button class="close" title="关闭" @click="visible = false">
              <Icon name="close" :size="15" />
            </button>
          </header>

          <div class="tabs" role="tablist">
            <button
              class="chip"
              :class="{ on: platform === 'netease' }"
              role="tab"
              :aria-selected="platform === 'netease'"
              @click="switchPlatform('netease')"
            >
              网易云音乐
            </button>
            <button
              class="chip"
              :class="{ on: platform === 'qq' }"
              role="tab"
              :aria-selected="platform === 'qq'"
              @click="switchPlatform('qq')"
            >
              QQ 音乐
            </button>
          </div>

          <div v-if="!loggedIn" class="state">
            <p>还没有登录{{ platformName }}账号。</p>
            <button class="btn primary" @click="login">去登录</button>
            <small v-if="platform === 'netease'">网易云请用手机号登录；QQ 支持应用内登录</small>
          </div>

          <template v-else>
            <div v-if="loading" class="state">正在读取歌单…</div>
            <div v-else-if="error" class="state error">
              <span>{{ error }}</span>
              <button class="btn" @click="load">重试</button>
            </div>
            <div v-else-if="!lists.length" class="state">账号下没有读到歌单</div>
            <div v-else class="list">
              <div v-for="item in lists" :key="item.id" class="item">
                <CoverArt :src="item.coverUrl" :seed="item.id" :size="38" :radius="9" />
                <div class="meta">
                  <strong class="truncate">
                    {{ item.name }}
                    <em v-if="synced(item.id)" class="tag">已同步</em>
                  </strong>
                  <small class="truncate">
                    {{ item.trackCount }} 首<template v-if="item.creator"> · {{ item.creator }}</template>
                  </small>
                </div>
                <button class="btn" :disabled="!!busyId" @click="sync(item)">
                  {{ busyId === item.id ? '同步中…' : synced(item.id) ? '更新' : '导入' }}
                </button>
              </div>
            </div>

            <p class="tip">
              会员歌曲导入后只是本地歌单，播放时仍需要对应平台登录态；登录过期可能自动换源或无法播放。
            </p>
          </template>
        </div>
      </div>
    </transition>

    <ConfirmDialog
      v-if="pendingPlan"
      title="远端歌单有删减"
      confirm-text="移除这些歌曲"
      cancel-text="保留本地歌曲"
      danger
      @confirm="confirmDeleteMissing"
      @cancel="pendingPlan = null"
    >
      <p>《{{ pendingPlan.item.name }}》在远端少了歌曲，默认会从本地歌单中保留这些歌。</p>
      <p v-if="pendingPlan.songs.length">确认后只从当前导入的歌单里移除，不会影响收藏夹和其他歌单。</p>
    </ConfirmDialog>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 135;
  display: grid;
  place-items: center;
  /* 遮罩随主题翻转：深色压暗、浅色提亮，避免浅色主题下弹出一块黑玻璃 */
  background: rgba(4, 4, 8, 0.62);
  backdrop-filter: blur(6px);
}
html[data-theme='light'] .backdrop {
  background: rgba(28, 31, 42, 0.22);
}

.panel {
  width: 420px;
  max-width: calc(100vw - 36px);
  max-height: min(78vh, 640px);
  border-radius: 18px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* 用近实心浮层色而非 glass：半透明玻璃叠在后面的列表上两种主题都会糊 */
  background: var(--overlay-bg);
  border: 1px solid var(--overlay-border);
  backdrop-filter: blur(26px) saturate(1.5);
  box-shadow: var(--shadow);
}

header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}
.head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.head-text strong {
  font-size: 15px;
  font-weight: 650;
}
.head-text small {
  font-size: 11.5px;
  color: var(--text-3);
}
.close {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-3);
}
.close:hover {
  background: var(--panel);
  color: var(--text);
}

.tabs {
  display: flex;
  gap: 8px;
}
.chip {
  flex: 1;
  height: 32px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text-2);
  font-size: 12px;
}
.chip.on {
  color: var(--text);
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 24px 8px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}
.state.error {
  color: var(--danger);
}
.state p {
  margin: 0;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}
.item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 6px;
  border-radius: 10px;
}
.item:hover {
  background: var(--panel);
}
.meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.meta strong {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
}
.meta small {
  font-size: 10.5px;
  color: var(--text-3);
}
.tag {
  flex: none;
  font-style: normal;
  font-size: 9px;
  padding: 1.5px 5px;
  border-radius: 4px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.item .btn {
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-size: 11.5px;
}
.tip {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-3);
}
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
