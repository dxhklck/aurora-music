# Aurora Music 架构设计

> 本文说明技术决策、分层边界、关键流程，以及从 `musicdl` 借鉴并改造的设计。

## 1. 设计目标

1. **音源可插拔**：平台差异只允许存在于 `providers/` 内部，新增平台不改 UI、不改数据层。
2. **播放链路健壮**：取地址失败、VIP 限制、链接过期、Referer 校验都要有明确降级路径。
3. **下载可观测**：进度、速度、重试次数、错误原因都可回传到界面，并能断点续传。
4. **UI 与平台解耦**：渲染进程只认 `Song` / `Lyric` / `StreamInfo` 这些领域模型。

---

## 2. 从 musicdl 提炼的五个可复用设计

阅读 `musicdl/` 后，以下机制被保留并移植到本项目的对应位置：

| musicdl 的设计                                                                                  | 作用                 | Aurora 的对应实现                                                                                |
| -------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `BaseMusicClient` 模板方法：`search()` 负责构造 URL、线程池并发、去重；子类只实现 `_constructsearchurls` / `_search` | 把「并发与流程」和「平台细节」分离  | `BaseProvider`（`base.ts`）：重试、超时、表单、探测；子类只实现 `search/charts/chartDetail/resolveStream/lyric` |
| `MusicClientBuilder.REGISTERED_MODULES` 按类名动态装载客户端                                           | 平台可增删、可运行时选择       | `ProviderRegistry`：`register / get / list / streamCandidates`，UI 通过 `provider:list` 读取能力    |
| `SongInfo` 统一字段 + `with_valid_download_url` + `save_path` 冲突消解                               | 各平台返回被归一化，后续流程无需分支 | `Song` / `StreamInfo`（`shared/types.ts`）+ `uniqueFilePath()` + `sanitizeFileName()`         |
| 每个平台多个 `_parsewithxxxapi` 依次尝试；`MUSIC_QUALITIES` 从高到低试；`AudioLinkTester` 实测 URL              | 单一接口不稳定时的容错        | `resolveStream` 音质阶梯 + `BaseProvider.probe()`（Range 请求校验状态码与 MIME）+ 跨平台换源                   |
| `cleanlrc` / `extractdurationsecondsfromlrc` / `LyricSearchClient`（lrclib 兜底）                | 歌词清洗与多源回退          | `shared/lyric.ts`（清洗、多时间戳、offset、译文合并）+ `catalog.lyric()` 的 LRCLIB 兜底                       |
| `ThreadPoolExecutor` + rich 双级进度（总任务 / 单曲）                                                   | 下载可控可观测            | `DownloadManager`：固定并发 2 + 每任务 `progress/speed/attempt`，批量推送到渲染层                            |

**没有照搬的部分**：musicdl 是 Python CLI + 命令行进度条；本项目把「进度」换成 IPC 事件，把「线程池」换成  
`fetch` 流 + Node `stream.pipeline`（背压由流处理，不阻塞事件循环）。

---

## 3. 分层与依赖

```
UI 层 ── window.api ──▶ 数据层 ──▶ 音源层 ──▶ muse:// 代理 ──▶ 平台/CDN
```

| 层  | 位置                           | 职责                              | 禁止事项                |
| -- | ---------------------------- | ------------------------------- | ------------------- |
| UI | `renderer/`                  | 渲染、交互、动画、播放时钟、队列展示              | 不直接发网络请求、不解析平台 JSON |
| 播放 | `renderer/src/core/audio.ts` | 封装 `HTMLAudioElement`、淡入淡出、事件总线 | 不关心歌曲来自哪个平台         |
| 数据 | `main/services/`             | 缓存、搜索聚合、换源、下载队列、本地库、设置          | 不拼 UI 文案以外的展示逻辑     |
| 音源 | `main/providers/`            | 请求签名、字段归一化、音质映射、可用性探测           | 不写磁盘、不发 IPC         |
| 传输 | `main/protocol.ts`           | 自定义协议、Referer 注入、Range 透传       | 不含业务判断              |

依赖只能自上而下。`shared/` 是唯一被两侧同时引用的目录（纯类型与纯函数，无副作用）。

---

## 4. 音源层

### 4.1 接口

```ts
interface MusicProvider {
  readonly info: ProviderInfo                     // 名称、颜色、能力、说明
  search(args: SearchArgs): Promise<SearchPage>
  charts(): Promise<ChartSummary[]>
  chartDetail(args): Promise<SearchPage>
  resolveStream(song: Song, quality: Quality): Promise<StreamInfo>
  lyric(song: Song): Promise<Lyric | null>
}
```

`ProviderInfo.capabilities` 是 UI 的唯一开关：不支持的按钮不渲染、榜单页给出切换建议。  
`BaseProvider` 提供默认实现（不支持的榜单抛 `unsupported`），子类只需覆盖自己支持的项。

### 4.2 错误模型

```ts
class ProviderError extends Error {
  code: 'network' | 'blocked' | 'unsupported' | 'parse' | 'empty'
}
```

- `blocked`：平台明确拒绝（VIP、无版权、purl 为空）→ 触发换源；
- `network` / `parse`：接口异常 → 由 `BaseProvider.request` 指数退避重试（4xx 不重试）；
- `unsupported`：能力缺失 → UI 层应提前避免调用。

### 4.3 音质阶梯与可用性探测

以网易云为例：

```
lossless → exhigh → standard → 外链(128k)
   每档：请求 → 拿到 url → probe(url) 实测 → 通过则返回；否则下一档
```

`probe()` 用 `Range: bytes=0-1` 请求，校验 `status ∈ {200,206}` 且 `Content-Type` 是音频，  
过滤掉「返回 200 但其实是 404 HTML」的典型陷阱（musicdl 的 `AudioLinkTester` 做的是同一件事）。

### 4.4 跨平台换源

`CatalogService.resolveTrack(song, autoSwitch)`：

1. 原平台 `resolveStream`；
2. 失败且允许换源 → 用**歌名**到其它支持播放的平台搜索（限 8 条）；
3. 打分：歌名完全一致 +60、包含 +35、歌手匹配 +30、时长接近 +10、时长差 >30s −15；
4. `score >= 70` 才接受，然后取地址；
5. 返回 `{song: 替代曲目, stream, switchedFrom, notice}`，UI 顶部提示「已自动切换音源」。

---

## 5. 数据层

### 5.1 缓存

`TtlCache`：TTL + 容量上限 + **in-flight 合并**。同一关键词被连续点击时只打一次上游。  
搜索 3 分钟、榜单 10 分钟、歌词 30 分钟（未命中也缓存 5 分钟，避免反复追问 LRCLIB）。

### 5.2 歌词管线

```
provider.lyric()  ──有结果──▶ 返回
      │空/异常
      ▼
LRCLIB /api/get (artist+title+duration)  ──命中──▶ 返回
      │404
      ▼
LRCLIB /api/search → 打分（标题/歌手/时长）→ 取最佳
```

解析统一走 `shared/lyric.ts`：

- 清洗 BOM / 零宽字符 / 纯时间戳空行；
- 一行多时间戳（副歌复用）；
- `[offset:±ms]` 全局偏移；
- `mm:ss.xx` 与 `hh:mm:ss.xxx` 兼容；
- 译文按时间戳（±50ms）合并；
- 无时间轴时降级为 `plain` 纯文本。

### 5.3 下载状态机

```
queued ──▶ downloading ──▶ done
   ▲            │  │
   │            │  └──▶ canceled（用户取消，删除 .part）
   │            ▼
   └──── error ◀┘（重试 N 次仍失败，N 可配置）
```

- 并发：`settings.downloadConcurrency`（默认 2），队列 FIFO，可随时改；
- 重试：第 N 次失败后等待 `600 * N` ms，重新解析播放地址（链接可能已过期）；
- 续传：存在 `.part` 时带 `Range: bytes=<size>-`，服务端返回 200 则从头写；
- 流式下载：`Readable.fromWeb(response.body) → Transform(计数) → createWriteStream`，背压由 `pipeline` 处理；
- 进度：`Transform` 中累加字节，节流 240ms 通过 IPC 推送，速度按 400ms 窗口采样；
- 完成：移动到最终文件名（同名自动加 `(1)`），写 `.lrc` 与 `.meta.json`，登记 `library.json`；
- 落盘：队列写 `downloads.json`（600ms 防抖），重启后 `downloading/queued` 一律回到 `queued` 续跑；
- 标签：`settings.writeTags` 开启时，下载完成把标题/歌手/专辑/封面/歌词写进容器
  （MP3 → ID3v2，FLAC/OGG → Vorbis Comment，M4A → MP4 atom），复用引擎里的 mutagen，失败只告警不阻断。

### 5.3.1 下载地址的两条来源

这是最容易踩坑的地方：`StreamInfo.url` 是给渲染进程 `<audio>` 用的 `muse://` 代理地址，
**Node 的 `fetch` 不认识这个协议**，直接拿去下载必然失败。所以 `StreamInfo` 额外带一个 `directUrl`：

```ts
interface StreamInfo {
  url: string          // muse://media/?u=...&r=...  给 <audio>
  directUrl?: string   // https://cdn.../x.mp3      给下载器
  headers?: Record<string, string>  // Referer / Cookie / UA
  transport?: 'http' | 'hls'
}
```

下载器优先走 `directUrl + headers`；`transport === 'hls'` 时改由引擎的 `HLSDownloader` 拉流并 remux。
两条路都失败才判定该任务失败。

### 5.4 本地库

`library.json` 只存索引（文件路径、大小、来源平台、歌词/元数据路径）。  
启动时 `prune()` 校验文件是否仍存在，避免出现「列表里有、点开 404」。  
`LocalProvider` 把索引包装成音源，因此本地播放与在线播放走完全相同的链路。

### 5.5 musicdl 引擎

Aurora 自己实现了网易云/QQ/酷我（需要榜单与逐字歌词），剩下的平台签名算法太多，
直接复用 musicdl 的 Python 实现，而不是在 TS 里重写一遍。

```
渲染进程 ──IPC──▶ MusicdlProvider ──▶ EngineClient ──NDJSON──▶ bridge.py ──▶ musicdl
                                        │
                                        ├─ 运行时探测（AURORA_PYTHON → 内置 → .venv → 系统）
                                        ├─ 懒启动 / 超时 / 崩溃自动重启
                                        └─ 请求 id 关联，事件与响应分流
```

**为什么用 stdio 而不是 HTTP**：不用抢端口、不用处理 CORS、进程生命周期天然跟随主进程；
一行一个 JSON 也足够做流式进度推送（`download` 命令会持续吐 `event: progress`）。

**性能取舍**：musicdl 的 `search()` 会把「搜索」和「逐首解析真实地址」耦合在一起，
所以引擎音源的搜索天然比原生音源慢一个数量级。桥里做了四件事：

1. **分页并行**：`search_size_per_page` 调到 2~3，让 10 条结果拆成 4~5 页并发解析
   （同一页内是串行的，页与页之间才走线程池）。酷狗 19s → 9s，咪咕 17s → 6.7s；
   再往下拆会触发平台风控（咪咕每页 2 条反而退化到 50s+），所以按音源单独标定；
2. **逐首推送**：解析出一首就推一首，用户不用等全部完成（见 5.5.1）；
3. **并发去重**：同一 `(源, 关键词, 页, 条数)` 用一把锁串起来，后到的等前一个结果；
4. **TTL 缓存**：命中直接返回，不再打平台接口。

**换源策略**：引擎音源参与自动换源，但有次数上限（2 个）与总时间预算，
否则「逐个平台试一遍」会让一次播放卡上十几秒。

### 5.5.1 边搜边出（streaming）

引擎侧是「搜索慢、但结果可以逐条产出」的典型场景，所以搜索做成了流式：

```
渲染进程  search({..., streamId})        ── invoke ──▶ 主进程
                                                    │
主进程    catalog.search(onPartial) ◀───────────────┘
              │
              ▼
          musicdl.searchStream ── NDJSON ──▶ bridge
                                              │ 每解析出一首
              ┌───────────────────────────────┘
              ▼
          {"event":"partial","id":7,"items":[song]}
              │
主进程    engine.dispatch → pending.onPartial → win.webContents.send('provider:search-partial')
              │
渲染进程  store.results 追加（按 platform:id 去重）→ 表格实时增长
```

两个实现细节值得记一笔：

- **为什么钩在 `_search` 上而不是 `search` 上**：`search()` 要等所有页都跑完才返回，
  按页推等于最后一起到（实测 4 个分页都在 7.3~7.6s 同时完成）。真正的颗粒度在页内——
  `_search` 每解析出一首就往 `song_infos` 里 append 一次。桥里用一个 120ms 的观察线程
  盯列表长度，有新元素就推，不侵入 musicdl 的任何代码。
  效果：首条结果从 7.8s 提前到 3.7s，之后每 1~2s 追加一批。
- **收尾不整体替换**：流式顺序是「谁先解析完谁在前」，最终顺序是「按页序」。
  如果两者集合一致，渲染层保留已渲染的顺序不动——顺序跳变比顺序不完美更刺眼；
  只有集合不一致（比如上游去重掉了重复项）才用最终结果替换。

---

## 6. 主进程边界

### 6.1 IPC 一览

| 通道                                            | 方向                  | 说明         |
| --------------------------------------------- | ------------------- | ---------- |
| `provider:list`                               | invoke              | 音源信息（能力矩阵） |
| `provider:search` / `charts` / `chart-detail` | invoke              | 目录数据       |
| `provider:resolve-track`                      | invoke              | 播放地址 + 换源  |
| `provider:lyric`                              | invoke              | 歌词         |
| `download:enqueue/list/cancel/retry/clear`    | invoke              | 下载任务       |
| `download:progress`                           | main → renderer     | 任务列表快照（节流） |
| `library:*` / `settings:*`                    | invoke              | 本地库与设置     |
| `playlist:*`                                  | invoke              | 收藏与歌单（写操作统一返回完整列表） |
| `win:*`                                       | send/invoke         | 无边框窗口控制    |
| `lyric-window:toggle/close/lock/push`         | send/invoke         | 桌面歌词       |
| `lyric-window:state`                          | main → lyric window | 歌词状态推送     |

所有跨进程对象参数在渲染侧先经 `core/plain.ts` 转纯数据 —— **Vue 的 reactive Proxy 无法被结构化克隆**，  
否则会抛 `An object could not be cloned`。

### 6.2 `muse://` 媒体协议

```
muse://media/?u=<encoded target>&r=<encoded referer>   → 远程音频/封面
muse://local/?p=<encoded file path>                    → 本地文件
```

- 远程：注入 `Referer`（平台 CDN 校验）、透传 `Range`（拖动进度）、只透出安全响应头；
- 本地：解析 Range 返回 206 + `Content-Range`，并限制扩展名白名单，防止任意文件读取；
- 使用 undici `fetch` 而非 `net.fetch`：后者在自定义协议回调里对部分 CDN 直接 `ERR_FAILED`。

### 6.3 桌面歌词窗口

- `transparent + frame:false + alwaysOnTop('screen-saver') + skipTaskbar`；
- 默认按设置决定是否 `setIgnoreMouseEvents`（锁定=穿透）；
- 主窗口 250ms 推送状态，子窗口用 `sentAt` 做 rAF 本地插值 → 60fps 平滑，不依赖 IPC 频率；
- 双击窗口/点击关闭按钮之外的区域可拖动（`-webkit-app-region: drag`）。

---

## 7. 播放层

`AudioEngine` 只做三件事：

1. **事件归一化**：`time / duration / buffered / playing / waiting / ended / error`；
2. **淡入淡出**：切歌时 0 → 目标音量 420ms，暂停时反向淡出后再 `pause()`，避免爆音；
3. **音量安全**：所有写入 clamp 到 `[0,1]`（插值越界会让 `HTMLMediaElement.volume` 抛 `IndexSizeError`）。

歌词同步在 `LyricPane` 内独立跑 rAF：直接读 `audio.currentTime`（精度远高于 `timeupdate` 的 4Hz），  
二分查找当前行，行变化时用 `translate3d` 把该行移到容器中线，CSS `transition: 0.52s` 负责缓动。  
Store 中的 `activeLyricIndex` 则供桌面歌词与进度条使用。

播放模式：`loop`（列表循环）/ `single`（单曲循环，自然结束才重播）/ `shuffle`（随机，避免连续重复）/ `order`（顺序，播完停止）。

---

## 8. UI 层

- **App.vue** 负责外壳与全局副作用：启动装配、快捷键（空格/方向键）、歌词状态推送、Toast 监听；
- **stores** 五个：`app`（音源+设置+Toast）、`player`（队列+播放+歌词）、`search`、`download`、`library`；
- **视觉**：`--accent` / `--accent-2` 由当前音源主题色注入，页面顶部有动态光斑；封面缺失时按 id 哈希生成渐变；
- **动效**：路由 `fade + translate`、歌词舞台 `scale + fade`、黑胶 20s 匀速旋转（`animation-play-state` 随播放暂停）、播放条封面 hover 蒙层。

---

## 9. 关键流程

**播放**

```
双击歌曲 → player.setQueue(list, i)
        → IPC provider:resolve-track
        → Provider.resolveStream（音质阶梯 + probe）
        → 返回 muse://media URL
        → AudioEngine.load(url, {autoplay}) → 淡入
        → 并行 provider:lyric → LyricPane 起 rAF 时钟
```

**下载**

```
点击下载（单曲/勾选批量）→ DownloadManager.enqueue → queue（落盘）
        → pump（并发可配置）→ resolveTrack
        → 取 StreamInfo.directUrl + headers（不是 muse:// 代理地址）
        → fetch(stream, Range) → .part 写入 + 进度节流推送
        → 完成：rename → .lrc + .meta.json → 可选写标签 → library.add
```

**引擎调用**

```
MusicdlProvider.search → EngineClient.call('search', …)
        → 引擎未启动？spawn python bridge.py，等 ready 事件
        → 写一行 JSON 到 stdin，按 id 等 stdout 上的响应
        → 超时/进程退出 → 杀进程、标记 error、下次调用重新拉起
```

---

## 10. 扩展点

| 想做的事            | 改哪里                                                               |
| --------------- | ----------------------------------------------------------------- |
| 新增音源            | 实现 `MusicProvider` → `providers/index.ts` 注册一行；或直接在 `MUSICDL_SOURCES` 加一条复用引擎 |
| 新增榜单            | 在对应 Provider 的 `charts()` / `chartDetail()` 里加定义                  |
| 支持逐字歌词（YRC）   | 已完成：`parseYrc` + `LyricPane`/`DesktopLyric` 的 CSS calc+clamp clip-path 渐变 |
| 播放均衡器/可视化       | `core/audio.ts` 接 `AudioContext`，UI 新增 `Visualizer.vue`           |
| 下载并发/重试策略可配置    | 已完成：`settings.downloadConcurrency` / `downloadRetries`            |
| 封面补全（酷我无封面）     | 已完成：`CoverService` 跨平台搜封面 + 24h 缓存 + 去后缀主干匹配                 |
| 打包分发            | `electron-builder.yml`（已提供，`extraResources` 包含演示音频）               |

---

## 11. 已知限制

1. 各平台接口为非官方公开端点，**可能随时变更**；失败时会明确报错并支持换源，但无法保证长期可用。
2. QQ 音乐未登录时绝大多数曲目没有播放权限（`purl` 为空），实际播放依赖换源。
3. 酷我搜索不返回封面、歌词接口需鉴权，因此封面用渐变占位、歌词走 LRCLIB。
4. 已实现逐字歌词（网易云 YRC）；未实现音效均衡器（已在扩展点列出）。
5. **引擎音源依赖本机 Python**：`engine/.venv` 未就绪时这些音源不可用（应用其余部分正常）。
   打包只带 musicdl **源码**（`engine/vendor`，由 `npm run engine:vendor` 生成），不带虚拟环境——
   虚拟环境与平台/解释器版本绑定，不能跨机分发。安装版首次使用引擎音源时，
   需要目标机器有 Python 3.10+ 与 musicdl 依赖，设置页的「指定解释器」会写进
   `settings.pythonPath` 并优先于其它探测顺序；也可以把便携运行时放到 `resources/python`。
6. **引擎音源搜索较慢**（整批 5~10s）：这是 musicdl 在搜索阶段就解析真实地址导致的，
   已通过分页并行 + 逐首推送 + 缓存 + 并发去重压到可接受范围——首条 3~4s 可见，
   但整批完成仍需等这么久。要进一步提速需要改造上游的搜索/解析耦合。
7. 部分引擎音源的歌词为空或只有纯文本，取决于平台是否返回。
8. `musicdl` vendor 源码里曾出现空字节损坏（`quarkparser.py` / `cookies.py`），
   已提供 `scripts/repair_musicdl.py` 从 PyPI 同版本回填；重新拉取 vendor 后若报
   `SyntaxError: source code string cannot contain null bytes`，先跑一次该脚本。
