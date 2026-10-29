# TS 引擎功能对等与性能评估

> **已归档（2026-10-29）**：对拍的 Python 侧已移除，本报告不再更新，仅作历史记录。
> 当前状态见 [`python-removal.md`](./python-removal.md)。
>
> 评估对象：`musicdl` 引擎从 Python（`engine/musicdl` + `engine/vendor/musicdl`）迁移到 TypeScript（`src/main/engine/ts`）后，是否可以作为正式版本。
>
> 评估时间：2026-10-29 · 环境：Windows 11 / Ryzen 5 5600G / 15.4 GB / Node 22.22 / Python 3.13.14
> 复现命令见文末。

---

## 0. 结论

**功能已完全对齐，性能显著提升，可以作为正式版本切换。**

| 判定维度 | 结果 | 依据 |
|---|---|---|
| 核心引擎功能（搜索 / 取址 / 歌词 / HLS / 缓存 / 错误码 / 字段） | **完全对齐** | 92 个离线用例全通过；13 个在线音源逐字段对拍，功能回归 0 |
| 全部功能（含标签写入） | **已对齐** | m4a/mp4/aac 的 `ilst`、ogg/opus 的 Vorbis Comment 均已实现，并用 mutagen 交叉验证 |
| 性能 | **显著提升** | 搜索 1.6–4.6×，冷启动 7.3–9.0×，内存 −24%~−39% |

**建议：切换到 TS 引擎（`engineMode='ts'` 已是默认），保留 Python 作为回退通道一个版本周期。**

- D1（m4a/ogg 标签）已于 2026-10-29 补齐：MP4 处理了 `stco/co64` 偏移，Ogg 重算了 CRC 与分页；标签写入后的文件用 mutagen 与 PyAV 解码校验，音频数据逐字节不变。
- SoundCloud 的 Widevine 与维基共享的网络不可达不构成阻断：实测 Python 版在这台机器上同样返回 0 条。
- 回退方式仍然有效：设置 `engineMode='python'` 即回到旧子进程实现。

---

## 1. 范围与方法

**范围内**：`engine_core.py` 的命令与状态机、上游基类的编排算法、文本/数值归一化、播放地址探测、HLS 解析与解密、15 个音源的 URL 构造与字段解析、错误码与返回结构。

**范围外**（按约定不纳入对等判定）：Electron UI、设置页、stdio 传输帧、命令行脚本。`tag` 属于文件读写外围，但它是 `engine_core` 的命令之一，仍单独列出并标注差异。

四层证据，互相独立：

| 层 | 做法 | 产物 |
|---|---|---|
| 差分基线 | 用 Python 调 `legalizestring/_clean/_as_int/_norm/stable_id/song_payload/pick_best/cleanlrc/extractdurationsecondsfromlrc` 生成期望值，TS 逐条比对 | `fixtures/parity.json` + `text/cache/engine.test.ts` |
| 受控门面测试 | 用本地路由伪造咪咕接口，精确断言分页、缓存、并发、超时、错误码 | `engine.test.ts` |
| 真实回放 | 录制 15 个音源的真实响应，按 URL 回放，逐字段比对 | `fixtures/sources/*.json` + `sources.test.ts` |
| 在线对拍 | 同一关键词/条数，TS 与 Python 同时跑 13 个在线源，11 个字段逐项比 | `npm run engine:compare` |

---

## 2. 功能清单 → 测试用例映射

共 50 个功能点。✅ = 对齐；⚠️ = 有差异但已判定；❌ = 缺失；N/A = 传输层已移除。

### 2.1 门面与状态机

| 编号 | 功能点 | Python | TS | 测试用例 | 结论 |
|---|---|---|---|---|---|
| F01 | `ping` 返回运行时与音源数 | `cmd_ping` | `index.ts#ping` | engine › sources / ping | ✅ |
| F02 | `sources` 返回 15 个源与中文名 | `SOURCES` | `sources/index.ts` | engine › sources / ping | ✅ |
| F03 | 空关键词直接返回空结果、不打接口 | `cmd_search` | `search` | engine › 空关键词 | ✅ |
| F04 | `page`/`limit` 下限 1、上限 10 | `cmd_search` | `clamp` | engine › limit 上限 10 | ✅ |
| F05 | 召回量 `min(limit*min(page,2),20)` | `_run_search` | `runSearch` | engine › 分页切片 | ✅ |
| F06 | 切片、`total`、`hasMore`、`cost` | `_run_search` | `runSearch` | engine › 分页切片 | ✅ |
| F07 | 流式 partial 与按 id 去重 | `_PageProgress` | `onItem` | engine › 流式回调 | ✅（粒度更细，见 D9） |
| F08 | 45 秒搜索超时 → `timeout` | `SEARCH_TIMEOUT` | `withTimeout` | engine › 超时 | ✅ |
| F09 | 空结果 + 请求失败 → `blocked` | `_probed_search` | `withFailureScope` | engine › 平台全失败 | ✅ |
| F10 | 搜索缓存 180 秒 | `_search_cache` | `cache.ts` | cache › 180 秒过期；engine › 命中缓存 | ✅ |
| F11 | 缓存超 200 条淘汰最旧 | `_search_cache` | `writeSearchCache` | cache › 超过 200 条 | ✅ |
| F12 | 同 key 并发合并 | `_search_lock` | `withSearchLock` | cache › 并发合并；engine › 并发只打一次 | ✅ |
| F13 | token 记忆 / 复用 / 失效 | `remember/_tokens` | `remember/recall/dropToken` | cache › token 三例 | ✅ |
| F14 | 稳定 id（identifier 或 md5 前 16） | `stable_id` | `cache.stableId` | cache › stableId；parity › stableId | ✅ |
| F15 | 模糊重定位评分与 60 分阈值 | `pick_best` | `pickBest` | cache › pickBest ×2；parity › pickBest | ✅ |
| F16 | `resolve` 命中 token 不再搜索 | `resolve_song_info` | `resolveSongInfo` | engine › token 快路径 | ✅ |
| F17 | token 失效按歌名+歌手+时长重定位 | `pick_best` | `pickBest` | engine › 元信息重定位 | ✅ |
| F18 | 缺参 → `invalid`；无匹配 → `notfound` | `resolve_song_info` | `resolveSongInfo` | engine › notfound/invalid | ✅ |
| F19 | 无地址 → `blocked`；加密流 → `unsupported` | `cmd_resolve` | `resolve` | engine › 无地址 / 非 http | ✅ |
| F20 | resolve 全字段 + headers/cookies | `cmd_resolve` | `resolve` | engine › token 快路径 | ✅ |
| F21 | 歌词与音源中文名 | `cmd_lyric` | `lyric` | engine › lyric | ✅ |
| F22 | HLS 下载缺路径 / 缺地址 | `cmd_download` | `downloadHlsTo` | engine › download ×2 | ✅ |
| F23 | HLS 主清单选码率 / AES-128 / 拼接 / 进度 | `HLSDownloader` | `hls.ts` | hls › 三例 | ✅ |
| F24 | 标签文件不存在 → `notfound` | `cmd_tag` | `tag` | engine › tag notfound | ✅ |

### 2.2 文本、数值与协议归一

| 编号 | 功能点 | Python | TS | 测试用例 | 结论 |
|---|---|---|---|---|---|
| F25 | `legalizestring` 全流程（转义/实体/去标签/NFC/emoji/isprintable/pathvalidate） | `utils/misc.py` | `text.legalize` | text › legalize（30 向量） | ✅ |
| F26 | `_clean`：NULL/None/N/A/空白 → 空串 | `engine_core._clean` | `cleanText` | text › cleanText（14 向量） | ✅ |
| F27 | `int(float(x))` 严格解析 | `_as_int` | `toInt/toFloat` | text › toInt / toFloat | ✅ |
| F28 | `_norm`：Unicode 字母数字 | `_norm` | `normalizeForMatch` | text › normalize（9 向量） | ✅ |
| F29 | `seconds2hms` / `byte2mb` | `SongInfoUtils` | `secondsToHms/bytesToMb` | text › 格式一致 | ✅ |
| F30 | `cleanlrc` | `utils/lyric.py` | `cleanLrc` | text › cleanLrc（6 向量） | ✅ |
| F31 | `extractdurationsecondsfromlrc` | 同上 | `durationFromLrc` | text › durationFromLrc | ✅ |
| F32 | `song_payload` 13 字段归一 | `engine_core` | `toEngineSong` | engine › toEngineSong（3 向量） | ✅ |
| F33 | md5 / sha1 / base64 / query 编排 | 多处 | `text.ts` | 由 kugou / OGA 回放间接覆盖 | ✅ |

### 2.3 网络与探测

| 编号 | 功能点 | Python | TS | 测试用例 | 结论 |
|---|---|---|---|---|---|
| F34 | 失败重试与失败计数探针 | `requests` + `LoggerHandle` | `HttpSession` + ALS | http › 重试 / 失败计数 ×2 | ✅ |
| F35 | Cookie 会话累积 | `maintain_session` | `absorbCookies` | http › Set-Cookie | ✅ |
| F36 | 表单 / JSON / 前缀读取 | `get/post` | `form/json/maxBytes` | http › 编码 / maxBytes | ✅ |
| F37 | 容错 JSON 与抠 JSON | `json_repair` | `parseJsonLoose/extractJson` | http › 两例 | ✅ |
| F38 | 「GET + body」（酷我签名） | `requests.get(data=...)` | `rawGetWithBody` | http › GET 带 body + gzip | ✅ |
| F39 | HEAD→GET、扩展名推断优先级 | `AudioLinkTester` | `probeUrl` | probe › 主用例 | ✅ |
| F40 | 魔数嗅探 16 种容器 | `filetype/puremagic` | `sniffAudioExt` | probe › 魔数 | ✅ |
| F41 | 候选地址遍历 + HLS 协议标记 | 各源 `for quality` | `probeFirst` | probe › probeFirst / m3u8 | ✅ |

### 2.4 音源与容器

| 编号 | 功能点 | Python | TS | 测试用例 | 结论 |
|---|---|---|---|---|---|
| F42 | 15 源注册、中文名、pageSize | `SOURCES` | `SOURCE_META` | engine › sources；sources › 汇总 | ✅ |
| F43 | 13 个可用源的 URL/分页/字段解析 | 15 个 client | 15 个 source | sources › 14 条回放 | ✅ |
| F44 | 波点官方签名链路（GET+body） | `_parsewithkuwoapi` | `resolveOfficial` | 仅在线对拍 | ⚠️ D7 |
| F45 | 13 源 × 11 字段在线一致性 | — | — | `engine:compare` | ✅ D5/D6 |
| F46 | MP3 ID3v2.3（含保留 APIC） | `mutagen.id3` | `tag.writeId3` | tag › MP3 ×2 | ✅ |
| F47 | FLAC Vorbis Comment（保留自定义键） | `mutagen.flac` | `tag.writeFlac` | tag › FLAC ×2 | ✅ |
| F48 | m4a/mp4/aac/ogg/opus 标签 | `mutagen.mp4/ogg` | `tag-mp4.ts` / `tag-ogg.ts` | tag-containers › 12 条 | ✅ |
| F49 | wav / 未知后缀跳过 | `cmd_tag` | `writeTags` | tag › skipped | ✅ |
| F50 | 未知命令 → `unsupported`；异常 → `internal` | `dispatch` | 无 transport | N/A | N/A（传输层已移除） |

---

## 3. 验证结果

### 3.1 离线用例：92 / 92 通过

```
npm run engine:test
# tests 92   pass 92   fail 0
```

| 测试文件 | 用例数 | 覆盖 |
|---|---|---|
| `text.test.ts` | 10 | legalize / cleanText / toInt / norm / hms / cleanLrc / duration |
| `cache.test.ts` | 10 | stableId / pickBest / token / TTL / 200 淘汰 / 并发合并 |
| `http.test.ts` | 11 | 重试 / 失败计数 / Cookie / 编码 / 前缀 / JSON 修复 / GET+body |
| `probe.test.ts` | 5 | HEAD/GET / 重定向 / Content-Disposition / 魔数 / probeFirst |
| `engine.test.ts` | 20 | search / resolve / lyric / download / tag / 错误码 / 字段 |
| `sources.test.ts` | 15 | 14 个源回放 + 覆盖统计 |
| `hls.test.ts` | 3 | 选码率 / AES-128 / METHOD=NONE / 错误 |
| `tag.test.ts` | 6 | ID3 / FLAC / 保留字段 / 跳过 / 损坏文件 |
| `tag-containers.test.ts` | 12 | MP4 两种布局 / stco / Ogg 分页 / 自定义字段 / Opus / 超长歌词 / mutagen 交叉校验 |

差分基线覆盖 123 个输入向量：legalize 30、clean 14、asInt 15、norm 9、stableId 5、songPayload 3、pickBest 7、cleanLrc 6、duration 6、hms 8、byte2mb 6，全部与 Python 输出逐字节一致。

### 3.2 真实回放：14 个源逐字段一致

录制时共 38 条结果、约 150 个 HTTP 响应；回放后 id / 歌名 / 歌手 / 专辑 / 扩展名 / 时长 / 协议 / 歌词有无 / 封面域名 / 播放域名全部一致。维基共享与 SoundCloud 录制时即为 0 条（见 D2/D3）。

### 3.3 在线对拍：13 个源，功能回归 0

关键词「love」，每源 3 条，2026-10-29：

| 音源 | 状态 | 条数 TS/PY | 字段一致 | 耗时 TS / PY | 提速 |
|---|---|---|---|---|---|
| migu | OK | 3/3 | 33/33 | 1 325 / 4 960 ms | 3.7× |
| qianqian | OK | 2/2 | 22/22 | 1 517 / 5 903 ms | 3.9× |
| fivesing | OK | 3/3 | 33/33 | 979 / 4 182 ms | 4.3× |
| bodian | OK | 3/3 | 33/33 | 1 636 / 5 581 ms | 3.4× |
| streetvoice | OK | 3/3 | 33/33 | 1 975 / 5 516 ms | 2.8× |
| bilibili | OK / DIFF（波动） | 3/3 | 33/33（波动轮 22/22） | 1 350 / 3 838 ms | 2.8× |
| jiosaavn | OK | 3/3 | 33/33 | 9 430 / 21 037 ms | 2.2× |
| jamendo | OK | 3/3 | 33/33 | 6 004 / 17 168 ms | 2.9× |
| ccmixter | OK | 3/3 | 33/33 | 8 456 / 9 346 ms | 1.1× |
| opengameart | OK | 3/3 | 33/33 | 4 427 / 14 790 ms | 3.3× |
| audius | COSMETIC | 2/2 | 20/22 | 5 589 / 10 065 ms | 1.8× |
| fma | OK | 3/3 | 33/33 | 8 591 / 29 297 ms | 3.4× |
| kugou | SUPERSET | 4/3 | 33/33 | 3 687 / 11 288 ms | 3.1× |

- `SUPERSET`：酷狗多召回 1 条，共有条目 33 个字段全对。
- `DIFF`：B 站结果集 3/3 但个别曲目不同，属平台排序波动（同一侧连跑两次也会变）；上一轮为 `OK` 且 33/33。
- `COSMETIC`：仅封面 CDN 镜像不同（见 D5/D6）。
- 维基共享 / SoundCloud：两侧均为 0 条，标记 `DOWN`。
- **一次 JioSaavn 抖动**：某轮 `sizeBytes` 为 4 981 746 / 10 433 130，TS 侧回落到了较低码率；
  立即复跑 3 次，3 次均 `OK` 且 33/33。这是 CDN 返回不同码率档的偶发现象，不是解析差异（见 D13）。

### 3.4 容器标签：mutagen 与 PyAV 双向验证

- **MP4**：`sample-tail.m4a`（moov 在尾部）与 `sample-fast.m4a`（moov 在前部）都写入成功；
  mutagen 读回四个字段正确；`stco` 指向（新的）mdat 数据起点；mdat 逐字节不变。
  二次写入不会累积原子，faststart 偏移仍然正确。
- **Ogg Vorbis / Opus**：comment packet 改写后，identification/setup 包与全部音频包逐字节不变；
  末页 granule 不变；自定义字段 `KEEP=1` 保留；`TITLE` 不重复。
- **超长歌词**（90 010 字符，必然跨页）：Ogg 产生多页头部并带 `continued` 标志；
  mutagen 读回的歌词长度完整；PyAV 解码前后的 PCM 帧数与 SHA-1 完全一致。
- **失败路径**：ADTS 裸 `.aac` 与损坏的 `.m4a` 返回 `ok:false`；非 Ogg 数据返回 `ok:true`
  （与 Python `MutagenFile` 返回 `None` 的行为一致）。

### 3.5 应用级

- `npm run engine:e2e`：搜索 → 取址 → token 重定位 → notfound 错误码 → MP3/FLAC 标签 → 未知音源，全部通过。
- `npm run selftest`：16/17，关键失败 0；引擎段 5 项全 PASS，流式首批 448 ms、6 批 6 首。

---

## 4. 缺失与差异清单

| 编号 | 差异 | 影响 | 级别 | 处置 |
|---|---|---|---|---|
| D1 | ~~m4a/mp4/aac/ogg/opus 只 `skipped`~~ | **已修复**：标签写入、音频数据与索引均验证通过 | 已关闭 | `tag-mp4.ts` / `tag-ogg.ts` + 11 条容器用例 |
| D2 | SoundCloud 无 Widevine | 受 DRM 保护的曲目无法解析 | P3 | 实测 Python 版当前也 0 条；真需要时上 native addon |
| D3 | 维基共享网络不可达 | 两侧均 0 条 | P3（环境） | 换网络复验，不是代码差异 |
| D4 | B 站未携带身份 Cookie | 排序与个别条目可能与 Python 不同 | P3 | 平台本身有抖动；如必须一致，允许用户填 Cookie |
| D5 | 酷狗封面用官方 `imge.kugou.com`，Python 用 90svip 签名代理 | 都能显示；Python 的地址会过期 | 展示差异 | 保留 TS 行为（更稳），已在注释说明 |
| D6 | Audius 封面镜像域名不同 | 同一张图，不同 CDN | 展示差异 | 无需处理 |
| D7 | 波点官方取址无法离线回放（走 node:https） | 该链路只有在线对拍证据 | 测试缺口 | 已在线验证 33/33；可在 CI 加一条联网冒烟 |
| D8 | HLS 只验证了 `.ts` 直出，未验证 ffmpeg remux | mp3/m4a 转封装未被自动化覆盖 | 测试缺口 | 与 Python 同样依赖外部 ffmpeg；建议加一条带 ffmpeg 的集成用例 |
| D9 | 流式粒度是「逐首」而非「逐页」 | 首批更早、事件更多；最终结果一致 | 有意差异 | 保留 |
| D10 | `hasMore` 在第 1 页恒为 false | 与 Python 完全相同的怪癖 | 已对齐 | 保留 |
| D11 | token 字符串格式不同 | token 是进程内句柄，不跨版本比较 | 无影响 | 保留 |
| D12 | `ping` 字段、stdio dispatch 移除 | 传输层不再需要 | 有意差异 | 保留 |
| D13 | JioSaavn 偶发回落低码率（`_320` → 较低档） | 单曲体积/音质偶发下降 | P3（平台） | 复跑 3 次均 33/33；如需强约束，可在探测后按码率二次校验 |
| D14 | 截断/损坏容器：TS 直接拒绝改写 | mutagen 可能仍读出部分标签 | 有意差异（数据保护） | 失败时文件保持原样；正常文件不受影响 |

---

## 5. 性能对比

方法：同一台机器、同一关键词集合；每档跑 2 轮进程，取引擎内 `cost` 的中位数；`ready` 为进程启动到引擎可用；RSS 为全部搜索结束后的常驻内存。

### 5.1 搜索耗时（引擎内，中位数）

| 场景 | TS | Python | 提速 | 条数 |
|---|---|---|---|---|
| migu × 3 条 | 1 060 ms | 2 008 ms | **1.9×** | 3/3 |
| qianqian × 3 条 | 1 190 ms | 2 429 ms | **2.0×** | 2/2 |
| kugou × 3 条 | 2 544 ms | 11 809 ms | **4.6×** | 3/3 |
| migu × 10 条 | 1 324 ms | 2 096 ms | **1.6×** | 10/10 |
| kugou × 10 条 | 3 241 ms | 12 246 ms | **3.8×** | 10/10 |

### 5.2 冷启动与内存

| 场景 | ready TS/PY | 首次搜索 TS/PY | RSS TS/PY |
|---|---|---|---|
| migu × 3 | 261 / 1 897 ms（7.3×） | 1 496 / 4 248 ms（2.8×） | 61 / 97 MB |
| qianqian × 3 | 254 / 1 925 ms（7.6×） | 1 836 / 4 787 ms（2.6×） | 59 / 96 MB |
| kugou × 3 | 225 / 1 932 ms（8.6×） | 3 434 / 17 446 ms（5.1×） | 68 / 100 MB |
| migu × 10 | 241 / 1 966 ms（8.2×） | 1 427 / 4 439 ms（3.1×） | 67 / 101 MB |
| kugou × 10 | 230 / 2 078 ms（9.0×） | 4 055 / 15 706 ms（3.9×） | 77 / 104 MB |

**结论**：提速来自两部分——去掉解释器/import（冷启动 1.9 s → 0.24 s）、去掉跨进程与逐页轮询（稳态 1.6–4.6×）。网络 RTT 仍是主要成本，ccmixter 这类本身慢的源只快 1.1×，符合预期。

**性能口径说明**：TS 的数字是独立 Node 进程；接入 Electron 主进程后不会再有额外进程启动，主进程 RSS 会增加约 55–75 MB，但同时少一个 96–104 MB 的 Python 子进程，净收益仍然为正。

---

## 6. 最终判定

| 门槛 | 是否满足 | 说明 |
|---|---|---|
| 功能完全对齐 | **是** | D1 已关闭；仅剩 D2/D3 等环境或上游能力边界（Python 侧同样不可用） |
| 性能确有提升 | **是** | 搜索 1.6–4.6×，冷启动 7.3–9.0×，内存 −24%~−39% |

**因此：可以切换为正式版本。**

1. 默认实现已经是 `engineMode='ts'`；本次补齐后，搜索/取址/歌词/HLS/标签全部对齐。
2. 建议保留 `engineMode='python'` 与 `engine/` 一个版本周期，用于线上问题回退；
   下个版本再删除 Python 运行时与 300 MB 内嵌解释器。
3. 遗留的 D7/D8 是测试覆盖缺口（波点在线链路、ffmpeg remux），不影响功能判定；
   建议后续补联网冒烟与带 ffmpeg 的集成用例。
4. SoundCloud Widevine 属于上游能力边界：需要 native addon 才能补齐，当前实测无可用曲目，暂不投入。

---

## 7. 复现

```bash
# 离线功能测试（92 例，不联网）
npm run engine:test

# 端到端（联网：搜索/取址/标签）
npm run engine:e2e

# 在线全音源对拍（约 2.5 分钟）
npm run engine:compare

# 性能基准（约 6 分钟）
node scripts/engine-ts/bench/run.mjs

# 重新生成 Python 差分基线（需要 engine/.venv）
engine/.venv/Scripts/python.exe scripts/engine-ts/fixtures/generate-parity.py

# 重新录制音源回放样本（需要联网）
npx esbuild scripts/engine-ts/fixtures/record-sources.ts --bundle --platform=node --format=esm \
  --target=node22 --outfile=scripts/engine-ts/.build/record-sources.mjs
node scripts/engine-ts/.build/record-sources.mjs love 3
```
