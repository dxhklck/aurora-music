<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useAppStore } from '../stores/app'
import { usePlaylistStore } from '../stores/playlists'
import type { CloudAccountInfo, CloudPlaylistInfo } from '@shared/types'

/**
 * 云端歌单导入：从网易云 / QQ 音乐账号拉取歌单列表，勾选后整单导入为本地歌单。
 *
 * 登录态来自设置里配置的 Cookie（网易云扫码 / QQ 扫码或粘贴 Cookie），
 * 未登录的平台在页内给出明确引导，而不是空列表让用户困惑。
 */
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; m3u: [] }>()

const app = useAppStore()
const playlists = usePlaylistStore()
const router = useRouter()

type Platform = 'netease' | 'qq'
const PLATFORM_LABEL: Record<Platform, string> = { netease: '网易云', qq: 'QQ 音乐' }

const tab = ref<Platform>('netease')
const accounts = ref<Partial<Record<Platform, CloudAccountInfo | null>>>({})
const accountsLoading = ref(false)
const lists = ref<Partial<Record<Platform, CloudPlaylistInfo[]>>>({})
const listsLoading = ref(false)
const selected = ref<Set<string>>(new Set())
const importing = ref(false)
const progress = ref('')

const account = computed(() => accounts.value[tab.value] ?? null)
const list = computed(() => lists.value[tab.value] ?? [])
const selectedInfos = computed(() => list.value.filter((item) => selected.value.has(item.id)))

async function loadAccounts(): Promise<void> {
  accountsLoading.value = true
  try {
    const [netease, qq] = await Promise.all([
      window.api.cloudAccount('netease'),
      window.api.cloudAccount('qq')
    ])
    accounts.value = { netease, qq }
    // 默认停在第一个已登录的平台；都没登录停在网易云给出引导
    tab.value = netease ? 'netease' : qq ? 'qq' : 'netease'
  } finally {
    accountsLoading.value = false
  }
}

async function loadPlaylists(): Promise<void> {
  if (!account.value) {
    lists.value[tab.value] = []
    return
  }
  listsLoading.value = true
  selected.value = new Set()
  try {
    lists.value[tab.value] = await window.api.cloudPlaylists(tab.value)
  } catch (error) {
    app.toast(
      `拉取歌单列表失败：${error instanceof Error ? error.message : String(error)}`,
      'error'
    )
    lists.value[tab.value] = []
  } finally {
    listsLoading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void loadAccounts()
  }
)
watch(tab, () => void loadPlaylists())

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAll(): void {
  const all = list.value.length > 0 && selected.value.size === list.value.length
  selected.value = all ? new Set() : new Set(list.value.map((item) => item.id))
}

function close(): void {
  emit('close')
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) close()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

async function importSelected(): Promise<void> {
  const targets = selectedInfos.value
  if (!targets.length || importing.value) return
  importing.value = true
  let firstCreatedId: string | null = null
  let okCount = 0
  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      progress.value = `正在拉取《${target.name}》(${i + 1}/${targets.length})`
      const songs = await window.api.cloudPlaylistSongs(tab.value, target.id).catch((error) => {
        app.toast(
          `《${target.name}》曲目拉取失败：${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
        return null
      })
      if (!songs?.length) {
        app.toast(`《${target.name}》没有拉到曲目，已跳过`, 'error')
        continue
      }
      try {
        const created = await playlists.create(target.name, songs)
        if (created) {
          okCount++
          firstCreatedId ??= created.id
        }
      } catch (error) {
        app.toast(
          `《${target.name}》创建失败：${error instanceof Error ? error.message : String(error)}`,
          'error'
        )
      }
    }
    if (okCount) {
      app.toast(
        okCount === targets.length
          ? `已导入 ${okCount} 个歌单`
          : `已导入 ${okCount} 个歌单，${targets.length - okCount} 个失败`,
        okCount === targets.length ? 'success' : 'info'
      )
      close()
      if (firstCreatedId) void router.push(`/playlist/${firstCreatedId}`)
    }
  } finally {
    importing.value = false
    progress.value = ''
  }
}
</script>

<template>
  <transition name="fade">
    <div v-if="open" class="cloud-mask" @click.self="close">
      <div class="cloud-dialog glass">
        <header class="head">
          <div class="title">
            <Icon name="export" :size="17" />
            <strong>导入云端歌单</strong>
          </div>
          <button class="close" title="关闭" @click="close">
            <Icon name="close" :size="14" />
          </button>
        </header>

        <div class="tabs">
          <button
            v-for="p in (['netease', 'qq'] as const)"
            :key="p"
            class="tab"
            :class="{ active: tab === p, logged: !!accounts[p] }"
            :disabled="accountsLoading"
            @click="tab = p"
          >
            {{ PLATFORM_LABEL[p] }}
            <small v-if="accountsLoading">…</small>
            <small v-else-if="accounts[p]">{{ accounts[p]!.name }}</small>
            <small v-else class="none">未登录</small>
          </button>
        </div>

        <div class="body">
          <div v-if="accountsLoading || listsLoading" class="state">
            <span class="ring" /> 正在读取账号歌单…
          </div>

          <div v-else-if="!account" class="state">
            <p>{{ PLATFORM_LABEL[tab] }}还没有登录</p>
            <button class="btn primary" @click="router.push('/settings'); close()">
              去设置登录
            </button>
          </div>

          <div v-else-if="!list.length" class="state">
            <p>账号下没有拉到歌单（或接口返回为空）</p>
          </div>

          <div v-else class="plist">
            <button class="row head-row" @click="toggleAll">
              <span class="check all" :class="{ on: selected.size === list.length }">
                <Icon v-if="selected.size === list.length" name="check" :size="12" />
              </span>
              <span class="pl-name">全选（{{ list.length }} 个歌单）</span>
            </button>
            <button
              v-for="item in list"
              :key="item.id"
              class="row"
              :class="{ on: selected.has(item.id) }"
              @click="toggle(item.id)"
            >
              <span class="check" :class="{ on: selected.has(item.id) }">
                <Icon v-if="selected.has(item.id)" name="check" :size="12" />
              </span>
              <img v-if="item.coverUrl" class="pl-cover" :src="item.coverUrl" alt="" />
              <Icon v-else name="list" :size="16" />
              <span class="pl-name truncate">{{ item.name }}</span>
              <em class="pl-count">{{ item.count }} 首</em>
              <small v-if="!item.mine" class="pl-tag">收藏</small>
            </button>
          </div>
        </div>

        <footer class="foot">
          <button class="btn ghost" @click="emit('m3u'); close()">从 M3U 文件导入</button>
          <span class="foot-hint">
            {{ selected.size ? `已选 ${selected.size} 个歌单` : '' }}
            {{ progress }}
          </span>
          <button
            class="btn primary"
            :disabled="!selected.size || importing"
            @click="importSelected"
          >
            <span v-if="importing" class="ring" />
            {{ importing ? '导入中…' : '导入所选' }}
          </button>
        </footer>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.cloud-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(0, 0, 0, 0.45);
  display: grid;
  place-items: center;
}

.cloud-dialog {
  width: min(460px, 92vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  padding: 14px;
  gap: 10px;
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.close {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: var(--text-2);
}
.close:hover {
  color: var(--text);
  background: var(--row-hover);
}

.tabs {
  display: flex;
  gap: 8px;
}
.tab {
  flex: 1;
  padding: 8px 10px;
  border-radius: 10px;
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 6px;
  color: var(--text-2);
  border: 1px solid transparent;
}
.tab.active {
  color: var(--text);
  background: var(--row-active);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.tab small {
  font-size: 10px;
  opacity: 0.75;
}
.tab small.none {
  color: var(--text-3);
}

.body {
  flex: 1;
  min-height: 180px;
  max-height: 46vh;
  overflow-y: auto;
  border-radius: 10px;
}
.state {
  height: 100%;
  min-height: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-2);
  font-size: 12px;
}

.plist {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border-radius: 8px;
  text-align: left;
  color: var(--text-2);
}
.row:hover {
  background: var(--row-hover);
  color: var(--text);
}
.row.on {
  background: var(--row-active);
  color: var(--text);
}
.head-row {
  font-size: 11px;
  color: var(--text-3);
}
.check {
  width: 16px;
  height: 16px;
  flex: none;
  border-radius: 5px;
  border: 1px solid var(--overlay-border);
  display: grid;
  place-items: center;
  color: #fff;
}
.check.on {
  background: var(--accent);
  border-color: var(--accent);
}
.pl-cover {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  object-fit: cover;
  flex: none;
}
.pl-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
}
.pl-count {
  font-size: 10px;
  font-style: normal;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.pl-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--row-hover);
  color: var(--text-3);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.foot-hint {
  flex: 1;
  text-align: right;
  font-size: 10px;
  color: var(--text-3);
}
.btn.ghost {
  color: var(--text-2);
}

.ring {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  animation: spin 0.85s linear infinite;
  display: inline-block;
  margin-right: 6px;
}
.state .ring {
  border-color: var(--overlay-border);
  border-top-color: var(--accent);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
