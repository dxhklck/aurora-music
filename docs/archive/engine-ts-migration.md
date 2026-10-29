# 长尾音源引擎：从 Python/musicdl 迁移到 TypeScript

> **已归档（2026-10-29）**：Python 实现与运行时已全部移除，双引擎时期结束。
> 当前状态见 [`python-removal.md`](./python-removal.md)；本文的性能数据继续作为迁移收益的历史基线保留。

> 功能对等与性能的最终判定见 [`engine-ts-parity-report.md`](./engine-ts-parity-report.md)。

> 版本：1.0 · 对应代码 `src/main/engine/ts/`
> 结论先行：**该做，且已做完主体迁移**。收益的大头是「少一个运行时」与「最坏路径变短」，
> 不是「TS 比 Python 快」。

## 一、迁移前评估

### 1.1 原实现分层

| 层 | 位置 | 规模 | 职责 |
|---|---|---|---|
| 传输 | `engine/musicdl/bridge.py` | 145 行 | stdio NDJSON、接管 stdout、线程池 4、ready/fatal 帧 |
| 逻辑 | `engine/musicdl/engine_core.py` | 791 行 | 8 条命令、token 缓存、模糊重定位、180s 搜索缓存、请求合并锁、45s 超时 |
| 上游 | `engine/vendor/musicdl` | 95 文件 / 19 063 行 | 40+ 音源、地址探测、HLS、mutagen 标签、rich 进度 |
| 运行时 | `engine/python` | 304 MB（Lib 282 MB） | 内嵌 CPython 3.12 |
| TS 胶水 | `python.ts` + `engine/musicdl.ts` + `providers/musicdl.ts` | 1 173 行 | 进程守护、握手、帧解析、错误归一 |

实际只用到 15 个源（合计 2 527 行），其余 25+ 源（Spotify / Tidal / Qobuz / Apple / YouTube…）
随安装包一起分发，从未被调用。

### 1.2 三处必须搬走的兼容补丁

都在 `engine_core.py`，也是迁移收益最直接的部分：

1. `install_page_hook()`——monkeypatch 每个源类的 `_search`，起一个每 120 ms 轮询
   列表长度的线程，假装成「逐首回调」，因为上游不暴露任何钩子；
2. `_PageProgress`——伪装成 `rich.Progress` 的假对象，唯一目的是把 `on_items` 塞进库内；
3. `install_error_probe()`——替换 `LoggerHandle.error` 并用 ContextVar 计数，
   因为上游把异常吞成日志，导致「接口挂了」和「没这首歌」无法区分。

TS 版这三处全部不需要：循环在自己手里，逐首回调是天然的；错误计数用
`AsyncLocalStorage`（等价 ContextVar，且在 await 链上自动传递）。

### 1.3 实测基线（迁移前，本机）

| 指标 | 数值 |
|---|---|
| 冷启动到 ready 帧 | 1 015 ms |
| 常驻内存 | 85 MB（独立进程） |
| 单源搜索（10 条） | 6~10 s，酷狗 19~34 s，JioSaavn 16 s，FMA 23 s |
| 运行时磁盘 | 304 MB |
| `import musicdl` | 866 ms，其中 `sources/qq.py` 占 588 ms（拉进 pywidevine / prompt_toolkit / bs4） |

### 1.4 风险与边界（评估阶段识别，迁移中逐条验证）

| 风险 | 结论 |
|---|---|
| 无 `curl_cffi` TLS 指纹 | 当前所有源均未启用，不影响；真需要时上 native addon |
| `json_repair` 容错更强 | 自写三档修复，实测未出现解析失败 |
| `mutagen` 能力强 | 已实现 ID3v2.3、FLAC/OGG/OPUS VorbisComment、MP4 `ilst`（含 stco 偏移修正） |
| HLS 依赖 ffmpeg | 与非 HLS 下载一致，已有外部依赖；缺失时退回 TS 分片并明确告知 |
| 上游红利消失 | 15 源进对拍脚本，可持续回归 |
| **Node 不支持 GET 带 body** | 酷我官方接口需要，改用 `node:https` 原生请求解决 |
| **OpenSSL 3 移除单 DES** | JioSaavn 用 3DES（K1=K2=K3）等价替代 |
| **HTML 单引号属性含撇号** | 自研解析器只认双引号定界，否则整页被吞 |

## 二、迁移方案与执行

### 2.1 目标结构

```
src/main/engine/ts/
  types.ts     领域类型（SongInfo / ProbeResult / SourceClient）
  errors.ts    EngineError / HttpError（错误码与 Python 版逐一对应）
  text.ts      legalize / cleanLrc / seconds2hms / 时长解析 / md5
  json.ts(并入 http.ts)  容错 JSON 解析
  http.ts      HttpSession（Cookie、重试、失败计数、GET+body 原生请求）
  probe.ts     AudioLinkTester（HEAD→GET、扩展名推断、魔数嗅探）
  html.ts      极简 DOM + 选择器（供 4 个 HTML 源复用）
  hls.ts       m3u8 解析、AES-128 解密、分片并发、ffmpeg 转封装
  tag.ts       ID3v2.3 / FLAC VorbisComment
  cache.ts     token 句柄、pickBest、搜索缓存、并发合并
  base.ts      BaseSource（分页并行 + 逐首推送 + 去重）
  index.ts     引擎门面（search/resolve/lyric/downloadHls/tag/ping）
  sources/     15 个音源 + 注册表
```

代码量：约 3 400 行 TS，替换 1 173 行胶水 + 1 000 行 Python 逻辑，并删除对 19 063 行上游的依赖。

### 2.2 执行顺序（按「风险从低到高、依赖从底向上」）

| 批次 | 内容 | 出口条件 |
|---|---|---|
| 0 | 核心层 `text/http/probe/base` | 咪咕跑通且字段与 Python 一致 |
| 1 | 咪咕、千千、5sing、街声、B站 | 逐字段对齐，首批耗时 < Python |
| 2 | JioSaavn、Jamendo、ccMixter、OGA、维基、Audius、FMA | 同上 |
| 3 | 波点、酷狗、SoundCloud（最重的三个） | 结果集不缩水，最坏耗时显著下降 |
| 4 | 接入 `engineMode` 开关、默认走 TS、保留 Python 回滚 | 构建通过、自检通过 |

### 2.3 回滚策略

- `AppSettings.engineMode: 'ts' | 'python'`，默认 `ts`；
- 切回 `python` 即恢复旧子进程路径，两条实现共用同一个 `MusicdlEngine` 门面，
  上层 `providers/musicdl.ts` 一行未改；
- Python 相关文件（`engine/`、`python.ts`）在本阶段**保留**，等 TS 版稳定若干个版本后再删；
- 回滚粒度可以到单个音源：`sources/index.ts` 的 `BUILDERS` 表按 key 增删即可。

## 三、迁移中的关键决策（与上游的差异）

### 3.1 保留了的行为

- 错误码 `unsupported / invalid / blocked / notfound / timeout / internal` 一字不改；
- 对外 payload 字段名、单位（durationMs / sizeBytes）、`hasMore` 语义；
- `pageSize` 按源标定：酷狗 2、咪咕 3，其余 3；
- 翻页策略 `want = min(limit × min(page,2), 20)`；
- 搜索缓存 180 s / 最多 200 条 / 同 key 并发合并；
- 45 s 搜索超时；
- 空结果 + 有失败日志 → `blocked`，空结果 + 无失败 → 返回空列表。

### 3.2 有意改变的行为

| 项 | 变化 | 原因 |
|---|---|---|
| 逐首推送 | 真逐首，无 120 ms 轮询延迟 | 循环可控，去掉观察线程 |
| 酷狗第三方通道 | 11 个 → 4 个（baka / coco / 90svip / lzmhhh），官方 CDN 兜底 | 被砍的 6 个上游自己标注为 "invalid or unstable"；实测命中率不变，最坏耗时 110s → ~30s |
| B站 Cookie | 不再携带他人过期的 SESSDATA 等身份 Cookie | 安全；代价见「已知偏差」 |
| SoundCloud | 不支持 Widevine（CTR）流 | TS 侧无 CDM 等价物；实测 Python 版此源当前也返回 0 条 |
| 标签写入 | m4a / ogg / opus 已支持，与 mp3/flac 同级 | MP4 处理 stco/co64 偏移；Ogg 重算 CRC 与分页 |

### 3.3 迁移中发现并修掉的上游缺陷

1. **街声 `file_size_bytes = 'HLS'`**：字符串进入 `cmd_resolve` 的 `int()` 会抛异常，
   使 HLS 曲目取址必然失败。TS 版按 0 处理，并在 `resolve` 里用 `Math.max(0, …)` 兜底。
2. **ccMixter 时长**：XSPF 的 `<duration>` 是毫秒，直接按秒解析会得到 70 万秒。
   上游在拿到 `ps` 字段时才赋值、否则置 0，TS 版用「必须带冒号」的规则对齐。
3. **OGA 附件选择**：`.mp3.ogg` 是自动转码预览，音质差；打分时要扣分，
   否则会优先选到预览片段。

## 四、验证

### 4.1 方法

`scripts/engine-ts/compare.mjs`：同一关键词、同一音源，分别跑 TS 与 Python，
逐字段比较 id / 歌名 / 歌手 / 专辑 / 扩展名 / 时长 / 体积，并统计耗时。
判定：id 集合一致 → `OK`；TS 是超集 → `SUPERSET`（不算回归）；字段不一致 → `FIELD`。

### 4.2 结果（关键词「love」，每源 3 条，2026-10-29 实测）

| 音源 | 状态 | 条数 TS/PY | 字段一致 | 耗时 TS / PY | 提速 | 首批 TS / PY |
|---|---|---|---|---|---|---|
| migu | OK | 3/3 | 18/18 | 1 217 / 3 906 ms | 3.2× | 715 / 3 038 ms |
| qianqian | OK | 2/2 | 12/12 | 1 488 / 4 396 ms | 3.0× | 849 / 2 957 ms |
| fivesing | OK | 3/3 | 18/18 | 1 009 / 3 066 ms | 3.0× | 616 / 2 559 ms |
| bodian | OK | 3/3 | 18/18 | 1 435 / 3 832 ms | 2.7× | 879 / 3 117 ms |
| streetvoice | OK | 3/3 | 18/18 | 1 767 / 4 474 ms | 2.5× | 1 146 / 3 486 ms |
| bilibili | 波动 | 3/3 | 12/12 | 1 462 / 3 681 ms | 2.5× | 640 / 2 797 ms |
| jiosaavn | OK | 3/3 | 18/18 | 7 146 / 16 830 ms | 2.4× | 3 151 / 7 206 ms |
| jamendo | OK | 3/3 | 18/18 | 6 218 / 21 439 ms | 3.4× | 3 311 / 9 717 ms |
| ccmixter | OK | 3/3 | 18/18 | 5 030 / 6 755 ms | 1.3× | 2 610 / 4 684 ms |
| opengameart | OK | 3/3 | 18/18 | 3 533 / 12 086 ms | 3.4× | 1 420 / 6 374 ms |
| audius | OK | 2/2 | 12/12 | 6 219 / 9 187 ms | 1.5× | 2 902 / 6 277 ms |
| fma | OK | 3/3 | 18/18 | 5 777 / 25 409 ms | 4.4× | 3 186 / 10 664 ms |
| kugou | SUPERSET | 4/3 | 18/18 | 3 947 / 31 834 ms | 8.1× | 2 427 / 17 105 ms |
| wikimedia / soundcloud | DOWN | 0/0 | — | — | — | — |

**汇总：13 个在线音源，字段差异 0 处，唯一「回归」是 B 站的结果波动。**

- 耗时含两侧各自的冷启动。Python 每次要起解释器（~1 s）并 import musicdl（~0.9 s），TS 无此开销。
- `SUPERSET`：酷狗多召回 1 条，共有条目字段全对。
- 另用关键词「稻香」跑过一轮：migu / fivesing / bodian / streetvoice / kugou 均为 `OK`，
  千千 / JioSaavn / Jamendo / ccMixter / OGA / Audius / FMA **两侧同为 0 条**
  （这些外文源确实没有「稻香」），不是迁移导致的功能缺失。

### 4.3 两处「看起来是回归、实际不是」的现象

**B 站结果波动**：同一关键词连续请求，第 2 条结果会在 `40847606754` 与 `40932019933`
之间跳动。连跑两次即可看到 TS 第二次与 Python 完全一致——这是平台搜索排序的抖动
（以及未携带个性化 Cookie 的影响），不是解析差异。共有条目的 12 个字段全部一致。

**波点码率差异（迁移中已修复）**：早期版本对同一首歌只拿到 192k ogg（5.5 MB），
而 Python 拿到 320k mp3（8.8 MB）。原因是上游在第三方通道之后还有一层**官方接口**
（`checkRight` → `audioUrl`），且要求「GET + JSON body」。Node 的 fetch 不允许 GET 带
body，初版直接跳过了这条链路。补上 `rawGetWithBody`（node:https 原生请求）并按
「文件体积取大」后，结果与 Python 逐字段一致。

### 4.4 端到端

`scripts/engine-ts/e2e.ts`（不依赖 Electron）：

```
搜索：3 条，total=3，hasMore=false，耗时 1131ms
首条：稻香 - 周杰伦 [mp3 8942448B]
取址：https://freetyst.nf.migu.cn/… protocol=HTTP size=8942448
重定位：https://freetyst.nf.migu.cn/…
未命中错误码：notfound
MP3 标签：ok=true ID3 头=true
FLAC 标签：ok=true VorbisComment=true
未知音源错误码：unsupported
全部通过
```

## 五、部署与体积

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| 安装包 | +304 MB 运行时 + 4.6 MB vendor | 0（15 个音源全部编入主进程 bundle，`out/main/index.js` 合计 358 KB） |
| macOS / Linux | 需本机 Python 3.10+ 且 `pip install musicdl` | 开箱即用 |
| 首启 | 六档解释器探测 + 25 s 握手 | 无探测、无握手 |
| 自愈 | 重拉 wheel + 设置页「修复源码」 | 不需要（按钮在 TS 模式下提示无需修复） |
| Android | Chaquopy 内嵌 CPython | 可直接复用 `src/main/engine/ts` |

## 六、已知偏差与遗留问题

| 项 | 影响 | 处置 |
|---|---|---|
| B站结果集可能相差个别条目 | 排序依赖 Cookie 个性化，且平台本身有抖动（同一侧连跑两次也会变） | 接受；如必须一致，可在设置里补自己的 Cookie |
| SoundCloud 无 Widevine | 无损/DRM 流不可用 | 保留 progressive 与原始文件；实测上游当前也为 0 条 |
| 标签容器兼容性 | MP4 的 `meta/keys`（mdta）型文件未覆盖 | 主流 m4a 使用 `ilst`；mdta 文件暂退回不改写，后续按需补 |
| 维基共享不可达 | 本机网络受限，两侧同为 0 条 | 换网络环境后回归 |
| 模糊重定位较弱 | 只给「歌名+歌手」时平台返回翻唱，匹配不到 | 与上游同缺陷；token 命中时不触发 |
| 波点第三方码率不稳 | 不同运行可能拿到 ogg/192 或 flac | 已按「体积取大」与官方接口对比后取值，尽量贴近上游 |

## 七、后续建议

1. **双跑一个版本**再删 Python：`engineMode` 保持默认 `ts`，把 `python` 留作应急；
2. 把 `scripts/engine-ts/compare.mjs` 接进 CI，作为「上游接口变更」的哨兵；
3. 若恢复 SoundCloud 无损，应作为独立模块引入 Widevine，而不是在音源层打补丁；
4. 删除 `engine/`、`python.ts`、`pythonPath` 设置、「修复源码」按钮时，一并移除
   `scripts/setup_engine.py`、`scripts/vendor_engine.py`、`scripts/repair_musicdl.py`。
