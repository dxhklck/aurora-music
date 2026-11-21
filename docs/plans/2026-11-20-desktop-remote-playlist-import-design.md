# 桌面版导入网易云 / QQ 账号歌单设计

> 目标：在 Aurora Desktop 中新增“导入账号歌单”能力，让用户把网易云音乐 / QQ 音乐账号里的歌单同步为本地歌单。

## Context

移动版已有统一入口「我的 → 我的歌单 → 导入歌单」，支持网易云 / QQ 账号歌单列表、详情拉取与本地歌单同步。桌面版目前只能登录网易云 / QQ 账号，并在设置页保存 Cookie；歌单页只有 M3U 导入导出，没有账号歌单导入入口，也没有对应的 IPC / API。用户明确要求桌面版也具备该功能。

已确认决策：

- 入口放在桌面侧栏 `我的歌单` 标题栏，与「新建歌单」并列。
- 范围为“核心闭环”：平台切换、登录态提示、歌单列表、歌单详情、首次导入 / 再次更新、错误与 VIP 提示。
- 不做 QQ 分享链接粘贴解析，不自动下载歌曲。
- 方案采用主进程 Provider + IPC + shared API 全链路，保持 Electron 安全边界。

## Architecture

- 主进程 provider 扩展网易云 / QQ 账号歌单列表与详情请求能力，读取现有 Cookie 仓库。
- shared 层新增 `RemotePlaylistPlatform`、`RemotePlaylistSummary` 等类型，新增三条 IPC/API：`remotePlaylists`、`remotePlaylistDetail`、`syncRemotePlaylist`。
- 主进程歌单服务新增同步逻辑：同一平台 + 远端歌单 id 原地更新，未同步过则新建歌单。
- 渲染层新增 `ImportPlaylistPanel.vue`，由 `SideBar.vue` 的“我的歌单”标题栏打开。

## Components and Responsibilities

- `src/renderer/src/components/SideBar.vue`：在“我的歌单”标题栏新增“导入账号歌单”按钮。
- `src/renderer/src/components/ImportPlaylistPanel.vue`：桌面化移植移动版面板，负责平台 tab、登录态检查、歌单列表、导入/更新按钮、错误与空态提示。
- `src/renderer/src/stores/playlists.ts`：新增 `syncRemote()`，调用 shared API 后整体刷新歌单列表。
- `src/shared/types.ts`：`Playlist` 增加 `neteaseId` / `qqId`，新增远端歌单摘要类型。
- `src/shared/api.ts` / `src/shared/ipc.ts`：定义 renderer API 与 IPC 通道。
- `src/preload/index.ts` / `src/main/ipc.ts`：桥接渲染层调用与主进程 handler。
- `src/main/providers/netease.ts` / `qq.ts`：移植账号歌单列表、详情和歌曲映射。
- `src/main/providers/cookies.ts`：补 QQ `g_tk` 计算等必要 helper。
- `src/main/services/catalog.ts`：按平台分发远端歌单请求并归一化歌曲。
- `src/main/services/playlists.ts`：按 `platform + remoteId` 新建或原地更新歌单。

## Data Flow

1. 用户点击侧栏“导入账号歌单”，打开统一面板。
2. 面板调用 `remotePlaylists(platform)` 读取账号歌单列表。
3. 用户点击“导入 / 更新”，面板调用 `remotePlaylistDetail(platform, id)` 拉取详情。
4. 详情非空时调用 `syncRemotePlaylist({ platform, name, remoteId, songs })`。
5. 主进程归一化歌曲并写入歌单存储，返回最新歌单列表。
6. 渲染层替换本地 `playlists.items` 并提示“已导入 / 已更新 N 首”。

## Error Handling

- 未登录：面板显示去设置登录提示，不发起远端请求。
- Cookie 失效 / 平台接口错误：展示明确错误，不修改本地歌单。
- 歌单为空：提示“没有可导入的歌曲”。
- VIP / 无版权：保留歌曲元数据并提示播放仍可能需要对应平台登录态；播放失败由现有“从队列移除并继续下一首”逻辑处理。
- 不做分享链接解析、不自动下载音频。

## Testing Strategy

- 纯函数 / 契约测试：类型字段、IPC 通道、API 声明、preload 和 main handler 对齐。
- Provider 测试：QQ `g_tk`、网易 / QQ 歌单列表与详情映射、未登录或不支持时抛错。
- 歌单同步测试：首次新建、同平台同 remoteId 原地更新、不同平台相同 remoteId 不串单、曲目去重。
- UI / store 测试：`syncRemote()` 调 API 与返回项查找；面板包含平台切换、登录引导、VIP 提示；SideBar 含导入入口。
- 最终验证：`npm run test:unit`、`npm run typecheck`、`npm run lint`、`npm run build`，并手工验证登录态、导入/更新、错误态。
