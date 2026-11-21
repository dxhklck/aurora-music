# 桌面版导入网易云 / QQ 账号歌单 Implementation Plan

> **For implementer:** Use TDD throughout. Write failing test first. Watch it fail. Then implement.

**Goal:** 在桌面版加入“导入账号歌单”核心闭环：从网易云 / QQ 账号读取歌单并同步为本地歌单，支持首次新建与再次更新。

**Architecture:** 主进程 provider 负责平台接口请求与歌曲映射；shared API / IPC / preload 提供安全桥接；主进程歌单服务负责新建或原地更新；渲染层提供侧栏入口和统一导入面板。

**Tech Stack:** Electron、Vue 3、Pinia、TypeScript、Node test runner、ESLint、vue-tsc。

---

## Task 1: 共享类型与契约

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/api.ts`
- Test: `tests/remote-playlist-contract.test.ts`

**Step 1: Write the failing test**

在 `tests/remote-playlist-contract.test.ts` 新增用例：

- `Playlist 持久化远端 id 与摘要类型`
- 断言源码中 `Playlist` 含 `neteaseId?: string`、`qqId?: string`
- 断言存在 `RemotePlaylistSummary`、`RemotePlaylistPlatform`

**Step 2: Run test — confirm it fails**

Command: `node --experimental-strip-types --test tests/remote-playlist-contract.test.ts`

Expected: FAIL，提示缺少字段 / 类型。

**Step 3: Write minimal implementation**

- `src/shared/types.ts`：`Playlist` 增加可选 `neteaseId?: string`、`qqId?: string`。
- 新增 `RemotePlaylistSummary { id, name, trackCount, coverUrl?, creator? }`。
- `src/shared/api.ts`：定义 `RemotePlaylistPlatform = 'netease' | 'qq'`。

**Step 4: Run test — confirm it passes**

Command: 同上。Expected: PASS。

**Step 5: Commit**

`git add src/shared/types.ts src/shared/api.ts tests/remote-playlist-contract.test.ts && git commit -m "feat(playlist): add remote playlist types"`

---

## Task 2: QQ g_tk 与 Provider 账号歌单方法

**Files:**
- Modify: `src/main/providers/cookies.ts`
- Modify: `src/main/providers/netease.ts`
- Modify: `src/main/providers/qq.ts`
- Modify: `src/main/providers/types.ts`
- Test: `tests/qq-playlist.test.ts`
- Test: `tests/remote-playlist-contract.test.ts`

**Step 1: Write the failing test**

- `tests/qq-playlist.test.ts`：新增 `qqGtk 匿名返回 5381`、`p_skey 参与哈希且稳定`、`skey/qm_keyst 回退`。
- `tests/remote-playlist-contract.test.ts`：新增 `netease provider 暴露账号歌单列表详情`、`qq provider 使用账号歌单接口与 g_tk`。

**Step 2: Run test — confirm it fails**

Command: `node --experimental-strip-types --test tests/qq-playlist.test.ts tests/remote-playlist-contract.test.ts`

Expected: FAIL，缺少 `qqGtk` 或 provider 方法。

**Step 3: Write minimal implementation**

- `src/main/providers/cookies.ts`：移植 `qqGtk(cookie = qqCookie())`。
- `src/main/providers/netease.ts`：新增 `accountUid()`、`userPlaylists()`、`userPlaylistDetail(id)`；复用 `mapSong()`。
- `src/main/providers/qq.ts`：新增同名方法；使用 `fcg_user_created_diss` / `fcg_ucc_getcdinfo_byids_cp` 与 `g_tk`；复用 `mapTrack()`。
- `src/main/providers/types.ts`：`MusicProvider` 增加可选账号歌单方法。

**Step 4: Run test — confirm it passes**

Command: 同上。Expected: PASS。

**Step 5: Commit**

`git add src/main/providers/cookies.ts src/main/providers/netease.ts src/main/providers/qq.ts src/main/providers/types.ts tests/qq-playlist.test.ts tests/remote-playlist-contract.test.ts && git commit -m "feat(provider): add account playlist APIs"`

---

## Task 3: 主进程歌单同步纯函数与服务

**Files:**
- Create: `src/main/services/remote-sync.ts`
- Modify: `src/main/services/playlists.ts`
- Test: `tests/remote-sync.test.ts`

**Step 1: Write the failing test**

`tests/remote-sync.test.ts` 新增：

- `首次同步新建带平台 id 的歌单`
- `重复同步同平台 remoteId 原地更新`
- `QQ 与网易相同 remoteId 不串单`
- `同步曲目按 platform:id 去重`

**Step 2: Run test — confirm it fails**

Command: `node --experimental-strip-types --test tests/remote-sync.test.ts`

Expected: FAIL，缺少 `syncRemotePlaylistInList`。

**Step 3: Write minimal implementation**

- 新增 `src/main/services/remote-sync.ts`，导出纯函数 `syncRemotePlaylistInList(list, payload, now?)`。
- 新建歌单 id：`ne-{remoteId}` / `qq-{remoteId}`；名称：`网易云 · {name}` / `QQ 音乐 · {name}`。
- `src/main/services/playlists.ts` 新增 `syncRemote(payload)`：调用纯函数、persist、返回最新列表。

**Step 4: Run test — confirm it passes**

Command: 同上。Expected: PASS。

**Step 5: Commit**

`git add src/main/services/remote-sync.ts src/main/services/playlists.ts tests/remote-sync.test.ts && git commit -m "feat(playlist): sync remote playlist into local list"`

---

## Task 4: shared API / IPC / preload / main handlers

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/services/catalog.ts`
- Modify: `src/main/ipc.ts`
- Test: `tests/remote-playlist-contract.test.ts`
- Test: `tests/ipc-contract.test.ts`

**Step 1: Write the failing test**

新增用例：

- `IPC 三通道唯一且四处对齐`
- `AuroraApi 声明 remotePlaylists/remotePlaylistDetail/syncRemotePlaylist`
- `preload 以 IPC 常量 invoke`
- `main 注册对应 handler`

**Step 2: Run test — confirm it fails**

Command: `node --experimental-strip-types --test tests/remote-playlist-contract.test.ts tests/ipc-contract.test.ts`

Expected: FAIL，缺少通道或 API。

**Step 3: Write minimal implementation**

- `src/shared/ipc.ts`：`remotePlaylists: 'playlist:remote-list'`、`remotePlaylistDetail: 'playlist:remote-detail'`、`syncRemotePlaylist: 'playlist:sync-remote'`。
- `src/shared/api.ts`：新增三方法声明；同步入参 `{ platform, name, remoteId, songs }`，返回 `Promise<Playlist[]>`。
- `src/preload/index.ts`：新增 wrapper，详情传 `{ platform, id }`。
- `src/main/services/catalog.ts`：新增 `remotePlaylists()` / `remotePlaylistDetail()`，按平台取 provider 并归一化歌曲。
- `src/main/ipc.ts`：注册三 handler；同步调用 `playlists.syncRemote()`。

**Step 4: Run test — confirm it passes**

Command: 同上。Expected: PASS。

**Step 5: Commit**

`git add src/shared/ipc.ts src/shared/api.ts src/preload/index.ts src/main/services/catalog.ts src/main/ipc.ts tests/remote-playlist-contract.test.ts tests/ipc-contract.test.ts && git commit -m "feat(ipc): expose remote playlist APIs"`

---

## Task 5: Renderer Store、面板与侧栏入口

**Files:**
- Modify: `src/renderer/src/stores/playlists.ts`
- Create: `src/renderer/src/components/ImportPlaylistPanel.vue`
- Modify: `src/renderer/src/components/SideBar.vue`
- Test: `tests/remote-playlist-ui.test.ts`

**Step 1: Write the failing test**

`tests/remote-playlist-ui.test.ts` 新增：

- `store syncRemote 调用 shared API 并按 idField 返回`
- `面板含平台切换/登录引导/VIP 提示/无分享链接输入/无下载调用`
- `SideBar 标题栏并列导入与新建`

**Step 2: Run test — confirm it fails**

Command: `node --experimental-strip-types --test tests/remote-playlist-ui.test.ts`

Expected: FAIL，缺少 store 方法 / UI 文案 / 入口。

**Step 3: Write minimal implementation**

- `src/renderer/src/stores/playlists.ts`：新增 `syncRemote(platform, name, remoteId, songs)`，调用 `window.api.syncRemotePlaylist`，替换 `items`，按 `qqId/neteaseId` 找返回项。
- 新增 `src/renderer/src/components/ImportPlaylistPanel.vue`：移植移动版状态机、`friendlyError`、平台 tab、登录检查、列表/同步中/空态、已同步标记；VIP 文案明确“会员歌曲播放仍需对应平台登录态”。
- `src/renderer/src/components/SideBar.vue`：把“我的歌单”改成标题行，并列放入“新建歌单”和“导入账号歌单”按钮。

**Step 4: Run test — confirm it passes**

Command: 同上。Expected: PASS。

**Step 5: Commit**

`git add src/renderer/src/stores/playlists.ts src/renderer/src/components/ImportPlaylistPanel.vue src/renderer/src/components/SideBar.vue tests/remote-playlist-ui.test.ts && git commit -m "feat(ui): add remote playlist import panel"`

---

## Task 6: 全量验证与手工验收

**Step 1: Run full checks**

Commands:

```bash
npm run test:unit
npm run typecheck
npm run lint
npm run build
```

Expected: 全部通过。

**Step 2: Manual verification**

启动 `npm run dev`，逐项确认：

1. 网易未登录 / Cookie 失效时有明确提示。
2. QQ 未登录时能跳到设置登录，登录后能拉列表。
3. 首次导入创建新歌单，歌单名带平台前缀。
4. 再次导入同一远端歌单原地更新，不产生重复歌单。
5. VIP 提示可见；空歌单提示可见。
6. 不出现 QQ 分享链接输入框，不触发自动下载。

**Step 3: Final commit if manual fixes were needed**

仅在手工验证发现问题并修复后提交：`git commit -m "fix(playlist): address remote import manual QA issues"`
