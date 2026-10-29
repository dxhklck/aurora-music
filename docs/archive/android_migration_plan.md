# Aurora Android 迁移方案（六项）

> 2026-10-27 · 针对 Android 迁移需解决的六个问题逐一给出方案。
> 前提：音源 Provider（netease/qq/kuwo/musicdl）均为 HTTP 逻辑，UI 全部为 Vue。

## 壳方案假设

推荐 **Capacitor 包装现有 Vue 渲染层**：
- 第 1~4 点是纯 Vue/CSS 改动，可直接复用，零重写。
- TS Provider 层从 Electron main 迁到 WebView 侧（fetch 即可），`window.api` 换成 Capacitor Bridge 实现。
- 播放用原生音频插件（如 `capacitor-native-audio` / 自写 ExoPlayer 插件），替代 HTML5 Audio 保证后台播放与格式兼容。
- 备选：Kotlin 原生重写 UI——成本约为前者的 3~4 倍，仅在需要深度原生体验时考虑。

以下方案按"Vue 复用"路线写；若最终走原生重写，第 1~4 点的交互设计不变，实现语言换成 Kotlin/Compose。

---

## 1. 发现页移除"能力一览"

纯删除，无依赖：
- `DiscoverView.vue` L222~239：删除 `<h2>能力一览</h2>` + `feature-grid` 整块模板。
- 同文件 `<style>` 中删除 `.feature-grid` / `.feature` / `.ficon` 三组规则（L460~489）。
- 检查：该块无脚本依赖（无 ref/computed 引用），删模板即可，`Icon`/`app` 等仍被其他区块使用，不清理 import。

## 2. 排行榜入口改小圆点、每行两个

现状：`ChartCard.vue` 大卡片，`grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))`。

方案：新增轻量组件 `ChartDotItem.vue`（圆点 + 榜单名），替代榜单入口处的 ChartCard：
- 结构：`<i class="dot" :style="{background: colorFor(index)}" /> <span>{{ chart.name }}</span>`，整行可点击跳 `ChartDetailView`。
- 色板：沿用现有 provider.color 作为首色，其余从主题 accent 色板按序号取（8 色循环），保证各榜单可区分。
- 布局：`.chart-grid` 改为 `grid-template-columns: repeat(2, 1fr); gap: 8px 16px;`，行高 ≥44px 满足触控目标。
- 应用位置：`DiscoverView.vue` 与 `ChartsView.vue` 两处的榜单网格统一替换；ChartCard 保留（后续可用在榜单详情页头部）。

## 3. 最近播放歌名显示不全

现状：`SongTable.vue` 桌面表格布局（L254~280）固定列：`46px 序号 + 2.4fr 歌名 + 1.3fr 歌手/专辑 + 92px + 112px`。手机宽度下 112px 操作列 + 专辑列把歌名压到几十像素。

方案：SongTable 增加 ≤640px 断点的"行卡片"布局，而非继续压缩表格：
- 隐藏列：序号、专辑、大小、下载/更多按钮（操作移到长按弹出菜单或行尾单个 `⋯` 按钮）。
- 保留列：封面 44px + 歌名区 `1fr` + 时长 `auto`。
- 歌名区改两行结构：第一行歌名 `min-width:0; overflow:hidden; text-overflow:ellipsis`（现成 `.truncate` 可用），第二行歌手小字；VIP/SQ 角标内联到歌名行尾。
- 关键修复：给歌名单元格加 `min-width: 0`（grid 子项默认 `min-width:auto` 会被内容撑开，这正是"显示区域过短"的根因之一）。
- 改动只加一段 `@media (max-width: 640px)` 的 grid 重定义 + 少量隐藏类，桌面布局不受影响。

## 4. 榜单页增加音源选择 + 榜单切换

现状：`ChartsView.vue` 只在"空状态"里提供换源按钮；正常状态没有任何音源/榜单切换入口。

方案：在榜单页头部下加两行控件：
1. **音源选择行**：横向滚动 chips，数据源 `app.providers.filter(p => p.capabilities.charts)`，当前项高亮（用 provider.color），点击 `app.setPlatform(id)` 后重载榜单——逻辑与现有空状态 `switchTo()` 完全一致，直接复用。
2. **榜单切换行**：即第 2 点的圆点列表，点击进 ChartDetailView。
- 音源切换后：清空 charts、重新 `window.api.charts(platform)`；hero 推荐区（DiscoverView）已有 `watch(app.platform)` 联动，无需额外改。
- 不支持榜单的音源（capabilities.charts=false）不显示 chip，避免切过去空白。

## 5. 登录账号移动端重设计

桌面现状：三种方式——扫码（用户用手机 App 扫桌面二维码）、浏览器内登录（Electron 窗口打开官网）、粘贴 Cookie。手机端前两条要么反转要么不可用，需重设计：

| 平台 | 移动端方案 |
|---|---|
| 网易云 | ①首选：手机号 + 密码/短信验证码登录（`/weapi/login/cellphone`、`/weapi/captcha/send`），全屏登录页，UI 按移动端习惯单列大输入框；②备选：应用内显示二维码 + 提示"用另一台设备扫"（体验差，仅兜底） |
| QQ 音乐 | 应用内 WebView 打开 `y.qq.com` 登录页，登录成功后从 WebView CookieManager 读取登录 Cookie，走现有 `notifyLoginSuccess(platform, cookie)` 管道——后端逻辑零改动，只换"取 Cookie 的载体" |
| 手动 Cookie | 保留粘贴框，移动端作为兜底入口收进"高级"折叠区 |

配套改造：
- 凭据存储：从本机配置文件改为 `EncryptedSharedPreferences`（Android Keystore 加密），Capacitor 用 `capacitor-secure-storage-plugin`。
- UI：设置页"账号"分区改为账号卡片（头像/昵称/VIP 状态/退出按钮），登录动作跳全屏登录页，不再用桌面式弹层。
- 复用点：`qrlogin.ts` 的适配器结构（`QrAdapter` + 轮询状态机）保留，网易云短信登录在旁边加一个 `SmsAdapter` 即可。

## 6. musicdl Python 搜索引擎的移动端实现

**引擎现状**：`engine/vendor/musicdl` 是纯 Python 爬虫包（各源 = HTTP 请求 + 参数加密 + HTML/JSON 解析，依赖 requests/lxml/pycryptodome 等），`bridge.py` 以 stdio NDJSON 协议与 Electron 通信，SongInfo 用 token 缓存在内存。

**推荐方案：Chaquopy（在 Android 应用内嵌 CPython）**——引擎算法零迁移，只换传输层：
1. **集成**：app 级 `build.gradle` 引入 Chaquopy 插件，`pip` 安装 `requirements-bundle.txt` 中的依赖（requests、lxml、pycryptodome、beautifulsoup4 等均有 Android wheel；lxml/pycryptodome 为 C 扩展，Chaquopy 官方源已提供预编译包）。
2. **入口改造**：`bridge.py` 拆成两层——`engine_core.py`（搜索/取址/下载函数，纯逻辑）保留原样；stdio 循环层由 Kotlin 侧直接 `import engine_core` 调用替代，请求/响应仍走现有 JSON 帧结构（帧协议、错误码、SongInfo token 机制全部不动）。
3. **Kotlin 侧**：`EngineService` 单例封装，调用跑在协程 Dispatchers.IO，超时沿用 45s；并发下载线程池照搬 bridge 的 ThreadPoolExecutor 语义。
4. **代价与对策**：APK 体积 +30~50MB（Python 运行时+依赖）；首次冷启动慢 1~3s，做法：App 启动时后台预热引擎（与现在"启动不阻塞、首用时暴露"的策略一致）。
5. **"搜索引擎算法迁移"的实质**：musicdl 各源模块是纯 Python，Chaquopy 下原封不动运行；真正要迁移的只有 stdio→JNI 这一层传输代码，以及删除 Electron 专属逻辑（`app.getPath` 等改为 Android 路径注入）。

**备选：Kotlin 原生重写**——用 OkHttp 逐个移植约 15 个源模块。优点是无 Python 运行时（省体积省内存）；缺点是工作量大（每源 1~2 天）、上游 musicdl 更新无法同步、参数加密逻辑重写易错。**不推荐**，可作为后期对热门 2~3 个源的渐进替换。

**不推荐**：远程引擎（手机连 PC 引擎）——脱离单机可用性，违背迁移目的。

---

## 建议顺序

1. 先做 1、2、3（纯前端，可在桌面版直接改 + 缩窄窗口预览验证）；
2. 再做 4（依赖 2 的圆点组件）；
3. 第 6 点先做 Chaquopy PoC（单独空工程验证 musicdl 能在真机出 search 结果），这是最大技术风险项，尽早验证；
4. 第 5 点最后做（涉及原生插件与安全存储，依赖壳工程定型）。

---

## 实施进度（2026-10-27）

| 项 | 状态 | 产出 |
|---|---|---|
| 1 能力一览移除 | ✅ 完成 | DiscoverView.vue |
| 2 榜单圆点两列 | ✅ 完成 | 新增 ChartDotItem.vue；DiscoverView / ChartsView |
| 3 歌名显示修复 | ✅ 完成 | SongTable.vue ≤640px 行卡片断点 |
| 4 榜单页音源/榜单切换 | ✅ 完成 | ChartsView 音源 chips + 圆点列表 |
| Android 图标资源 | ✅ 完成 | scripts/make_android_icons.py → build/android/res/（自适应三层 + 各密度 + Play 512） |
| 壳工程 | ✅ 骨架完成 | `mobile/`（Capacitor 6 + Chaquopy 17.0.0，appId com.aurora.music，图标已落位）；app-debug.apk 23.6MB 构建成功，含 Python 3.13 + requests。真机安装被 vivo 安装确认弹窗拦截，待手动安装验证 |
| 6 引擎分层 | ✅ 完成 | engine/musicdl/bridge.py 拆出 engine_core.py 纯逻辑层（dispatch() 接口，事件经 set_emitter 注入）；桥自测 + 真实搜索 + 项目 selftest 16/17 全通过 |
| C1 API 桥接层 | ✅ 首版完成 | src/renderer/src/bridge/mobile.ts 实现同一 AuroraApi 接口：netease/qq/kuwo 直接进 WebView（CapacitorHttp 原生 fetch 绕 CORS），设置/歌单/收藏 localStorage 持久化，登录态 Cookie 生效；渲染层 main.ts 无 preload 时自动装桥。下载/本地库/引擎/登录占位（返回明确提示） |
| 5 移动端登录重设计 | ⏳ 渲染层完成 | 渲染层与主进程完成；原生端还差安全存储（C8）与 QQ WebView（C6） |

**壳工程要点**（mobile/ 子工程，独立于 Electron 主工程）：
- 构建命令：`cd mobile/android && JAVA_HOME=F:/android-env/jdk17 F:/android-env/gradle/gradle-8.11.1/bin/gradle assembleDebug`
- Gradle wrapper 已改用腾讯镜像（services.gradle.org 直连超时）
- Chaquopy 配置在 app/build.gradle 顶层 `chaquopy` 块（version 3.13 / buildPython python / pip requests）；Python 源码放 `app/src/main/python/`
- 真机 vivo V1831A：需开「USB 调试（安全设置）」+「USB 安装」或现场点确认弹窗
- 下一步：把 engine/vendor/musicdl + engine_core 打进 APK（Chaquopy pip install 本地源码包），Kotlin 侧 EngineService 调 dispatch()，替换 aurora_test 占位

---

## 迁移差距清单（2026-10-27 盘点）

### A. 已完成，可直接复用
| 功能 | 状态 |
|---|---|
| 发现页（去能力一览）/ 榜单圆点入口 / 榜单页音源·榜单切换 | ✅ Vue 层完成 |
| 歌曲列表移动端布局（≤640px 行卡片） | ✅ |
| 网易云手机号登录（验证码/密码）+ 账号卡片 | ✅ 渲染层与主进程完成；原生端还差安全存储 |
| Android 图标资源 + 壳工程骨架 + Python 引擎构建层 | ✅ |
| 搜索 / 播放页 / 队列 / 歌单 / 下载页 UI | ✅ Vue 可用（窄屏细节建议再过一遍） |

### B. 桌面专属 → 移动端替代或裁剪
| 桌面功能 | 移动端处置 |
|---|---|
| 自定义 TitleBar 窗口控制按钮 | 裁剪：系统状态栏接管，检测 UA/环境隐藏 |
| 48px 侧边栏 4 页导航 | 替代：底部标签栏（移动端惯例） |
| 托盘常驻 + 全局快捷键（媒体键） | 替代：通知栏媒体样式（MediaSession + 前台服务） |
| 桌面歌词（mini/full 独立窗口） | 后置：可选悬浮窗权限方案，首版裁剪 |
| 迷你播放器模式（窗口变形） | 裁剪：通知栏即系统级迷你播放器 |
| 关闭最小化到托盘 | 裁剪（设置项移动端隐藏） |
| Windows 自动更新 | 后置：应用商店或自更新渠道 |

### C. 主进程逻辑需重新承载（工作量主体，未开始）
| # | 功能 | 现状（Electron） | 移动端方案 |
|---|---|---|---|
| C1 | **API 桥接层**（一切的前提） | renderer 经 preload 调 window.api（~60 通道），逻辑在主进程 Node | 写 Capacitor 兼容层实现同一 AuroraApi 接口：providers/catalog/settings/playlists/library 的 TS 逻辑下沉到 WebView 侧 JS（fetch 可用）或 Capacitor 插件 |
| C2 | **媒体服务** | muse:// 自定义协议流式代理（音频 + 封面，带 Referer/Cookie 头与 CORS） | Capacitor 本地服务器 / WebviewLocalServer 路由替代 muse://，或直连 + 请求头处理；跨域脏数据影响频谱可视化，需保留代理 |
| C3 | **后台播放** | HTML5 Audio（桌面不受限） | 原生前台服务 + MediaSession 插件（或 ExoPlayer 替换 audio.ts）；否则切后台/锁屏即停 |
| C4 | **musicdl 引擎运行时** | 子进程 + stdio NDJSON（bridge.py） | engine_core.py 已就绪、Chaquopy 已内嵌；差：① musicdl 包打进 APK ② Kotlin EngineService 调 dispatch() ③ engineStatus/Restart/ChoosePython/RepairVendor 四个通道的移动端语义重定义 |
| C5 | **下载服务** | Node 流式写盘 + 断点续传（download.ts） | WebView JS 实现（fetch 流 + Filesystem 插件）或原生插件；目录选择换 SAF；进度事件沿用现有 download:progress 模型 |
| C6 | **登录原生件** | 应用内 BrowserWindow 打开官网登录 | QQ 音乐走应用内 WebView（CookieManager 抓 Cookie）；Cookie/settings 改 EncryptedSharedPreferences；粘贴 Cookie 流程不变 |
| C7 | **本地库扫描** | library.ts 扫目录 + 元数据解析 | MediaStore 查询或 SAF 目录扫描；导入目录语义对应「授权文件夹」 |
| C8 | **设置持久化** | settings.json 明文（含 Cookie） | SharedPreferences（普通项）+ EncryptedSharedPreferences（Cookie/登录态） |

### D. 建议实施顺序（壳集成阶段）
1. C1 API 桥接层 → 2. C2 媒体服务 → 3. C3 后台播放（做到这一步，App 就是「能听歌的 App」）
4. C4 引擎 Kotlin 承载 → 5. C5 下载 + C7 本地库 → 6. C6/C8 登录与安全存储 → 7. B 项导航改底栏

### 实施进度更新（2026-10-27 晚）
| 项 | 状态 | 说明 |
|---|---|---|
| C2 本地媒体代理 | ✅ | Kotlin NanoHTTPD 代理（127.0.0.1:47654+，补 Referer/UA、透传 Range、回包 CORS）；media.ts 注入式重写器把 muse:// 全量改写，桌面零影响；页面 scheme 改 http 避免混合内容 |
| C3 后台播放 | ✅ | PlaybackService 前台服务 + MediaSessionCompat 媒体样式通知（元数据/封面/三个按钮）；控制事件经插件→native-media.ts→player store；锁屏/切后台不断流 |
| C4 引擎承载 | ✅ | musicdl 包经 chaquopy sourceSets 直指 engine/ 目录；AuroraEnginePlugin（字符串进出 + 自建线程池）；EngineProvider 15 源接 register；垫片：termios/tty/fcntl（Android 无 termios）+ pywidevine 桩（pycryptodome 3.23 无 Android 轮子） |
| C5 下载 | ✅ | fetch 流过本地代理 → Filesystem 分块 append 落盘（Directory.Documents/Aurora/），并发=设置值、取消/重试/进度齐全 |
| C6 登录 | ✅（网易云） | 纯 TS weapi（WebCrypto AES-CBC + BigInt RSA + 自写 md5），真机接口实测 {"code":200,"data":true}；Cookie+账号落 settings；QQ WebView 抓 Cookie 仍待原生 Activity |
| C7 本地库 | ✅（下载件） | 下载完成入库（localStorage 记录 + /local 代理直读播放）；MediaStore 全盘扫描为后续 |
| C8 安全存储 | ✅ | EncryptedSharedPreferences（AuroraMedia.secureGet/Set）；localStorage 持久化剥离敏感字段，启动异步恢复 |
| 桌面回归修复 | ✅ | C1 引入的 Buffer/node:crypto 渲染层污染：桥改动态 import（代码分割）+ buffer-shim 垫片；桌面 bundle 226→237KB 且不含 Node 依赖 |
| 构建工程 | ✅ | cap sync 在本机受 Windows 文件锁不可靠 → 手工维护 capacitor.settings.gradle / capacitor.build.gradle / cordova 模块（模板解包 + cdvPluginPostBuildExtras 安全补丁）；资产用 cp 同步 |

**真机验证状态**：vivo 弹窗拦截 adb 安装（17:08 首装后均被拒），最新 APK 在 release/aurora-mobile-full.apk（35.9MB），手机文件管理器手动安装或开「USB 调试（安全设置）+ USB 安装」后 adb 装。

---

## 移动端适配专项（2026-10-27 晚 · 第二轮）

针对「竖屏布局优先 / Android 系统特性 / 登录·下载·播放三模块排障」的整修。

### 致命问题（会导致真机功能不可用）

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| M1 | **CSP 拦截本地代理**：真机上音频/封面/fetch 全部请求 127.0.0.1:47654 被内容安全策略拦截，播放与下载整体失效 | `renderer/index.html` 的 CSP 只放行 self/https:/muse:，未含本地代理地址 | CSP 三处（img/media/connect-src）追加 `http://127.0.0.1:*` |
| M2 | **明文流量被禁**：targetSdk 34 默认禁明文，http CDN 与 127.0.0.1 代理可能被拦 | Manifest 无 usesCleartextTraffic（capacitor.config 的 cleartext 只对页面加载生效） | Manifest 加 `android:usesCleartextTraffic="true"` |
| M3 | **返回键直接退出 App**：SPA 无 WebView 历史栈，按返回即 finish | 未装 @capacitor/app，无 backButton 监听 | MainActivity 注册 AppPlugin（@capacitor/app@6.0.3，手工维护 gradle include）；新增 `core/back-button.ts`：覆盖层→路由回退→2 秒双击退出 |
| M4 | **下载流式失效**：CapacitorHttp 接管 window.fetch 后响应全量缓冲，大 FLAC 撑爆内存、无实时进度、取消无效 | WebView fetch 通道不支持流式响应 | 新增原生下载：AuroraMediaPlugin.download()（HttpURLConnection 边下边写 + downloadProgress 事件），JS 侧 runDownloadTask 走原生主路径、fetch 流式仅留兜底；cancelDownload 同步断开原生连接 |

### 播放模块修复（PlaybackService / native-media / player store）

- **通知/锁屏进度恒 0 且不可拖**：PlaybackStateCompat 位置固定 0L、无 ACTION_SEEK_TO → JS 每秒 time 事件里 5s 节流推 positionMs，原生带 position+speed 建状态、onSeekTo 回传（MediaBus 扩展 positionMs 参数）
- **线控语义错乱**：onPlay/onPause 都映射 toggle → 拆分为 play/pause 明确意图，JS 按当前状态收敛成幂等动作
- **startForegroundService 崩溃隐患**：通知按钮 action 分支不调 startForeground → 统一先 startForeground 再转发（记住最近元数据重建通知）
- **封面竞态 + OOM 风险**：慢速封面下载完成后用旧曲目覆盖新通知；原图直接解码 → 世代号（AtomicLong）作废旧任务 + inSampleSize 下采样至 ~512px + 单次下载两段解码
- **僵尸通知**：onTaskRemoved 未处理 → 划掉任务即 stopForeground(REMOVE)+stopSelf

### 登录模块修复

- weapi 请求加 15s AbortSignal 超时（弱网下不再无限转圈）
- 凭据恢复竞态：loadSecrets 的 promise 在 installMobileBridgeIfNeeded 里 await，账号卡片首屏即有数据；恢复后无条件广播设置

### 原生层安全与体验

- **/local 任意文件读取漏洞**：MediaProxyServer 加路径白名单（公开 Documents + 应用私有目录，canonical 前缀校验）
- **本地文件支持 Range**：RandomAccessInputStream 实现 206/Content-Range，下载完的曲目可拖进度
- 代理非 2xx 分支关闭错误流并 disconnect；IllegalArgumentException 一并兜住
- 通知权限只请求一次（Android 14 反复弹窗会被记为持续拒绝）
- EnginePlugin：bootError @Volatile、call.resolve 不再绕 UI 线程（ getActivity() 可空 NPE 隐患）
- MainActivity 移除 Chaquopy 主线程自检探针（拖慢冷启动）

### UI / 壳适配（竖屏优先）

- Manifest：`screenOrientation="portrait"` 锁竖屏、`windowSoftInputMode="adjustResize"`、`allowBackup="false"`
- styles.xml：状态栏/导航栏改 #0A0A10 暗色（与 App 底色一致，消灭启动闪白）
- CSP + Manifest + 主题均为移动端专属改动，桌面端不受影响（CSP 追加项对桌面无害）

**验证**：typecheck ✅、单测 19/19 ✅、renderer 构建 ✅、gradle assembleDebug 见 release/aurora-mobile-*.apk。

---

## 真机排障第二轮（2026-10-27 深夜）：登录/下载不可用的根因与修复

真机反馈「不能登录、不能下载」，排查出两个独立根因 + 补齐 QQ 应用内登录。

| # | 问题 | 根因 | 修复 |
|---|---|---|---|
| R1 | **登录全挂（回归）** | 上一轮加的 `AbortSignal.timeout()` 是 Chrome 103+ API，Android 9 老 WebView 上 `TypeError`，weapi 请求发出前即抛（歌词 LRCLIB 同样中招） | 自实现 `timeoutSignal()`（AbortController + setTimeout），wapiPost/fetchLrclib 三处替换 |
| R2 | **下载必挂** | ① 公共 Documents 在 Android ≤10 需 WRITE_EXTERNAL_STORAGE 运行时权限（未声明）；② `Filesystem.getUri` 可能返回 content:// URI，原生 File() 无法直写 | 改为 JS 传相对路径 `rel`，Kotlin 解析到 `getExternalFilesDir(null)`（全版本免权限、路径确定）；resolve 回传绝对路径供本地库/代理播放使用 |
| R3 | **QQ 登录缺失（C6 收尾）** | 桌面"扫码登录"在手机上体验反转，应用内 WebView 登录此前未实现 | 新增 `WebLoginActivity`（WebView 打开 y.qq.com，CookieManager 按 qm_keyst+uin 判登录成功，与桌面 weblogin.ts 同判据）+ 插件 `webLogin` 方法（@ActivityCallback 回传 Cookie）；渲染层 `openLoginWindow('qq')` 接通：抓到 Cookie 即落库、生效、广播；取消/失败有明确 toast |

**登录方式矩阵（移动端现状）**：
- 网易云：手机号 + 短信验证码 / 密码（`cellphoneLogin`，weapi 纯 TS 实现）
- QQ 音乐：应用内 WebView 打开官网登录（`openLoginWindow('qq')`），原生抓 Cookie 落库；粘贴 Cookie 折叠为"高级"兜底
- 凭据均入 EncryptedSharedPreferences（C8），localStorage 不落明文

**验证**：typecheck ✅、单测 19/19 ✅、APK 重新打包。
